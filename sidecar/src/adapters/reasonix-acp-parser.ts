import type { AppEvent } from "../events";
import { boundedToolOutput } from "./output";

type JsonRecord = Record<string, unknown>;

function recordOf(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => recordOf(recordOf(item)?.content)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function chunkText(update: JsonRecord): string | null {
  const text = recordOf(update.content)?.text;
  return typeof text === "string" && text ? text : null;
}

/**
 * Traduit une notification `reasonix acp` en AppEvents. L'usage émis est
 * cumulé sur le tour : l'adaptateur ne garde que le dernier.
 */
export function parseReasonixAcpMessage(message: unknown): AppEvent[] {
  const msg = recordOf(message);
  const params = recordOf(msg?.params);
  if (!msg || !params) return [];

  if (msg.method === "_reasonix.io/session/status_update") {
    const status = recordOf(params.status);
    if (status?.state !== "running") return [];
    const events: AppEvent[] = [];
    if (typeof status.phase === "string" && status.phase) {
      events.push({ type: "turn-phase", phase: status.phase });
    }
    const turn = recordOf(recordOf(status.usage)?.turn);
    if (params.event === "usage" && turn) {
      events.push({
        type: "usage",
        inputTokens: numberOrZero(turn.promptTokens),
        outputTokens: numberOrZero(turn.completionTokens),
      });
    }
    return events;
  }

  if (msg.method !== "session/update") return [];
  const update = recordOf(params.update);
  if (!update) return [];

  switch (update.sessionUpdate) {
    case "agent_thought_chunk": {
      const text = chunkText(update);
      return text ? [{ type: "reasoning-delta", text }] : [];
    }
    case "agent_message_chunk": {
      const text = chunkText(update);
      return text ? [{ type: "text-delta", text }] : [];
    }
    case "tool_call": {
      if (typeof update.toolCallId !== "string") return [];
      return [{
        type: "tool-start",
        toolId: update.toolCallId,
        toolName: String(update.title || "outil"),
        input: update.rawInput ?? {},
      }];
    }
    case "tool_call_update": {
      if (typeof update.toolCallId !== "string") return [];
      if (update.status !== "completed" && update.status !== "failed") return [];
      return [{
        type: "tool-end",
        toolId: update.toolCallId,
        output: boundedToolOutput(contentText(update.content)),
        images: [],
      }];
    }
    default:
      return [];
  }
}
