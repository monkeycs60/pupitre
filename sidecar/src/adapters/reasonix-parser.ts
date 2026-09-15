import { parseJsonlLine, type AppEvent } from "../events";
import { boundedToolOutput } from "./output";

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseReasonixLine(line: string): AppEvent[] {
  const event = parseJsonlLine(line);
  if (!event) return [];
  switch (event.kind ?? event.type) {
    case "text":
      return typeof event.text === "string" ? [{ type: "text-delta", text: event.text }] : [];
    case "tool_start":
    case "tool-start":
      return [{
        type: "tool-start",
        toolId: String(event.tool_id ?? event.id ?? crypto.randomUUID()),
        toolName: String(event.tool_name ?? event.name ?? "outil"),
        input: event.input ?? {},
      }];
    case "tool_end":
    case "tool-end":
      return [{
        type: "tool-end",
        toolId: String(event.tool_id ?? event.id ?? ""),
        output: boundedToolOutput(typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? "")),
        images: [],
      }];
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
