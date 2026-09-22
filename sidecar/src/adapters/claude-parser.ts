import { parseJsonlLine, type AppEvent, type Provider } from "../events";
import { boundedToolOutput } from "./output";

// Une ligne stream-json Claude peut produire 0..n AppEvents.
export function parseClaudeLine(line: string, provider: Provider = "claude"): AppEvent[] {
  const obj = parseJsonlLine(line);
  if (!obj) return [];
  const out: AppEvent[] = [];

  switch (obj.type) {
    case "system": {
      if (obj.subtype === "init" && typeof obj.session_id === "string") {
        out.push({
          type: "session", provider,
          cliSessionId: obj.session_id, model: String(obj.model ?? ""),
        });
      } else if (obj.subtype === "task_notification") {
        out.push({
          type: "background-task",
          status: String(obj.status ?? ""),
          summary: String(obj.summary ?? ""),
        });
      }
      break;
    }
    case "stream_event": {
      // --include-partial-messages : SSE Anthropic brut dans obj.event
      const ev = obj.event as any;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        out.push({ type: "text-delta", text: ev.delta.text });
      } else if (
        ev?.type === "content_block_delta"
        && ev.delta?.type === "thinking_delta"
        && typeof ev.delta.thinking === "string"
      ) {
        out.push({ type: "reasoning-delta", text: ev.delta.thinking });
      }
      break;
    }
    case "assistant": {
      const content = (obj.message as any)?.content ?? [];
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && block.text) {
          out.push({ type: "text-final", text: block.text });
        } else if (
          block.type === "tool_use"
          && typeof block.id === "string"
          && typeof block.name === "string"
        ) {
          out.push({ type: "tool-start", toolId: block.id, toolName: block.name, input: block.input });
        }
      }
      break;
    }
    case "user": {
      const content = (obj.message as any)?.content ?? [];
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          const blocks = Array.isArray(block.content) ? block.content : [];
          const inlineImages = blocks.flatMap((item: any) => {
            const source = item?.type === "image" ? item.source : null;
            const mediaType = source?.media_type;
            const data = source?.type === "base64" ? source.data : null;
            return typeof mediaType === "string" && typeof data === "string"
              ? [{ mediaType, data }]
              : [];
          });
          const printableContent = blocks.map((item: any) =>
            item?.type === "image" ? { type: "image", source: "[image importée]" } : item
          );
          out.push({
            type: "tool-end", toolId: block.tool_use_id,
            output: boundedToolOutput(
              typeof block.content === "string" ? block.content : JSON.stringify(printableContent),
            ),
            images: [],
            ...(inlineImages.length > 0 ? { inlineImages } : {}),
          });
        }
      }
      break;
    }
    case "rate_limit_event": {
      // {"type":"rate_limit_event","rate_limit_info":{"status":…,"resetsAt":…,
      //  "rateLimitType":"five_hour",…}} — payload brut, normalisé par le QuotaTracker.
      const info = obj.rate_limit_info;
      if (typeof info === "object" && info !== null && !Array.isArray(info)) {
        out.push({ type: "rate-limit", provider, payload: info });
      }
      break;
    }
    case "error": {
      out.push({
        type: "status",
        state: "error",
        error: String(obj.message ?? obj.result ?? "erreur"),
      });
      break;
    }
    case "result": {
      const usage = obj.usage as any;
      if (usage) {
        const modelUsage = Object.values(
          typeof obj.modelUsage === "object" && obj.modelUsage !== null
            ? obj.modelUsage as Record<string, Record<string, unknown>>
            : {},
        );
        const contextWindowTokens = modelUsage.reduce(
          (largest, model) => Math.max(largest, numberOrZero(model.contextWindow)),
          0,
        );
        const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
        const currentUsage = iterations.at(-1) ?? usage;
        const contextTokens = numberOrZero(currentUsage.input_tokens)
          + numberOrZero(currentUsage.cache_creation_input_tokens)
          + numberOrZero(currentUsage.cache_read_input_tokens)
          + numberOrZero(currentUsage.output_tokens);
        out.push({
          type: "usage",
          inputTokens: numberOrZero(usage.input_tokens),
          outputTokens: numberOrZero(usage.output_tokens),
          ...(contextTokens > 0 ? { contextTokens } : {}),
          ...(contextWindowTokens > 0 ? { contextWindowTokens } : {}),
        });
      }
      out.push(
        obj.subtype === "success"
          ? { type: "status", state: "done" }
          : { type: "status", state: "error", error: String(obj.result ?? obj.subtype) }
      );
      break;
    }
  }
  return out;
}

/**
 * Au démarrage, `claude -r` traite d'abord les notifications de tâches de fond
 * restées orphelines, et un `result` vide les clôt pendant que le message
 * envoyé attend encore dans la file. Ce `result` n'appartient pas au tour :
 * seuls ceux qui arrivent quand plus aucune commande n'attend le terminent.
 * Les commandes n'apparaissent dans `command_lifecycle` que si leur ligne
 * porte un `uuid`.
 */
export function createClaudeLineParser(
  provider: Provider = "claude",
  hooks: { onBackgroundTasks?: (count: number) => void } = {},
): (line: string) => AppEvent[] {
  const queued = new Set<string>();
  return (line) => {
    const obj = parseJsonlLine(line);
    if (obj?.type === "system" && obj.subtype === "background_tasks_changed" && Array.isArray(obj.tasks)) {
      hooks.onBackgroundTasks?.(obj.tasks.length);
      return [];
    }
    if (obj?.type === "command_lifecycle" && typeof obj.command_uuid === "string") {
      if (obj.state === "queued") queued.add(obj.command_uuid);
      else queued.delete(obj.command_uuid);
      return [];
    }
    if (obj?.type === "result" && queued.size > 0) return [];
    return parseClaudeLine(line, provider);
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
