import { parseJsonlLine, type AppEvent } from "../events";

// Une ligne stream-json Claude peut produire 0..n AppEvents.
export function parseClaudeLine(line: string): AppEvent[] {
  const obj = parseJsonlLine(line);
  if (!obj) return [];
  const out: AppEvent[] = [];

  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init" && typeof obj.session_id === "string") {
        out.push({
          type: "session", provider: "claude",
          cliSessionId: obj.session_id, model: String(obj.model ?? ""),
        });
      }
      break;
    }
    case "stream_event": {
      // --include-partial-messages : SSE Anthropic brut dans obj.event
      const ev = obj.event as any;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        out.push({ type: "text-delta", text: ev.delta.text });
      }
      break;
    }
    case "assistant": {
      const content = (obj.message as any)?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          out.push({ type: "text-final", text: block.text });
        } else if (block.type === "tool_use") {
          out.push({ type: "tool-start", toolId: block.id, toolName: block.name, input: block.input });
        }
      }
      break;
    }
    case "user": {
      const content = (obj.message as any)?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          out.push({
            type: "tool-end", toolId: block.tool_use_id,
            output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            images: [],
          });
        }
      }
      break;
    }
    case "result": {
      const usage = obj.usage as any;
      if (usage) {
        out.push({
          type: "usage",
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        });
      }
      out.push(
        obj.subtype === "success"
          ? { type: "status", state: "done" }
          : { type: "status", state: "error", error: String(obj.subtype) }
      );
      break;
    }
  }
  return out;
}
