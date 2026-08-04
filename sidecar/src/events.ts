// Schéma unifié : la SEULE surface que le frontend et le stockage connaissent.
export type AppEvent =
  | { type: "session"; provider: Provider; cliSessionId: string; model: string }
  | { type: "user-message"; text: string; images: string[] } // images = chemins media relatifs
  | { type: "text-delta"; text: string }
  | { type: "text-final"; text: string }
  | { type: "tool-start"; toolId: string; toolName: string; input: unknown }
  | { type: "tool-end"; toolId: string; output: string; images: string[] }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "status"; state: "running" | "done" | "error"; error?: string };

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
