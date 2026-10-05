import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexLine } from "../src/adapters/codex-parser";
import type { AppEvent } from "../src/events";

function eventsFromFixture(): AppEvent[] {
  const raw = readFileSync(join(import.meta.dir, "fixtures/codex-basic.jsonl"), "utf8");
  return raw.split("\n").flatMap((line) => parseCodexLine(line));
}

test("émet une session Codex avec le thread_id de la fixture", () => {
  const session = eventsFromFixture().find((event) => event.type === "session");
  expect(session).toEqual({
    type: "session",
    provider: "codex",
    cliSessionId: "019fccc9-f867-7943-bd0c-546101d36137",
    model: "",
  });
});

test("émet le texte final contenant BONJOUR PUPITRE", () => {
  const text = eventsFromFixture()
    .filter((event) => event.type === "text-final")
    .map((event) => event.text)
    .join("");
  expect(text).toContain("BONJOUR PUPITRE");
});

test("émet la commande, l'usage et un dernier status done", () => {
  const events = eventsFromFixture();
  const toolStart = events.find((event) => event.type === "tool-start");
  expect(toolStart).toBeDefined();
  expect(toolStart?.toolName).toBe("shell");

  const usage = events.find((event) => event.type === "usage");
  expect(usage).toBeDefined();
  expect((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toBeGreaterThan(0);

  expect(events.filter((event) => event.type === "status").at(-1)).toEqual({
    type: "status",
    state: "done",
  });
});

test("ignore un contenu de message valide JSON mais de forme inattendue", () => {
  expect(parseCodexLine('{"type":"user","message":{"content":42}}')).toEqual([]);
});

test("mappe turn.failed vers un status error", () => {
  expect(parseCodexLine('{"type":"turn.failed","error":{"message":"échec Codex"}}')).toEqual([
    { type: "status", state: "error", error: "échec Codex" },
  ]);
});

test("borne une longue sortie d'outil en conservant sa fin", () => {
  const events = parseCodexLine(JSON.stringify({
    type: "item.completed",
    item: {
      id: "long-output",
      type: "command_execution",
      aggregated_output: `${"début\n".repeat(12_000)}RÉSUMÉ FINAL: 1 test échoue`,
    },
  }));
  const output = events.find((event) => event.type === "tool-end")?.output ?? "";

  expect(output.length).toBeLessThanOrEqual(60_000);
  expect(output).toContain("sortie intermédiaire tronquée");
  expect(output).toEndWith("RÉSUMÉ FINAL: 1 test échoue");
});

test("marque en échec une commande Codex au code de sortie non nul", () => {
  const [event] = parseCodexLine(JSON.stringify({
    type: "item.completed",
    item: { id: "cmd-1", type: "command_execution", aggregated_output: "boom", exit_code: 2, status: "failed" },
  }));
  expect(event).toMatchObject({ type: "tool-end", toolId: "cmd-1", isError: true });

  const [ok] = parseCodexLine(JSON.stringify({
    type: "item.completed",
    item: { id: "cmd-2", type: "command_execution", aggregated_output: "ok", exit_code: 0, status: "completed" },
  }));
  expect(ok).not.toHaveProperty("isError");
});
