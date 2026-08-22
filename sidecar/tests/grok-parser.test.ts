import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGrokLine } from "../src/adapters/grok-parser";

test("mappe le stream Messages Grok vers les events unifiés", () => {
  const raw = readFileSync(join(import.meta.dir, "fixtures/grok-basic.jsonl"), "utf8");
  const events = raw.split("\n").flatMap((line) => parseGrokLine(line));
  const session = events.find((event) => event.type === "session");
  expect(session).toMatchObject({
    type: "session",
    provider: "grok",
    cliSessionId: "grok-session-1",
    model: "grok-4.6",
  });
  expect(events.some((event) => event.type === "text-delta" && event.text === "BONJOUR GROK")).toBe(true);
  expect(events.some((event) => event.type === "tool-start" && event.toolName === "run_terminal_cmd")).toBe(true);
  const usage = events.find((event) => event.type === "usage");
  expect(usage).toMatchObject({ inputTokens: 12, outputTokens: 8, contextWindowTokens: 500000 });
  expect(events.at(-1)).toMatchObject({ type: "status", state: "done" });
});

test("un objet error headless clôt le tour", () => {
  expect(parseGrokLine('{"type":"error","message":"auth failed"}')).toEqual([
    { type: "status", state: "error", error: "auth failed" },
  ]);
});
