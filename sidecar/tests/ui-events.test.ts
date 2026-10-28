import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticCalls } from "../src/automatic-calls";
import { openDb } from "../src/db";
import {
  UI_EVENT_BATCH_MAX,
  UI_EVENT_RETENTION_DAYS,
  UiEventStore,
  validUiEvents,
} from "../src/stores/ui-events";
import { USAGE_CATALOG } from "../../ui/src/usageCatalog";

const opened: Array<{ db: Database; dir: string }> = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-ui-events-"));
  const db = openDb(dir);
  opened.push({ db, dir });
  return { db, store: new UiEventStore(db) };
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Le rapport compte par jour local : des heures écrites en UTC rendraient le test
// dépendant du fuseau de la machine.
const october = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute);

test("la migration crée ui_events, son index (name, at) et refuse des props qui ne sont pas du JSON", () => {
  const { db } = setup();
  const columns = db.query("PRAGMA table_info(ui_events)").all() as Array<{ name: string; notnull: number }>;
  expect(columns.map((column) => [column.name, column.notnull])).toEqual([
    ["id", 0], ["at", 1], ["name", 1], ["project_id", 0], ["props", 0],
  ]);
  const index = db.query("PRAGMA index_info(idx_ui_events_name_at)").all() as Array<{ name: string }>;
  expect(index.map((column) => column.name)).toEqual(["name", "at"]);
  expect(() => db.query(
    "INSERT INTO ui_events (at, name, props) VALUES ('2026-10-28T09:00:00.000Z', 'nav.home', 'pas du json')",
  ).run()).toThrow();
});

test("la validation garde les événements bien formés, normalise l'heure et ignore le reste", () => {
  expect(validUiEvents([
    { at: "2026-10-28T09:00:00Z", name: "nav.report" },
    {
      at: "2026-10-28T09:00:01.000Z",
      name: "project.tab",
      projectId: "p1",
      props: { tab: "tickets", count: 2, ok: true, nested: { a: 1 }, list: [1], none: null, infinite: Infinity },
    },
    { at: "2026-10-28T09:00:02.000Z", name: "list.ai-search", props: { query: "x".repeat(2_000) } },
    { at: "2026-10-28T09:00:03.000Z", name: "Nav.Report" },
    { at: "2026-10-28T09:00:03.000Z", name: "nav..report" },
    { at: "2026-10-28T09:00:03.000Z", name: "nav.report." },
    { at: "2026-10-28T09:00:03.000Z", name: `nav.${"a".repeat(80)}` },
    { at: "pas une date", name: "nav.home" },
    { name: "nav.home" },
    "nav.home",
    null,
    { at: "2026-10-28T09:00:04.000Z", name: "shortcut", projectId: 42, props: "Ctrl+K" },
  ])).toEqual([
    { at: "2026-10-28T09:00:00.000Z", name: "nav.report", projectId: null, props: null },
    { at: "2026-10-28T09:00:01.000Z", name: "project.tab", projectId: "p1", props: '{"tab":"tickets","count":2,"ok":true}' },
    { at: "2026-10-28T09:00:02.000Z", name: "list.ai-search", projectId: null, props: null },
    { at: "2026-10-28T09:00:04.000Z", name: "shortcut", projectId: null, props: null },
  ]);
});

test("les props se mesurent en octets sérialisés, 1 Ko au plus, et un lot s'arrête à 200 événements", () => {
  const at = "2026-10-28T09:00:00.000Z";
  const [atLimit, accented] = validUiEvents([
    { at, name: "palette.command", props: { c: "x".repeat(1_016) } },
    { at, name: "palette.command", props: { c: "é".repeat(509) } },
  ]);
  expect(atLimit!.props).toHaveLength(1_024);
  expect(accented!.props).toBeNull();
  const flood = Array.from({ length: UI_EVENT_BATCH_MAX + 50 }, () => ({ at, name: "composer.send" }));
  expect(validUiEvents(flood)).toHaveLength(UI_EVENT_BATCH_MAX);
});

test("le rapport compte le catalogue, les onglets par propriété, chaque jour local et le travail de fond", () => {
  const { db, store } = setup();
  const now = october(28, 15);
  store.record(validUiEvents([
    { at: october(28, 9).toISOString(), name: "composer.send" },
    { at: october(28, 10).toISOString(), name: "composer.send" },
    { at: october(26, 11).toISOString(), name: "composer.send", projectId: "p1" },
    { at: october(27, 8).toISOString(), name: "project.tab", props: { tab: "tickets" } },
    { at: october(28, 14).toISOString(), name: "project.tab", props: { tab: "tickets" } },
    { at: october(25, 8).toISOString(), name: "project.tab", props: { tab: "sentry" } },
    { at: october(28, 9).toISOString(), name: "project.tab" },
    { at: october(28, 9).toISOString(), name: "hors.catalogue" },
    { at: october(21, 23, 59).toISOString(), name: "nav.report" },
    { at: october(29, 9).toISOString(), name: "nav.report" },
  ]));
  new AutomaticCalls(db);
  const calls = db.query("INSERT INTO automatic_call_counts VALUES (?, ?, ?)");
  calls.run("2026-10-27", "reprise", 3);
  calls.run("2026-10-28", "reprise", 2);
  calls.run("2026-10-28", "telegram", 1);
  calls.run("2026-10-21", "telegram", 9);

  const report = store.usage(7, now);

  expect(report.since).toBe(october(22, 0).toISOString());
  expect(report.until).toBe(now.toISOString());
  expect(report.catalog.map((entry) => entry.feature)).toEqual(USAGE_CATALOG.map((entry) => entry.feature));
  const feature = (id: string) => report.catalog.find((entry) => entry.feature === id);
  expect(feature("composer.send")).toEqual({
    feature: "composer.send",
    label: "Envoyer un message",
    area: "Conversation",
    count: 3,
    lastAt: october(28, 10).toISOString(),
  });
  expect(feature("project.tab.tickets")).toMatchObject({ count: 2, lastAt: october(28, 14).toISOString() });
  expect(feature("project.tab.sentry")).toMatchObject({ count: 1 });
  expect(feature("project.tab.tasks")).toMatchObject({ count: 0, lastAt: null });
  expect(feature("nav.report")).toMatchObject({ count: 0, lastAt: null });
  expect(report.events).toEqual([
    { name: "project.tab", count: 4, lastAt: october(28, 14).toISOString() },
    { name: "composer.send", count: 3, lastAt: october(28, 10).toISOString() },
    { name: "hors.catalogue", count: 1, lastAt: october(28, 9).toISOString() },
  ]);
  expect(report.daily).toEqual([
    { day: "2026-10-22", count: 0 },
    { day: "2026-10-23", count: 0 },
    { day: "2026-10-24", count: 0 },
    { day: "2026-10-25", count: 1 },
    { day: "2026-10-26", count: 1 },
    { day: "2026-10-27", count: 1 },
    { day: "2026-10-28", count: 5 },
  ]);
  expect(report.background).toEqual([{ kind: "reprise", count: 5 }, { kind: "telegram", count: 1 }]);
});

test("le rapport range les questions à Jarvis par chemin, avec leur durée médiane, et suit chaque action proposée", () => {
  const { store } = setup();
  const at = october(28, 9).toISOString();
  store.record(validUiEvents([
    { at, name: "jarvis.ask", props: { mode: "auto", model: "haiku-5.5", by: "haiku", escalated: false, status: "done", seconds: 9.6, proposed: "open,send-message" } },
    { at, name: "jarvis.ask", props: { mode: "auto", model: "haiku-5.5", by: "haiku", escalated: false, status: "done", seconds: 12.2, proposed: "open" } },
    { at, name: "jarvis.ask", props: { mode: "auto", model: "haiku-5.5", by: "haiku", escalated: false, status: "done", seconds: 10.4, proposed: "" } },
    { at, name: "jarvis.ask", props: { mode: "auto", model: "opus-5.5", by: "router", escalated: true, status: "done", seconds: 41, proposed: "archive,new-conversation" } },
    { at, name: "jarvis.ask", props: { mode: "auto", model: "opus-5.5", by: "haiku", escalated: true, status: "error", seconds: 90 } },
    { at, name: "jarvis.ask", props: { mode: "auto", model: "opus-5.5" } },
    { at, name: "jarvis.ask", props: { mode: "fast", model: "haiku-5.5" } },
    { at: october(20).toISOString(), name: "jarvis.ask", props: { mode: "orchestrate", model: "opus-5.5" } },
    { at, name: "jarvis.action", props: { kind: "open", result: "fait" } },
    { at, name: "jarvis.action", props: { kind: "send-message", result: "ignorée" } },
    { at, name: "jarvis.action", props: { kind: "archive", result: "échec" } },
  ]));

  const { jarvis } = store.usage(7, october(28, 15));

  expect(jarvis.questions).toEqual([
    { path: "haiku", count: 3, failed: 0, medianSeconds: 10.4 },
    { path: "router", count: 1, failed: 0, medianSeconds: 41 },
    { path: "handoff", count: 2, failed: 1, medianSeconds: null },
    { path: "fast", count: 1, failed: 0, medianSeconds: null },
  ]);
  expect(jarvis.actions).toEqual([
    { kind: "open", proposed: 2, done: 1, failed: 0, ignored: 0 },
    { kind: "archive", proposed: 1, done: 0, failed: 1, ignored: 0 },
    { kind: "new-conversation", proposed: 1, done: 0, failed: 0, ignored: 0 },
    { kind: "send-message", proposed: 1, done: 0, failed: 0, ignored: 1 },
  ]);
  expect(store.usage(7, october(10)).jarvis).toEqual({ questions: [], actions: [] });
});

test("sans compteur d'appels automatiques, le travail de fond est vide", () => {
  const { store } = setup();
  const report = store.usage(30, october(28));
  expect(report.background).toEqual([]);
  expect(report.daily).toHaveLength(30);
  expect(report.catalog.every((entry) => entry.count === 0 && entry.lastAt === null)).toBe(true);
});

test("la purge retire les événements de plus de 180 jours et garde la limite", () => {
  const { db, store } = setup();
  const now = new Date("2026-10-28T12:00:00.000Z");
  const cutoff = now.getTime() - UI_EVENT_RETENTION_DAYS * 86_400_000;
  store.record(validUiEvents([
    { at: new Date(cutoff - 1).toISOString(), name: "nav.home" },
    { at: new Date(cutoff).toISOString(), name: "nav.report" },
    { at: now.toISOString(), name: "nav.settings" },
  ]));
  expect(store.purge(now)).toBe(1);
  expect(db.query("SELECT name FROM ui_events ORDER BY at").all()).toEqual([{ name: "nav.report" }, { name: "nav.settings" }]);
  expect(store.purge(now)).toBe(0);
});
