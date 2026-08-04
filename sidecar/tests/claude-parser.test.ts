import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeLine } from "../src/adapters/claude-parser";
import type { AppEvent } from "../src/events";

function eventsFromFixture(): AppEvent[] {
  const raw = readFileSync(join(import.meta.dir, "fixtures/claude-basic.jsonl"), "utf8");
  return raw.split("\n").flatMap((line) => parseClaudeLine(line));
}

test("émet un event session avec le session_id de la fixture", () => {
  const session = eventsFromFixture().find((e) => e.type === "session");
  expect(session).toBeDefined();
  expect((session as any).cliSessionId.length).toBeGreaterThan(10);
  expect((session as any).provider).toBe("claude");
});

test("émet du texte contenant BONJOUR PUPITRE", () => {
  const text = eventsFromFixture()
    .filter((e) => e.type === "text-final")
    .map((e: any) => e.text).join("");
  expect(text).toContain("BONJOUR PUPITRE");
});

test("émet au moins un tool-start (le ls de la fixture) et l'usage final", () => {
  const evts = eventsFromFixture();
  expect(evts.some((e) => e.type === "tool-start")).toBe(true);
  const usage = evts.find((e) => e.type === "usage") as any;
  expect(usage.outputTokens).toBeGreaterThan(0);
  const status = evts.filter((e) => e.type === "status").at(-1) as any;
  expect(status.state).toBe("done");
});
