import { parseJsonlLine, type AppEvent } from "../events";

// Une ligne JSONL de `codex exec --json` peut produire 0..n AppEvents.
export function parseCodexLine(line: string): AppEvent[] {
  const obj = parseJsonlLine(line);
  if (!obj) return [];

  switch (obj.type) {
    case "thread.started": {
      if (typeof obj.thread_id !== "string") return [];
      return [{
        type: "session",
        provider: "codex",
        cliSessionId: obj.thread_id,
        model: "",
      }];
    }
    case "item.started":
    case "item.completed": {
      const item = obj.item as Record<string, unknown> | undefined;
      if (!item || typeof item.id !== "string") return [];

      if (item.type === "agent_message" && obj.type === "item.completed") {
        return typeof item.text === "string" && item.text
          ? [{ type: "text-final", text: item.text }]
          : [];
      }

      if (item.type === "command_execution") {
        if (obj.type === "item.started") {
          return [{
            type: "tool-start",
            toolId: item.id,
            toolName: "shell",
            input: { command: String(item.command ?? "") },
          }];
        }
        return [{
          type: "tool-end",
          toolId: item.id,
          output: String(item.aggregated_output ?? "").slice(0, 10_000),
          images: [],
        }];
      }

      // Les items `error` peuvent être de simples avertissements Codex.
      return [];
    }
    case "turn.completed": {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const events: AppEvent[] = [];
      if (usage) {
        events.push({
          type: "usage",
          inputTokens: numberOrZero(usage.input_tokens),
          outputTokens: numberOrZero(usage.output_tokens),
        });
      }
      events.push({ type: "status", state: "done" });
      return events;
    }
    case "turn.failed": {
      const error = obj.error as Record<string, unknown> | undefined;
      return [{
        type: "status",
        state: "error",
        error: String(error?.message ?? obj.message ?? "Codex turn failed"),
      }];
    }
    default:
      return [];
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
