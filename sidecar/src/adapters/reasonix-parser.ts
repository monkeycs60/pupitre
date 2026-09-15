import { parseJsonlLine, type AppEvent } from "../events";
import { boundedToolOutput } from "./output";

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return { args };
  }
}

export function parseReasonixLine(line: string): AppEvent[] {
  const event = parseJsonlLine(line);
  if (!event) return [];
  switch (event.kind ?? event.type) {
    case "text":
      return typeof event.text === "string" ? [{ type: "text-delta", text: event.text }] : [];
    case "tool_dispatch": {
      // Un même appel est annoncé trois fois : `partial` sans args, complet, puis `refreshed`.
      const tool = recordOf(event.tool);
      if (!tool || tool.partial === true || tool.refreshed === true || typeof tool.id !== "string") return [];
      return [{
        type: "tool-start",
        toolId: tool.id,
        toolName: String(tool.name || "outil"),
        input: parseArgs(tool.args),
      }];
    }
    case "tool_result": {
      const tool = recordOf(event.tool);
      if (!tool || typeof tool.id !== "string") return [];
      return [{
        type: "tool-end",
        toolId: tool.id,
        output: boundedToolOutput(typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output ?? "")),
        images: [],
      }];
    }
    case "usage": {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (!usage) return [];
      return [{
        type: "usage",
        inputTokens: numberOrZero(usage.promptTokens ?? usage.input_tokens),
        outputTokens: numberOrZero(usage.completionTokens ?? usage.output_tokens),
      }];
    }
    case "result": {
      const output: AppEvent[] = [];
      if (typeof event.session_id === "string") {
        output.push({ type: "session", provider: "reasonix", cliSessionId: event.session_id, model: "" });
      }
      output.push(event.subtype === "success" && event.is_error !== true
        ? { type: "status", state: "done" }
        : { type: "status", state: "error", error: String(event.result ?? event.subtype ?? "échec ReasonX") });
      return output;
    }
    case "error":
      return [{ type: "status", state: "error", error: String(event.message ?? "erreur ReasonX") }];
    default:
      return [];
  }
}
