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

  test("normalise l'usage camelCase de ReasonX", () => {
    expect(parseReasonixLine('{"kind":"usage","usage":{"promptTokens":12,"completionTokens":3}}')).toEqual([
      { type: "usage", inputTokens: 12, outputTokens: 3 },
    ]);
  });
});
