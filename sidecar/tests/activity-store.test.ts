import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ActivityStore, type ActivityReport } from "../src/stores/activity";
import { ProjectStore } from "../src/stores/projects";

function setup() {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-activity-store-")));
  const project = new ProjectStore(db).create({ name: "Pupitre", path: `/tmp/pupitre-${crypto.randomUUID()}` });
  return { db, project, store: new ActivityStore(db) };
}

function report(day: string, commits = 2): ActivityReport {
  return {
    day,
    generatedAt: `${day}T18:00:00.000Z`,
    summary: null,
    projects: [{
      projectId: "p", projectName: "Pupitre", userMs: 3_600_000, agentMs: 60_000, topics: [], topicsSource: "titles",
      conversations: [], commits: [], unlinkedCommitCount: 0, linesAdded: 0, linesRemoved: 0, tickets: [], mergeRequests: [], ticketsReady: [], todosDone: [],
    }],
    totals: { userMs: 3_600_000, agentMs: 60_000, commits, mergeRequests: 1, ticketsReady: 0, linesAdded: 10, linesRemoved: 2, conversations: 0 },
    retro: { created: [], updated: [], stabilized: [], returned: [], error: null },
  };
}

test("un rapport par jour, remplacé à la régénération, listé du plus récent au plus ancien", () => {
  const { db, store } = setup();
  store.saveReport(report("2026-09-14"));
  store.saveReport(report("2026-09-15", 1));
  store.saveReport({ ...report("2026-09-15", 7), generatedAt: "2026-09-15T22:00:00.000Z" });
  expect(store.days()).toEqual([
    { day: "2026-09-15", generated_at: "2026-09-15T22:00:00.000Z", projectCount: 1, commits: 7, mergeRequests: 1, ticketsReady: 0, userMs: 3_600_000 },
    { day: "2026-09-14", generated_at: "2026-09-14T18:00:00.000Z", projectCount: 1, commits: 2, mergeRequests: 1, ticketsReady: 0, userMs: 3_600_000 },
  ]);
  expect(store.report("2026-09-15")?.totals.commits).toBe(7);
  expect(store.report("2026-09-13")).toBeNull();
  store.deleteReport("2026-09-14");
  expect(store.days().map((item) => item.day)).toEqual(["2026-09-15"]);
  db.close();
});

test("l'état garde le premier et le dernier jour traités", () => {
  const { db, store } = setup();
  expect(store.state()).toEqual({ first_day: null, last_day: null, last_run_at: null, last_error: null });
  store.markProcessed("2026-09-14", "2026-09-14T18:00:00.000Z");
  store.markProcessed("2026-09-10", "2026-09-15T09:00:00.000Z");
  store.markProcessed("2026-09-15", "2026-09-15T18:00:00.000Z");
  expect(store.state()).toEqual({
    first_day: "2026-09-10", last_day: "2026-09-15", last_run_at: "2026-09-15T18:00:00.000Z", last_error: null,
  });
  store.setState({ last_error: "modèle indisponible" });
  expect(store.state().last_error).toBe("modèle indisponible");
  db.close();
});

test("les motifs portent leurs preuves, dédupliquées, et changent de statut", () => {
  const { db, project, store } = setup();
  const now = "2026-09-15T18:00:00.000Z";
  const motif = store.createMotif({
    projectId: project.id,
    kind: "recurrence",
    title: "Le sidecar périmé revient",
    statement: "Trois conversations relancent le sidecar sans le savoir.",
    day: "2026-09-15",
    evidence: [
      { kind: "conversation", ref: "c1", label: "Latence 124 s" },
      { kind: "conversation", ref: "c2", label: "Écran noir" },
    ],
  }, now);
  expect(motif.status).toBe("open");
  expect(motif.evidence).toHaveLength(2);
  expect(motif.first_seen_day).toBe("2026-09-15");

  const added = store.addEvidence(motif.id, "2026-09-16", [
    { kind: "conversation", ref: "c2", label: "doublon" },
    { kind: "commit", ref: "a".repeat(40), label: "fix: garde-fou" },
  ], "2026-09-16T18:00:00.000Z");
  expect(added).toBe(1);
  const refreshed = store.motif(motif.id)!;
  expect(refreshed.evidence).toHaveLength(3);
  expect(refreshed.last_seen_day).toBe("2026-09-16");

  store.updateMotif(motif.id, { status: "dismissed", dismissed_at: "2026-09-16T19:00:00.000Z" }, "2026-09-16T19:00:00.000Z");
  expect(store.listMotifs({ statuses: ["open"] })).toEqual([]);
  expect(store.listMotifs({ projectId: project.id, statuses: ["dismissed"] }).map((item) => item.id)).toEqual([motif.id]);
  expect(() => store.addEvidence("inconnu", "2026-09-16", [], now)).toThrow(/motif inconnu/);
  db.close();
});
