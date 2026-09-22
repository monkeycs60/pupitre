import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeLineParser, parseClaudeLine } from "../src/adapters/claude-parser";
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
  expect(usage.contextTokens).toBe(33_295);
  expect(usage.contextWindowTokens).toBe(200_000);
  const status = evts.filter((e) => e.type === "status").at(-1) as any;
  expect(status.state).toBe("done");
});

test("mappe le rate_limit_event de la fixture en event rate-limit claude", () => {
  const event = eventsFromFixture().find((e) => e.type === "rate-limit") as any;
  expect(event).toBeDefined();
  expect(event.provider).toBe("claude");
  // Payload brut = rate_limit_info, normalisé plus loin par le QuotaTracker.
  expect(event.payload).toMatchObject({ rateLimitType: "five_hour", status: "allowed" });
  expect(typeof event.payload.resetsAt).toBe("number");
});

test("ignore un rate_limit_event sans rate_limit_info exploitable", () => {
  expect(parseClaudeLine('{"type":"rate_limit_event"}')).toEqual([]);
  expect(parseClaudeLine('{"type":"rate_limit_event","rate_limit_info":42}')).toEqual([]);
});

test("ignore les contenus de message valides JSON mais non itérables", () => {
  expect(parseClaudeLine('{"type":"assistant","message":{"content":42}}')).toEqual([]);
  expect(parseClaudeLine('{"type":"user","message":{"content":42}}')).toEqual([]);
});

test("n'émet un tool-start qu'avec un id et un nom textuels", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: 42, name: "Bash", input: {} },
        { type: "tool_use", id: "tool-1", name: null, input: {} },
        { type: "tool_use", id: "tool-2", name: "Read", input: {} },
      ],
    },
  });

  expect(parseClaudeLine(line)).toEqual([
    { type: "tool-start", toolId: "tool-2", toolName: "Read", input: {} },
  ]);
});

test("utilise le résultat comme message d'erreur Claude", () => {
  expect(parseClaudeLine('{"type":"result","subtype":"error","result":"échec détaillé"}')).toEqual([
    { type: "status", state: "error", error: "échec détaillé" },
  ]);
});

test("extrait les images base64 des résultats d'outil sans persister leurs données dans la sortie", () => {
  const line = JSON.stringify({
    type: "user",
    message: { content: [{
      type: "tool_result",
      tool_use_id: "capture-1",
      content: [
        { type: "text", text: "Capture effectuée" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } },
      ],
    }] },
  });

  expect(parseClaudeLine(line)).toEqual([{
    type: "tool-end",
    toolId: "capture-1",
    output: JSON.stringify([
      { type: "text", text: "Capture effectuée" },
      { type: "image", source: "[image importée]" },
    ]),
    images: [],
    inlineImages: [{ mediaType: "image/png", data: "iVBORw==" }],
  }]);
});

test("ignore un `result` tant qu'une commande envoyée attend en file", () => {
  const parse = createClaudeLineParser();
  const lifecycle = (state: string) =>
    JSON.stringify({ type: "command_lifecycle", command_uuid: "c1", state });
  const result = JSON.stringify({ type: "result", subtype: "success", result: "" });

  expect(parse(lifecycle("queued"))).toEqual([]);
  expect(parse(result)).toEqual([]);
  expect(parse(lifecycle("started"))).toEqual([]);
  expect(parse(result)).toEqual([{ type: "status", state: "done" }]);
});

test("sans `command_lifecycle`, le `result` clôt le tour comme avant", () => {
  const parse = createClaudeLineParser();

  expect(parse(JSON.stringify({ type: "result", subtype: "success", result: "ok" })))
    .toEqual([{ type: "status", state: "done" }]);
});

test("traduit `system/task_notification` en notification de tâche de fond", () => {
  const line = JSON.stringify({
    type: "system", subtype: "task_notification", task_id: "b1", status: "completed",
    summary: "Background command \"Sleep\" completed (exit code 0)",
  });

  expect(parseClaudeLine(line)).toEqual([{
    type: "background-task",
    status: "completed",
    summary: "Background command \"Sleep\" completed (exit code 0)",
  }]);
});
