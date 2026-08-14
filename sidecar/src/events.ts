// Schéma unifié : la SEULE surface que le frontend et le stockage connaissent.
export type AppEvent =
  | { type: "session"; provider: Provider; cliSessionId: string; model: string }
  | {
      type: "user-message";
      text: string;
      images: string[];
      /** Fichiers joints non-image (et images pour les anciens clients). */
      attachments?: MediaAttachment[];
      /** Précision injectée dans le tour actif, pas début d'un nouveau tour. */
      steering?: boolean;
    }
  | { type: "text-delta"; text: string }
  | { type: "text-final"; text: string }
  | { type: "tool-start"; toolId: string; toolName: string; input: unknown }
  | { type: "tool-end"; toolId: string; output: string; images: string[] }
  | {
      type: "turn-timing";
      phase: "started" | "first-response" | "completed";
      startedAt: string;
      firstResponseAt?: string;
      completedAt?: string;
    }
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
  | {
      type: "session-summary-ref";
      summaryId: string;
      eventIdFrom: number;
      eventIdTo: number;
      contentMd: string;
      createdAt: string;
    }
  | {
      type: "html-document-ref";
      documentId: string;
      title: string;
      summary?: string;
      kind?: "html";
      mimeType?: "text/html";
      originalName?: string;
      sizeBytes: number;
      createdAt: string;
      expiresAt: string | null;
    }
  | {
      type: "document-ref";
      documentId: string;
      title: string;
      summary?: string;
      kind: "html" | "pdf";
      mimeType: string;
      originalName: string;
      sizeBytes: number;
      createdAt: string;
      expiresAt: string | null;
    }
  | {
      type: "test-inventory-ref";
      inventoryId: string;
      scopes: TestScopeEvent[];
      createdAt: string;
    }
  | {
      type: "test-scope-started";
      inventoryId: string;
      scopeId: string;
      subtaskId: string;
      startedAt: string;
    }
  | {
      type: "test-scope-result";
      inventoryId: string;
      scopeId: string;
      status: "passed" | "failed";
      evidenceMd: string;
      images: string[];
      guardianFlagIdsAcked: string[];
      completedAt: string;
      error?: string;
    }
  /** Titre et résumé régénérés après un tour : la sidebar se met à jour. */
  | { type: "conversation-digest"; title: string; summary: string }
  | { type: "status"; state: "running" | "done" | "error"; error?: string };

export interface TestScopeEvent {
  id: string;
  title: string;
  description: string;
  methods: Array<{
    kind: "unit" | "browser" | "manual";
    label: string;
    instructions: string;
  }>;
  guardianFlagIds: string[];
  status: "pending" | "running" | "passed" | "failed";
  subtaskId: string | null;
  evidenceMd: string | null;
  images: string[];
  error: string | null;
}

// Un événement persisté porte l'id (rowid) de sa ligne : c'est la clé de dédup
// entre le replay HTTP et le flux WS côté UI.
export type StoredEvent = AppEvent & { id: number };

export type Provider = "claude" | "codex";

export interface MediaAttachment {
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
}

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
