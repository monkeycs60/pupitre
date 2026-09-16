import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AppEvent } from "../events";
import { killGroup, spawnGroup } from "../process-group";
import { acpPupitreMcpServer } from "../pupitre";
import { parseReasonixAcpMessage } from "./reasonix-acp-parser";
import type { EmitFn, TurnOptions } from "./types";

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
}

type StatusEvent = Extract<AppEvent, { type: "status" }>;

function withImages(prompt: string, images: string[]): string {
  return images.length ? `${prompt}\n\n[Images jointes: ${images.join(", ")}]` : prompt;
}

function textPrompt(text: string) {
  return [{ type: "text", text }];
}

// Hors YOLO, ReasonX reste en `ask` : en `auto`, il écrit hors du projet sans
// passer par reasonixPermissionAllowed.
const TOOL_APPROVAL_BY_PERMISSION_MODE: Record<string, string> = {
  bypassPermissions: "yolo",
};

function requestedPaths(toolCall: unknown): string[] {
  const call = toolCall as { rawInput?: Record<string, unknown>; locations?: Array<{ path?: unknown }> } | undefined;
  const input = call?.rawInput ?? {};
  const writeDirs = Array.isArray(input.additional_write_dirs) ? input.additional_write_dirs : [];
  const locations = Array.isArray(call?.locations) ? call.locations.map((location) => location?.path) : [];
  return [input.path, ...writeDirs, ...locations]
    .filter((path): path is string => typeof path === "string" && isAbsolute(path));
}

function isWithin(path: string, roots: string[]): boolean {
  const target = resolve(path);
  return roots.some((root) => {
    const rest = relative(resolve(root), target);
    return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
  });
}

/**
 * Choisit l'option ReasonX. Une autorisation vaut pour la session, afin que la
 * même racine ne soit plus redemandée ; `reasonix_write_project` écrirait dans
 * le reasonix.toml du dépôt.
 */
export function reasonixPermissionOption(
  options: Array<Record<string, unknown>>,
  allow: boolean,
): Record<string, unknown> | undefined {
  if (!allow) return options.find((option) => option?.kind === "reject_once");
  return options.find((option) => option?.kind === "allow_always" && option.optionId !== "reasonix_write_project")
    ?? options.find((option) => option?.kind === "allow_once");
}

const GIT_COMMIT_HINT = "[Pupitre] Ta commande git vient d'être bloquée par la garde read-evidence de ReasonX. "
  + "Committe avec la capacité MCP `mcp-tool:pupitre/git_commit` (paths, message, push) au lieu du shell.";

/** Vrai quand la garde read-evidence de ReasonX refuse une commande shell qui appelle git. */
export function isEvidenceBlockedGit(input: unknown, output: unknown): boolean {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string"
    && /\bgit\b/.test(command)
    && typeof output === "string"
    && output.includes("[evidence required]");
}

/** Annonce au modèle le périmètre que reasonixPermissionAllowed fera respecter. */
export function reasonixPromptWithPerimeter(
  prompt: string,
  opts: Pick<TurnOptions, "permissionMode" | "filesystemScope" | "cwd" | "extraWorkspaceRoots">,
): string {
  if (opts.permissionMode === "bypassPermissions" || opts.filesystemScope === "full-system") return prompt;
  if (opts.permissionMode === "plan") return prompt;
  const roots = [...new Set([opts.cwd, ...(opts.extraWorkspaceRoots ?? [])])];
  const commands = opts.permissionMode === "acceptEdits" ? " Les commandes shell seront refusées." : "";
  return `[Pupitre] Écritures autorisées uniquement dans : ${roots.join(", ")}. `
    + `Toute écriture ailleurs sera refusée : ne la tente pas.${commands}\n\n${prompt}`;
}

/** Réponse de Pupitre à une demande d'autorisation de ReasonX, selon le rang d'autonomie. */
export function reasonixPermissionAllowed(
  opts: Pick<TurnOptions, "permissionMode" | "filesystemScope" | "cwd" | "extraWorkspaceRoots">,
  toolCall: unknown,
): boolean {
  if (opts.permissionMode === "plan") return false;
  if (opts.permissionMode === "bypassPermissions" || opts.filesystemScope === "full-system") return true;
  if (opts.permissionMode === "acceptEdits" && (toolCall as { kind?: unknown } | undefined)?.kind === "execute") {
    return false;
  }
  const roots = [opts.cwd, ...(opts.extraWorkspaceRoots ?? [])];
  return requestedPaths(toolCall).every((path) => isWithin(path, roots));
}

/**
 * Un tour = un process `reasonix acp`. La session est reprise par
 * `session/resume`, qui ne rejoue pas l'historique, et les précisions passent
 * par l'extension `_reasonix.io/session/steer`.
 */
export function runReasonixTurn(opts: TurnOptions, emit: EmitFn): Promise<void> {
  return new Promise((resolve) => {
    emit({ type: "status", state: "running" });
    if (opts.signal?.aborted) {
      emit({ type: "status", state: "error", error: "annulé" });
      resolve();
      return;
    }

    const bin = process.env.PUPITRE_REASONIX_BIN ?? "reasonix";
    const child = spawnGroup(bin, ["acp", "-model", opts.model], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map<number, (message: RpcMessage) => void>();
    let nextId = 0;
    let finished = false;
    let prompting = false;
    let sessionId: string | null = null;
    let lastPhase = "";
    const toolInputs = new Map<string, unknown>();
    let commitHintSent = false;
    let usage: AppEvent | null = null;
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const write = (message: Record<string, unknown>) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    };
    const request = (method: string, params: Record<string, unknown>) =>
      new Promise<RpcMessage>((settle) => {
        if (finished) {
          settle({ error: { message: "tour terminé" } });
          return;
        }
        const id = ++nextId;
        pending.set(id, settle);
        write({ id, method, params });
      });

    const finish = (status: StatusEvent) => {
      if (finished) return;
      finished = true;
      opts.signal?.removeEventListener("abort", abort);
      for (const settle of pending.values()) settle({ error: { message: "tour terminé" } });
      pending.clear();
      if (usage) emit(usage);
      emit(status);
      child.stdin.end();
      if (killGroup(child, "SIGTERM")) {
        killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 3_000);
        killTimer.unref();
      }
    };

    const abort = () => {
      if (sessionId) write({ method: "session/cancel", params: { sessionId } });
      finish({ type: "status", state: "error", error: "annulé" });
    };
    opts.signal?.addEventListener("abort", abort, { once: true });

    const answerPermission = (message: RpcMessage) => {
      if (message.method !== "session/request_permission") {
        write({ id: message.id, error: { code: -32601, message: `${message.method} non pris en charge` } });
        return;
      }
      const allow = reasonixPermissionAllowed(opts, message.params?.toolCall);
      const options: Array<Record<string, unknown>> = Array.isArray(message.params?.options)
        ? message.params.options
        : [];
      const option = reasonixPermissionOption(options, allow);
      write({
        id: message.id,
        result: {
          outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" },
        },
      });
    };

    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method === undefined && typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        return;
      }
      if (message.method !== undefined && message.id !== undefined) {
        answerPermission(message);
        return;
      }
      if (finished || !prompting) return;
      for (const event of parseReasonixAcpMessage(message)) {
        if (event.type === "usage") {
          usage = event;
        } else if (event.type === "turn-phase") {
          // ReasonX garde `starting` pendant toute la première réflexion, et `waiting_*`
          // alors que answerPermission a déjà répondu.
          if (event.phase === "starting" || event.phase.startsWith("waiting_") || event.phase === lastPhase) continue;
          lastPhase = event.phase;
          emit(event);
        } else {
          if (event.type === "tool-start") toolInputs.set(event.toolId, event.input);
          if (
            event.type === "tool-end" && opts.pupitre && sessionId && !commitHintSent
            && isEvidenceBlockedGit(toolInputs.get(event.toolId), event.output)
          ) {
            commitHintSent = true;
            void request("_reasonix.io/session/steer", { sessionId, prompt: textPrompt(GIT_COMMIT_HINT) });
          }
          emit(event);
        }
      }
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-2_000);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish({ type: "status", state: "error", error: String(error) }));
    child.on("close", (code) => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      finish({ type: "status", state: "error", error: stderr.trim() || `reasonix acp arrêté (exit ${code})` });
      resolve();
    });

    const run = async () => {
      const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      if (init.error) throw new Error(init.error.message ?? "initialisation OpenCode Go impossible");

      const mcpServers = opts.pupitre ? [acpPupitreMcpServer(opts.pupitre)] : [];
      const resumed = opts.cliSessionId
        ? await request("session/resume", { sessionId: opts.cliSessionId, cwd: opts.cwd, mcpServers })
        : null;
      if (opts.cliSessionId && resumed && !resumed.error) {
        sessionId = opts.cliSessionId;
      } else {
        const created = await request("session/new", { cwd: opts.cwd, mcpServers });
        if (typeof created.result?.sessionId !== "string") {
          throw new Error(created.error?.message ?? "session OpenCode Go impossible à ouvrir");
        }
        sessionId = created.result.sessionId;
      }
      if (finished || !sessionId) return;
      const activeSession = sessionId;
      emit({ type: "session", provider: "reasonix", cliSessionId: activeSession, model: opts.model });

      if (opts.effort) {
        await request("session/set_config_option", { sessionId: activeSession, configId: "effort", value: opts.effort });
      }
      const toolApproval = TOOL_APPROVAL_BY_PERMISSION_MODE[opts.permissionMode];
      if (toolApproval) {
        await request("session/set_config_option", { sessionId: activeSession, configId: "tool_approval", value: toolApproval });
      }
      if (opts.permissionMode === "plan") {
        await request("session/set_mode", { sessionId: activeSession, modeId: "plan" });
      }
      if (finished) return;

      prompting = true;
      const response = request("session/prompt", {
        sessionId: activeSession,
        prompt: textPrompt(reasonixPromptWithPerimeter(withImages(opts.prompt, opts.images), opts)),
      });
      const queuedTexts = new Map<string, string>();
      opts.registerSteer?.(async (input) => {
        const text = withImages(input.prompt, input.images);
        const steered = await request("_reasonix.io/session/steer", {
          sessionId: activeSession,
          prompt: textPrompt(text),
        });
        const disposition = steered.result?.disposition;
        if (disposition === "steer_accepted") return true;
        if (disposition !== "queued_followup") return false;
        if (typeof steered.result?.itemId === "string") queuedTexts.set(steered.result.itemId, text);
        return "queued";
      });

      let outcome = await response;
      // Un élément resté en file au-delà du prompt n'est plus traité : au redémarrage,
      // ReasonX met la file en pause et injecte un avertissement dans la réponse suivante.
      while (!finished && outcome.result?.stopReason === "end_turn") {
        const inbox = await request("_reasonix.io/session/inbox/list", { sessionId: activeSession });
        const items: Array<{ id?: unknown; preview?: unknown }> = Array.isArray(inbox.result?.items)
          ? inbox.result.items
          : [];
        const leftovers: string[] = [];
        for (const item of items) {
          if (typeof item.id !== "string") continue;
          await request("_reasonix.io/session/inbox/delete", { sessionId: activeSession, itemId: item.id });
          const text = queuedTexts.get(item.id) ?? (typeof item.preview === "string" ? item.preview : "");
          if (text) leftovers.push(text);
        }
        if (leftovers.length === 0 || finished) break;
        outcome = await request("session/prompt", {
          sessionId: activeSession,
          prompt: textPrompt(leftovers.join("\n\n")),
        });
      }
      if (finished) return;
      if (outcome.error) {
        finish({ type: "status", state: "error", error: outcome.error.message ?? "échec OpenCode Go" });
      } else if (outcome.result?.stopReason === "cancelled") {
        finish({ type: "status", state: "error", error: "annulé" });
      } else if (outcome.result?.stopReason === "refusal") {
        finish({ type: "status", state: "error", error: "OpenCode Go a refusé la demande" });
      } else {
        finish({ type: "status", state: "done" });
      }
    };
    run().catch((error: unknown) => {
      finish({ type: "status", state: "error", error: error instanceof Error ? error.message : String(error) });
    });
  });
}
