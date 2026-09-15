import { describe, expect, test } from "bun:test";
import { parseClaudeLine } from "../src/adapters/claude-parser";
import { parseReasonixAcpMessage } from "../src/adapters/reasonix-acp-parser";

describe("aperçu de réflexion", () => {
  test("Claude et Grok diffusent les thinking_delta", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Je vérifie" } },
    });
    expect(parseClaudeLine(line)).toEqual([{ type: "reasoning-delta", text: "Je vérifie" }]);
  });
});

describe("parseReasonixAcpMessage", () => {
  const update = (value: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: value },
  });

  test("sépare la réflexion du texte de réponse", () => {
    expect(parseReasonixAcpMessage(update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hmm" },
    }))).toEqual([{ type: "reasoning-delta", text: "hmm" }]);
    expect(parseReasonixAcpMessage(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Bonjour" },
    }))).toEqual([{ type: "text-delta", text: "Bonjour" }]);
  });

  test("ouvre l'outil au tool_call et le ferme même en échec", () => {
    expect(parseReasonixAcpMessage(update({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "read_file",
      status: "pending",
      rawInput: { path: "/x" },
    }))).toEqual([{ type: "tool-start", toolId: "call-1", toolName: "read_file", input: { path: "/x" } }]);
    expect(parseReasonixAcpMessage(update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" })))
      .toEqual([]);
    expect(parseReasonixAcpMessage(update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "no such file" } }],
    }))).toEqual([{ type: "tool-end", toolId: "call-1", output: "no such file", images: [] }]);
  });

  test("expose la phase et l'usage du tour tant qu'il tourne", () => {
    const status = (event: string, state: string, extra: Record<string, unknown> = {}) => ({
      jsonrpc: "2.0",
      method: "_reasonix.io/session/status_update",
      params: { event, status: { state, phase: "implementing", ...extra } },
    });
    expect(parseReasonixAcpMessage(status("usage", "running", {
      usage: { turn: { promptTokens: 120, completionTokens: 8 } },
    }))).toEqual([
      { type: "turn-phase", phase: "implementing" },
      { type: "usage", inputTokens: 120, outputTokens: 8 },
    ]);
    expect(parseReasonixAcpMessage(status("completion", "idle"))).toEqual([]);
  });
});
