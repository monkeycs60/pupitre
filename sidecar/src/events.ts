// Schéma unifié : la SEULE surface que le frontend et le stockage connaissent.
export type AppEvent =
  | { type: "session"; provider: Provider; cliSessionId: string; model: string }
  | { type: "user-message"; text: string; images: string[] } // images = chemins media relatifs
  | { type: "text-delta"; text: string }
  | { type: "text-final"; text: string }
  | { type: "tool-start"; toolId: string; toolName: string; input: unknown }
  | { type: "tool-end"; toolId: string; output: string; images: string[] }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      /** Snapshot du contexte courant, distinct de l'usage facturé cumulé. */
      contextTokens?: number;
      contextWindowTokens?: number;
    }
  // Introspection de quota native du provider (payload brut, interprété par le
  // QuotaTracker — cf. M2 phase C).
  | { type: "rate-limit"; provider: Provider; payload: unknown }
  // Référence à une sous-tâche déléguée, appendée à la conversation PARENTE au
  // lancement : l'UI s'en sert pour afficher la carte de sub-agent et pour
  // s'abonner au flux de la subtask (/ws?conversation=<subtaskId>).
  | { type: "subtask-ref"; subtaskId: string; provider: Provider; model: string; label?: string }
  // Snapshot du débrief dans l'event append-only : le replay UI ne dépend pas
  // d'une seconde requête et la table `debriefs` reste la source versionnée.
  | {
      type: "debrief-ref";
      debriefId: string;
      eventIdFrom: number;
      eventIdTo: number;
      contentMd: string;
      createdAt: string;
    }
  | { type: "status"; state: "running" | "done" | "error"; error?: string };

// Un événement persisté porte l'id (rowid) de sa ligne : c'est la clé de dédup
// entre le replay HTTP et le flux WS côté UI.
export type StoredEvent = AppEvent & { id: number };

export type Provider = "claude" | "codex";

export function parseJsonlLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
