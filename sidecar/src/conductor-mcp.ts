#!/usr/bin/env bun
/**
 * Bridge MCP « conductor » — lancé PAR le CLI orchestrateur (claude ou codex),
 * en stdio, un process par tour :
 *
 *     bun sidecar/src/conductor-mcp.ts
 *
 * Il n'a AUCUN état local : chaque outil est un appel HTTP au sidecar sur
 * 127.0.0.1. Configuration par environnement (injectée par le sidecar au
 * moment du spawn du CLI, cf. src/conductor.ts) :
 *
 * - `PUPITRE_PORT`            : port HTTP du sidecar (défaut 4820) ;
 * - `PUPITRE_CONVERSATION_ID` : conversation orchestratrice = parent des
 *   sous-tâches créées. Chaque outil accepte aussi un `conversation_id`
 *   explicite qui prime, pour les hôtes qui ne savent pas transmettre
 *   d'environnement par tour.
 *
 * Réglages de test : `PUPITRE_CONDUCTOR_POLL_MS`, `PUPITRE_CONDUCTOR_TIMEOUT_MS`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** delegate_parallel : au-delà, l'orchestrateur doit découper lui-même. */
const MAX_PARALLEL_TASKS = 4;

function numberFromEnv(key: string, fallback: number): number {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function baseUrl(): string {
  return `http://127.0.0.1:${numberFromEnv("PUPITRE_PORT", 4820)}`;
}

function pollMs(): number {
  return numberFromEnv("PUPITRE_CONDUCTOR_POLL_MS", DEFAULT_POLL_MS);
}

function timeoutMs(): number {
  return numberFromEnv("PUPITRE_CONDUCTOR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function conversationId(explicit?: string): string {
  const id = explicit ?? process.env.PUPITRE_CONVERSATION_ID;
  if (!id) {
    throw new Error(
      "conversation orchestratrice inconnue : ni PUPITRE_CONVERSATION_ID ni "
      + "le paramètre conversation_id n'est renseigné",
    );
  }
  return id;
}

// --- Types côté sidecar ------------------------------------------------------

interface SubtaskResultBody {
  status: "running" | "done" | "error";
  resultText: string;
  /** Message de l'échec terminal (null si la sous-tâche n'a pas échoué). */
  error: string | null;
  subtask: {
    id: string;
    provider: string;
    model: string;
    effort: string | null;
    speed: string | null;
    label: string | null;
  };
}

interface QuotaWindowBody {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  windowDurationMins: number | null;
}

interface QuotaSnapshotBody {
  claude: { windows: QuotaWindowBody[]; updatedAt: string } | null;
  codex: { windows: QuotaWindowBody[]; updatedAt: string } | null;
}

class SubtaskLimitReached extends Error {}

// --- Appels au sidecar -------------------------------------------------------

async function createSubtask(task: DelegateInput, parentId: string): Promise<string> {
  const response = await fetch(`${baseUrl()}/api/subtasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: parentId,
      provider: task.provider,
      model: task.model,
      effort: task.effort ?? null,
      speed: task.speed ?? null,
      prompt: task.prompt,
      label: task.label ?? null,
    }),
  });
  if (response.status === 429) {
    throw new SubtaskLimitReached(await errorMessage(response));
  }
  if (response.status !== 201) {
    throw new Error(`création de la sous-tâche refusée : ${await errorMessage(response)}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return `${response.status} ${body.error ?? ""}`.trim();
  } catch {
    return String(response.status);
  }
}

/** Poll jusqu'à `done`/`error`, ou jusqu'au timeout. */
async function awaitSubtask(id: string): Promise<SubtaskResultBody> {
  const deadline = Date.now() + timeoutMs();
  for (;;) {
    const response = await fetch(`${baseUrl()}/api/subtasks/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`sous-tâche ${id} illisible : ${await errorMessage(response)}`);
    const body = (await response.json()) as SubtaskResultBody;
    if (body.status !== "running") return body;
    if (Date.now() >= deadline) {
      // On n'annule pas : la sous-tâche continue et reste visible dans l'UI.
      throw new Error(
        `sous-tâche ${id} toujours en cours après ${Math.round(timeoutMs() / 60_000)} min`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs()));
  }
}

/**
 * Crée la sous-tâche en encaissant le 429 : la limite de concurrence du sidecar
 * est PAR conversation parente, donc réessayer suffit — un slot se libère dès
 * qu'une sœur se termine. C'est le séquençage demandé par D1 côté appelant.
 */
async function createWhenSlotFree(task: DelegateInput, parentId: string): Promise<string> {
  const deadline = Date.now() + timeoutMs();
  for (;;) {
    try {
      return await createSubtask(task, parentId);
    } catch (error) {
      if (!(error instanceof SubtaskLimitReached)) throw error;
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollMs()));
    }
  }
}

// --- Rendu -------------------------------------------------------------------

function describeSubtask(result: SubtaskResultBody): string {
  const { subtask } = result;
  const badge = [
    subtask.provider,
    subtask.model,
    subtask.effort ? `effort ${subtask.effort}` : null,
    subtask.speed === "fast" ? "fast" : null,
    subtask.label,
  ].filter(Boolean).join(" · ");
  if (result.status === "done") {
    return `[${badge}] terminé\n\n${result.resultText || "(aucun texte final)"}`;
  }
  // Un sub-agent en échec n'écrit souvent aucun `text-final` : sans la cause,
  // l'orchestrateur ne peut ni corriger ni décider de réessayer.
  const cause = result.error ? ` : ${result.error}` : "";
  return `[${badge}] ÉCHEC${cause}\n\n${result.resultText || "(aucun texte final)"}`;
}

function describeQuotas(snapshot: QuotaSnapshotBody): string {
  const lines: string[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const state = snapshot[provider];
    if (!state) {
      lines.push(`${provider} : aucun relevé (aucun tour depuis le démarrage)`);
      continue;
    }
    lines.push(`${provider} (relevé ${state.updatedAt}) :`);
    for (const window of state.windows) {
      const used = window.usedPercent === null
        ? "usage inconnu"
        : `${Math.round(window.usedPercent)} % utilisé`;
      const duration = window.windowDurationMins === null
        ? null
        : `fenêtre ${formatMinutes(window.windowDurationMins)}`;
      const reset = window.resetsAt === null ? null : `reset ${window.resetsAt}`;
      lines.push(`  - ${window.label} : ${[used, duration, reset].filter(Boolean).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} j`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], ...(isError ? { isError } : {}) };
}

// --- Schémas d'outils --------------------------------------------------------

const MODELS_DOC =
  "Modèles disponibles — provider 'claude' : fable-5 (le plus capable), opus, "
  + "sonnet, haiku (le plus rapide/économe) ; provider 'codex' : gpt-5.6-sol "
  + "(raisonnement profond), gpt-5.6-luna (rapide et économe).";
const EFFORT_DOC =
  "effort : low | medium | high | xhigh (claude accepte aussi 'max'). "
  + "Plus l'effort est élevé, plus le sub-agent réfléchit — et consomme.";
const SPEED_DOC =
  "speed : 'fast' n'existe QUE pour codex (service tier prioritaire) ; "
  + "l'omettre ou 'standard' sinon. Passer speed='fast' à claude est une erreur.";
const RECO_DOC =
  "Recommandation : pour une sous-tâche d'EXÉCUTION (lire des fichiers, "
  + "appliquer un patch mécanique, lancer des tests, rédiger un résumé), prends "
  + "codex / gpt-5.6-luna avec effort low ou medium et speed 'fast' — c'est le "
  + "meilleur rapport vitesse/coût. Garde les gros modèles pour la conception, "
  + "l'analyse ambiguë et la revue. Si tu hésites entre les deux abonnements, "
  + "appelle check_quotas AVANT de choisir et route vers celui qui a le plus de marge.";

const taskShape = {
  provider: z.enum(["claude", "codex"]).describe("Abonnement à utiliser pour ce sub-agent."),
  model: z.string().describe(MODELS_DOC),
  effort: z.string().optional().describe(EFFORT_DOC),
  speed: z.enum(["standard", "fast"]).optional().describe(SPEED_DOC),
  prompt: z.string().describe(
    "Consigne COMPLÈTE et autonome pour le sub-agent : il ne voit pas ta "
    + "conversation, seulement ce texte. Il tourne dans le working directory du "
    + "projet (avec ses CLAUDE.md / AGENTS.md / skills) et ne peut pas déléguer "
    + "à son tour. Dis-lui explicitement ce que tu attends en retour.",
  ),
  label: z.string().optional().describe(
    "Étiquette courte affichée sur la carte du sub-agent dans l'UI (ex. « recon », « tests »).",
  ),
} as const;

const conversationIdShape = {
  conversation_id: z.string().optional().describe(
    "Conversation orchestratrice à laquelle rattacher la sous-tâche. À omettre "
    + "en temps normal : le pont la connaît déjà par son environnement.",
  ),
} as const;

interface DelegateInput {
  provider: "claude" | "codex";
  model: string;
  effort?: string;
  speed?: "standard" | "fast";
  prompt: string;
  label?: string;
}

// --- Serveur -----------------------------------------------------------------

export function createConductorServer(): McpServer {
  const server = new McpServer(
    { name: "conductor", version: "0.1.0" },
    {
      instructions:
        "Pupitre Conductor : délègue du travail à un autre modèle (l'autre "
        + "abonnement compris) et récupère son résultat. " + RECO_DOC,
    },
  );

  server.registerTool("delegate", {
    title: "Déléguer une sous-tâche",
    description:
      "Confie UNE sous-tâche à un sub-agent (un CLI complet, avec ses outils, "
      + "dans le working directory du projet), attend qu'il termine et te rend "
      + "son résultat texte. Bloquant : n'appelle cet outil que si tu veux "
      + "vraiment attendre. Pour plusieurs sous-tâches indépendantes, préfère "
      + "delegate_parallel. Le sub-agent est un ONE-SHOT sans mémoire entre "
      + "appels et ne peut pas déléguer lui-même.\n"
      + `${MODELS_DOC}\n${EFFORT_DOC}\n${SPEED_DOC}\n${RECO_DOC}`,
    inputSchema: { ...taskShape, ...conversationIdShape },
  }, async (args) => {
    try {
      const parentId = conversationId(args.conversation_id);
      const id = await createWhenSlotFree(args as DelegateInput, parentId);
      const result = await awaitSubtask(id);
      return text(describeSubtask(result), result.status === "error");
    } catch (error) {
      return text(`Délégation impossible : ${String(error)}`, true);
    }
  });

  server.registerTool("delegate_parallel", {
    title: "Déléguer plusieurs sous-tâches en parallèle",
    description:
      "Lance jusqu'à 4 sous-tâches INDÉPENDANTES en même temps, puis attend "
      + "qu'elles soient toutes terminées et rend leurs résultats dans l'ordre "
      + "des tâches fournies. Les tâches peuvent viser des providers et des "
      + "modèles différents (fan-out cross-abonnement). N'y mets que des "
      + "travaux qui ne dépendent pas les uns des autres et qui ne touchent pas "
      + "aux mêmes fichiers : ils tournent dans le MÊME working directory. Une "
      + "tâche en échec n'annule pas les autres.\n"
      + `${MODELS_DOC}\n${EFFORT_DOC}\n${SPEED_DOC}\n${RECO_DOC}`,
    inputSchema: {
      tasks: z.array(z.object(taskShape)).min(1).max(MAX_PARALLEL_TASKS)
        .describe(`Entre 1 et ${MAX_PARALLEL_TASKS} sous-tâches indépendantes.`),
      ...conversationIdShape,
    },
  }, async (args) => {
    try {
      const parentId = conversationId(args.conversation_id);
      const tasks = args.tasks as DelegateInput[];
      // Création séquentielle mais NON bloquante : chaque sous-tâche démarre
      // dès sa création et tourne pendant qu'on crée les suivantes. Le 429 de
      // l'API (limite de concurrence par conversation) est encaissé par
      // createWhenSlotFree, qui réessaie dès qu'un slot se libère.
      const waits: Promise<SubtaskResultBody | Error>[] = [];
      for (const task of tasks) {
        const id = await createWhenSlotFree(task, parentId);
        waits.push(awaitSubtask(id).catch((error: unknown) => toError(error)));
      }
      const results = await Promise.all(waits);
      const rendered = results.map((result, index) => {
        const header = `--- tâche ${index + 1}/${results.length}`
          + `${tasks[index]?.label ? ` (${tasks[index]!.label})` : ""} ---`;
        return result instanceof Error
          ? `${header}\nÉCHEC : ${result.message}`
          : `${header}\n${describeSubtask(result)}`;
      });
      const failed = results.some(
        (result) => result instanceof Error || result.status === "error",
      );
      return text(rendered.join("\n\n"), failed);
    } catch (error) {
      return text(`Délégation parallèle impossible : ${String(error)}`, true);
    }
  });

  server.registerTool("check_quotas", {
    title: "État des quotas",
    description:
      "Rend l'état de consommation des deux abonnements (fenêtres de quota, "
      + "pourcentage utilisé, heure de reset), tel que rapporté nativement par "
      + "les CLIs. Appelle-le AVANT de choisir un provider quand tu hésites, "
      + "ou quand tu veux répartir une grosse charge sur l'abonnement le moins "
      + "entamé. Sans coût ni consommation.",
    inputSchema: {},
  }, async () => {
    try {
      const response = await fetch(`${baseUrl()}/api/quotas`);
      if (!response.ok) throw new Error(await errorMessage(response));
      return text(describeQuotas((await response.json()) as QuotaSnapshotBody));
    } catch (error) {
      return text(`Quotas illisibles : ${String(error)}`, true);
    }
  });

  return server;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// Exécuté directement (`bun src/conductor-mcp.ts`) : on branche stdio.
// Importé par les tests : rien ne démarre.
if (import.meta.main) {
  const server = createConductorServer();
  await server.connect(new StdioServerTransport());
}
