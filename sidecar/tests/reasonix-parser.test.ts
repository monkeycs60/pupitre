import { describe, expect, test } from "bun:test";
import { parseReasonixLine } from "../src/adapters/reasonix-parser";

describe("parseReasonixLine", () => {
  test("diffuse le texte et termine la session", () => {
    expect(parseReasonixLine('{"kind":"text","text":"Bonjour"}')).toEqual([
      { type: "text-delta", text: "Bonjour" },
    ]);
    expect(parseReasonixLine('{"type":"result","subtype":"success","is_error":false,"session_id":"s-1"}')).toEqual([
      { type: "session", provider: "reasonix", cliSessionId: "s-1", model: "" },
      { type: "status", state: "done" },
    ]);
  });

  test("n'ouvre qu'un seul outil par appel et le ferme sur tool_result", () => {
    const id = "call_00_x";
    expect(parseReasonixLine(`{"kind":"tool_dispatch","tool":{"id":"${id}","name":"bash","partial":true}}`)).toEqual([]);
    expect(parseReasonixLine(`{"kind":"tool_dispatch","tool":{"id":"${id}","name":"bash","args":"{\\"command\\": \\"ls\\"}"}}`)).toEqual([
      { type: "tool-start", toolId: id, toolName: "bash", input: { command: "ls" } },
    ]);
    expect(parseReasonixLine(`{"kind":"tool_dispatch","tool":{"id":"${id}","name":"bash","args":"{}","refreshed":true}}`)).toEqual([]);
    expect(parseReasonixLine(`{"kind":"tool_result","tool":{"id":"${id}","name":"bash","output":"a\\nb\\n"}}`)).toEqual([
      { type: "tool-end", toolId: id, output: "a\nb\n", images: [] },
    ]);
  });

  test("normalise l'usage camelCase d'OpenCode Go (CLI reasonix)", () => {
    expect(parseReasonixLine('{"kind":"usage","usage":{"promptTokens":12,"completionTokens":3}}')).toEqual([
      { type: "usage", inputTokens: 12, outputTokens: 3 },
    ]);
  });
});
