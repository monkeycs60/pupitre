import { test, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker, type QuotaState } from "../src/quotas";
import { parseClaudeLine } from "../src/adapters/claude-parser";
import type { AppEvent } from "../src/events";

let dir: string;
let db: Database;
let tracker: QuotaTracker;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pupitre-quotas-"));
  db = openDb(dir);
  tracker = new QuotaTracker(db);
});

/** Le rate-limit claude tel que le parser le produit depuis la vraie fixture. */
function claudeRateLimitEvent(): AppEvent {
  const raw = readFileSync(join(import.meta.dir, "fixtures/claude-basic.jsonl"), "utf8");
  const event = raw
    .split("\n")
    .flatMap((line) => parseClaudeLine(line))
    .find((e) => e.type === "rate-limit");
  if (!event) throw new Error("aucun rate-limit dans la fixture claude");
  return event;
}

/** Le payload `rateLimits` de la vraie notification codex app-server. */
function codexRateLimitsPayload(): unknown {
  const raw = readFileSync(
    join(import.meta.dir, "fixtures/codex-app-server-basic.jsonl"),
    "utf8",
  );
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { msg?: any };
    if (entry.msg?.method === "account/rateLimits/updated") {
      return entry.msg.params.rateLimits;
    }
  }
  throw new Error("aucun account/rateLimits/updated dans la fixture codex");
}

test("ingère le rate-limit claude de la fixture en une fenêtre normalisée", () => {
  const state = tracker.ingest(claudeRateLimitEvent());
  expect(state).toMatchObject({ provider: "claude" });
  expect(state!.windows).toEqual([
    {
      label: "five_hour",
      usedPercent: null,
      resetsAt: new Date(1785855000 * 1000).toISOString(),
      windowDurationMins: 300,
    },
  ]);
  expect(tracker.snapshot().claude).toEqual(state!);
  expect(tracker.snapshot().codex).toBeNull();
  expect(tracker.snapshot().grok).toBeNull();
});

test("ingère le payload rateLimits codex de la fixture", () => {
  const state = tracker.ingest({
    type: "rate-limit",
    provider: "codex",
    payload: codexRateLimitsPayload(),
  });
  expect(state!.windows).toEqual([
    {
      label: "primary",
      usedPercent: 10,
      resetsAt: new Date(1786191460 * 1000).toISOString(),
      windowDurationMins: 10_080,
    },
  ]);
});

test("accepte aussi le résultat enveloppé de account/rateLimits/read", () => {
  const state = tracker.ingestPayload("codex", { rateLimits: codexRateLimitsPayload() });
  expect(state!.windows[0]).toMatchObject({ label: "primary", usedPercent: 10 });
});

test("remplace le snapshot codex et retire une fenêtre devenue absente", () => {
  tracker.ingestPayload("codex", {
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1786191460 },
    secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1786796260 },
  });

  const state = tracker.ingestPayload("codex", {
    primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1786191460 },
    secondary: null,
  });

  expect(state!.windows).toHaveLength(1);
  expect(state!.windows[0]).toMatchObject({ label: "primary", usedPercent: 11 });

  const empty = tracker.ingestPayload("codex", { primary: null, secondary: null });
  expect(empty!.windows).toEqual([]);
});

test("fusionne une notification codex clairsemée sans effacer la fenêtre absente", () => {
  tracker.ingest({
    type: "rate-limit",
    provider: "codex",
    payload: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1786191460 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1786796260 },
    },
  });

  const state = tracker.ingest({
    type: "rate-limit",
    provider: "codex",
    payload: {
      primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1786191460 },
      secondary: null,
    },
  });

  expect(state!.windows).toHaveLength(2);
  expect(state!.windows[0]).toMatchObject({ label: "primary", usedPercent: 11 });
  expect(state!.windows[1]).toMatchObject({ label: "secondary", usedPercent: 20 });
});

test("fusionne les fenêtres par label sans perdre les précédentes", () => {
  tracker.ingest(claudeRateLimitEvent());
  const state = tracker.ingestPayload("claude", {
    rateLimitType: "seven_day",
    resetsAt: 1786191460,
    usedPercent: 42,
  });
  expect(state!.windows.map((w) => w.label)).toEqual(["five_hour", "seven_day"]);
  expect(state!.windows[1]).toMatchObject({ usedPercent: 42, windowDurationMins: 10_080 });

  // Ré-ingestion de la même fenêtre : mise à jour en place, pas de doublon.
  const updated = tracker.ingestPayload("claude", {
    rateLimitType: "seven_day",
    resetsAt: 1786191460,
    usedPercent: 55,
  });
  expect(updated!.windows.map((w) => w.label)).toEqual(["five_hour", "seven_day"]);
  expect(updated!.windows[1]!.usedPercent).toBe(55);
});

test("ignore les events non rate-limit et les payloads inexploitables", () => {
  expect(tracker.ingest({ type: "text-delta", text: "x" })).toBeNull();
  expect(tracker.ingestPayload("claude", { status: "allowed" })).toBeNull();
  expect(tracker.ingestPayload("codex", { status: "allowed" })).toBeNull();
  expect(tracker.ingestPayload("codex", "pas un objet")).toBeNull();
  expect(tracker.snapshot()).toEqual({ claude: null, codex: null, grok: null });
});

test("ingère le payload crédits Grok", () => {
  const state = tracker.ingestPayload("grok", {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-20T13:33:02.366Z",
        end: "2026-08-27T13:33:02.366Z",
      },
      creditUsagePercent: 25,
    },
  });
  expect(state!.windows).toEqual([
    {
      label: "weekly",
      usedPercent: 25,
      resetsAt: "2026-08-27T13:33:02.366Z",
      windowDurationMins: 10_080,
    },
  ]);
  expect(tracker.snapshot().grok).toEqual(state!);
});

test("l'état survit à la réouverture de la base", () => {
  tracker.ingest(claudeRateLimitEvent());
  tracker.ingestPayload("codex", codexRateLimitsPayload());
  const before = tracker.snapshot();
  db.close();

  const reopened = openDb(dir);
  const restored = new QuotaTracker(reopened).snapshot();
  expect(restored).toEqual(before);
  reopened.close();
});

test("notifie les abonnés à chaque mise à jour et cesse après désinscription", () => {
  const seen: QuotaState[] = [];
  const unsubscribe = tracker.subscribe((state) => seen.push(state));
  tracker.ingest(claudeRateLimitEvent());
  tracker.ingestPayload("codex", codexRateLimitsPayload());
  tracker.ingestPayload("claude", { status: "allowed" }); // ignoré : pas de notif
  expect(seen.map((s) => s.provider)).toEqual(["claude", "codex"]);

  unsubscribe();
  tracker.ingestPayload("codex", codexRateLimitsPayload());
  expect(seen).toHaveLength(2);
});
