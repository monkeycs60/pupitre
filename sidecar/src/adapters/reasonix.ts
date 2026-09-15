import { createInterface } from "node:readline";
import type { AppEvent } from "../events";
import { killGroup, spawnGroup } from "../process-group";
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
      const allow = opts.permissionMode !== "plan" && opts.permissionMode !== "dontAsk";
      const options: Array<Record<string, unknown>> = Array.isArray(message.params?.options)
        ? message.params.options
        : [];
      const option = options.find((item) => item?.kind === (allow ? "allow_once" : "reject_once"));
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

      const resumed = opts.cliSessionId
        ? await request("session/resume", { sessionId: opts.cliSessionId, cwd: opts.cwd, mcpServers: [] })
        : null;
      if (opts.cliSessionId && resumed && !resumed.error) {
        sessionId = opts.cliSessionId;
      } else {
        const created = await request("session/new", { cwd: opts.cwd, mcpServers: [] });
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
      if (opts.permissionMode === "plan") {
        await request("session/set_mode", { sessionId: activeSession, modeId: "plan" });
      }
      if (finished) return;

      prompting = true;
      const response = request("session/prompt", {
        sessionId: activeSession,
        prompt: textPrompt(withImages(opts.prompt, opts.images)),
      });
      opts.registerSteer?.(async (input) => {
        const steered = await request("_reasonix.io/session/steer", {
          sessionId: activeSession,
          prompt: textPrompt(withImages(input.prompt, input.images)),
        });
        return steered.result?.disposition === "steer_accepted";
      });

      const outcome = await response;
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
