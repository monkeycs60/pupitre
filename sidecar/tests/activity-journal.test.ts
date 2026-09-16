import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  ActivityJournal,
  assembleReport,
  dayWindow,
  fallbackTopics,
  hydrateReport,
  parseSummary,
  parseTopics,
  summaryPrompt,
  toReportProject,
  topicsPrompt,
} from "../src/activity-report";
import type { ActivityReport } from "../src/stores/activity";
import { IntegrationStore } from "../src/stores/integrations";
import { ChangelogStore } from "../src/stores/changelog";
import { ConversationStore } from "../src/stores/conversations";
import { GitProjectService } from "../src/git";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";
import { TodoStore } from "../src/stores/todos";
import { TimeTrackingService } from "../src/time-tracking";

const DAY = "2026-08-24";

/** Horodatage local du jour testé, en ISO UTC comme les écrit le sidecar. */
function at(day: string, hour: number, minute = 0): string {
  const date = new Date(`${day}T00:00:00`);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-activity-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "Pupitre", path: dir });
  const conversations = new ConversationStore(db);
  const changelog = new ChangelogStore(db);
  const tickets = new TicketStore(db);
  const todos = new TodoStore(db);
  const time = new TimeTrackingService(db, projects, new GitProjectService(db, projects));
  const journal = new ActivityJournal(db, projects, changelog, time, tickets, todos);
  const insertEvent = (conversationId: string, payload: unknown, createdAt: string) => {
    db.query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
      .run(conversationId, JSON.stringify(payload), createdAt);
  };
  return { db, dir, projects, project, conversations, changelog, tickets, todos, time, journal, insertEvent };
}

test("la fenêtre d'un jour couvre minuit à minuit en heure locale", () => {
  const window = dayWindow(DAY);
  expect(window.endMs - window.startMs).toBe(86_400_000);
  expect(new Date(window.startMs).getHours()).toBe(0);
  expect(() => dayWindow("2026-13-01")).toThrow(/jour invalide/);
  expect(() => dayWindow("hier")).toThrow(/jour invalide/);
});

test("une journée vide ne produit aucun projet, donc aucun rapport", () => {
  const { db, journal } = setup();
  expect(journal.build(DAY)).toEqual([]);
  expect(journal.hasActivity(DAY)).toBe(false);
  db.close();
});

test("agrège heures, conversations, commits liés ou non, tickets et tâches du jour", () => {
  const context = setup();
  const { project, conversations, changelog, tickets, todos, time, journal, insertEvent, db } = context;
  const ticket = tickets.upsert(project.id, {
    key: "TECH-77", source: "clickup", title: "Réglette", status: "todo", externalUrl: "https://clickup/t/77",
  });
  const today = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-sol", firstMessage: "Corriger la réglette",
    ticketId: ticket.id,
  });
  const ongoing = conversations.create({
    projectId: project.id, provider: "claude", model: "opus", firstMessage: "Refonte de l'inbox",
  });
  const yesterday = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-5.6-sol", firstMessage: "Vieux sujet",
  });
  insertEvent(today.id, { type: "user-message", text: "Corrige la réglette" }, at(DAY, 9));
  insertEvent(today.id, { type: "text-final", text: "Fait." }, at(DAY, 9, 5));
  insertEvent(today.id, { type: "user-message", text: "Et les tests ?" }, at(DAY, 9, 10));
  insertEvent(ongoing.id, { type: "user-message", text: "Refonte de l'inbox" }, at("2026-08-20", 9));
  insertEvent(ongoing.id, { type: "user-message", text: "On continue" }, at(DAY, 14));
  insertEvent(yesterday.id, { type: "user-message", text: "Hier" }, at("2026-08-23", 18));

  for (let minute = 0; minute < 90; minute += 15) {
    time.addPresence({ projectId: project.id, conversationId: today.id, startedAt: at(DAY, 9, minute), endedAt: at(DAY, 9, minute + 15) });
  }
  db.query(`
    INSERT INTO time_entries (source_key, project_id, conversation_id, source, started_at, ended_at, day, backfilled)
    VALUES (?, ?, ?, 'agent', ?, ?, ?, 0)
  `).run("agent:test", project.id, today.id, at(DAY, 9, 2), at(DAY, 9, 7), DAY);

  const linkedSha = "a".repeat(40);
  const looseSha = "b".repeat(40);
  const otherDaySha = "c".repeat(40);
  changelog.import(project.id, [
    { repositoryPath: ".", sha: linkedSha, branch: "feature/TECH-77-reglette", subject: "feat: réglette", committedAt: `${DAY}T11:00:00+02:00` },
    { repositoryPath: "apps/api", sha: looseSha, branch: "master", subject: "chore: hors Pupitre", committedAt: `${DAY}T23:30:00+02:00` },
    { repositoryPath: ".", sha: otherDaySha, branch: "master", subject: "feat: la veille", committedAt: "2026-08-23T23:59:00+02:00" },
  ], at(DAY, 12));
  changelog.setLineStats(project.id, [{ sha: linkedSha, added: 40, removed: 12 }, { sha: looseSha, added: 3, removed: 0 }]);
  db.query("INSERT INTO commit_links (commit_sha, project_id, conversation_id, created_at) VALUES (?, ?, ?, ?)")
    .run(linkedSha, project.id, today.id, at(DAY, 11));

  const done = todos.create(project.id, { status: "backlog", message: "Nettoyer les presets", provider: "codex", model: "gpt-5.6-sol" });
  todos.update(done.id, { status: "done" });
  db.query("UPDATE project_todos SET payload = json_set(payload, '$.updated_at', ?) WHERE id = ?").run(at(DAY, 16), done.id);
  const pending = todos.create(project.id, { status: "backlog", message: "Encore à faire", provider: "codex", model: "gpt-5.6-sol" });

  const [entry, ...others] = journal.build(DAY);
  expect(others).toEqual([]);
  expect(entry).toBeDefined();
  expect(entry!.projectId).toBe(project.id);
  expect(entry!.userMs).toBe(90 * 60_000);
  expect(entry!.agentMs).toBe(5 * 60_000);
  expect(entry!.conversations.map((item) => item.id)).toEqual([today.id, ongoing.id]);
  expect(entry!.conversations[0]).toEqual(expect.objectContaining({
    ticketKey: "TECH-77", startedDay: DAY, turns: 2, userMs: 90 * 60_000, agentMs: 5 * 60_000,
  }));
  expect(entry!.conversations[0]!.events.map((event) => event.type)).toEqual(["user-message", "text-final", "user-message"]);
  expect(entry!.conversations[1]!.startedDay).toBe("2026-08-20");
  expect(entry!.commits.map((commit) => [commit.sha, commit.conversationId])).toEqual([
    [linkedSha, today.id],
    [looseSha, null],
  ]);
  expect(entry!.unlinkedCommitCount).toBe(1);
  expect(entry!.linesAdded).toBe(43);
  expect(entry!.linesRemoved).toBe(12);
  expect(entry!.tickets).toEqual([expect.objectContaining({ key: "TECH-77", externalUrl: "https://clickup/t/77" })]);
  expect(entry!.todosDone.map((item) => item.id)).toEqual([done.id]);
  expect(entry!.todosDone.map((item) => item.id)).not.toContain(pending.id);

  expect(journal.build("2026-08-23").map((item) => item.commits.length)).toEqual([1]);
  db.close();
});

test("un commit seul suffit à faire exister la journée, sans conversation", () => {
  const { db, project, changelog, journal } = setup();
  changelog.import(project.id, [
    { repositoryPath: ".", sha: "d".repeat(40), branch: "master", subject: "fix: terminal", committedAt: `${DAY}T08:00:00+02:00` },
  ], at(DAY, 9));
  const [entry] = journal.build(DAY);
  expect(entry?.conversations).toEqual([]);
  expect(entry?.unlinkedCommitCount).toBe(1);
  expect(entry?.userMs).toBe(0);
  db.close();
});

test("les sujets du modèle sont filtrés sur les conversations réelles, le reste retombe sur les titres", () => {
  const { db, project, conversations, journal, insertEvent } = setup();
  const first = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-5.6-sol", firstMessage: "Un" });
  const second = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-5.6-sol", firstMessage: "Deux" });
  insertEvent(first.id, { type: "user-message", text: "Un" }, at(DAY, 9));
  insertEvent(second.id, { type: "user-message", text: "Deux" }, at(DAY, 10));
  const [entry] = journal.build(DAY);

  const prompt = topicsPrompt(entry!);
  expect(prompt).toContain(first.id);
  expect(prompt).toContain("Un");

  const topics = parseTopics({ topics: [
    { title: "Réglette", detail: "Presets sortis du composer.", conversationIds: [first.id, "inconnu"] },
    { title: "Sans preuve", detail: "", conversationIds: ["inconnu"] },
  ] }, entry!);
  expect(topics).toHaveLength(2);
  expect(topics![0]).toEqual({ title: "Réglette", detail: "Presets sortis du composer.", conversationIds: [first.id] });
  expect(topics![1]!.conversationIds).toEqual([second.id]);

  expect(parseTopics({ topics: [] }, entry!)).toBeNull();
  expect(parseTopics("n'importe quoi", entry!)).toBeNull();
  expect(fallbackTopics(entry!).map((topic) => topic.conversationIds)).toEqual([[first.id], [second.id]]);

  const reportProject = toReportProject(entry!, null);
  expect(reportProject.topicsSource).toBe("titles");
  expect("events" in reportProject.conversations[0]!).toBe(false);
  const report = assembleReport(DAY, at(DAY, 18), [reportProject], { created: [], updated: [], stabilized: [], returned: [], error: null });
  expect(report.totals.conversations).toBe(2);
  db.close();
});

test("compte les MR ouvertes par moi ce jour, les tickets passés prêts pour la prod, et donne une URL ClickUp aux tickets Git", () => {
  const { db, project, tickets, journal, changelog } = setup();
  const integrations = new IntegrationStore(db);
  const clickup = integrations.upsert(project.id, "clickup", { config: { teamId: "20556900", listIds: [] } });
  const gitlab = integrations.upsert(project.id, "gitlab", { config: { host: "https://git", projects: [] } });
  integrations.markOk(clickup.id, {});
  integrations.markOk(gitlab.id, { username: "clement.serizay" });

  const mine = tickets.upsert(project.id, { key: "TECH-90", source: "git", title: "Ma MR", status: "", externalUrl: null });
  tickets.upsertRef(mine.id, { kind: "mr", ref: "reactor!1", payload: { iid: 1, project: "reactor", title: "TECH-90 / Ma MR", url: "https://git/1", state: "opened", author: "clement.serizay", createdAt: at(DAY, 10) } });
  const theirs = tickets.upsert(project.id, { key: "TECH-91", source: "git", title: "Sa MR", status: "", externalUrl: null });
  tickets.upsertRef(theirs.id, { kind: "mr", ref: "reactor!2", payload: { iid: 2, project: "reactor", title: "TECH-91", url: "https://git/2", state: "opened", author: "louis.quellier", createdAt: at(DAY, 11) } });
  const old = tickets.upsert(project.id, { key: "TECH-92", source: "git", title: "Vieille MR", status: "", externalUrl: null });
  tickets.upsertRef(old.id, { kind: "mr", ref: "reactor!3", payload: { iid: 3, project: "reactor", title: "TECH-92", url: "https://git/3", state: "merged", author: "clement.serizay", createdAt: at("2026-08-20", 11) } });

  const shipped = tickets.upsert(project.id, { key: "TECH-93", source: "clickup", title: "Livré", status: "code review", externalUrl: "https://app.clickup.com/t/abc" });
  tickets.upsert(project.id, { key: "TECH-93", source: "clickup", title: "Livré", status: "ready for production", externalUrl: "https://app.clickup.com/t/abc" });
  db.query("UPDATE ticket_status_changes SET changed_at = ? WHERE ticket_id = ?").run(at(DAY, 15), shipped.id);
  const bounced = tickets.upsert(project.id, { key: "TECH-94", source: "clickup", title: "Retour", status: "ready for production", externalUrl: "https://app.clickup.com/t/def" });
  tickets.upsert(project.id, { key: "TECH-94", source: "clickup", title: "Retour", status: "in progress", externalUrl: "https://app.clickup.com/t/def" });
  db.query("UPDATE ticket_status_changes SET changed_at = ? WHERE ticket_id = ?").run(at(DAY, 16), bounced.id);

  const [entry] = journal.build(DAY);
  expect(entry!.mergeRequests.map((item) => item.ref)).toEqual(["reactor!1"]);
  expect(entry!.mergeRequests[0]).toEqual(expect.objectContaining({ ticketKey: "TECH-90", url: "https://git/1" }));
  expect(entry!.ticketsReady.map((item) => item.key)).toEqual(["TECH-93"]);
  expect(entry!.ticketsReady[0]!.toStatus).toBe("ready for production");
  expect(entry!.tickets.map((item) => [item.key, item.externalUrl])).toEqual([
    ["TECH-90", "https://app.clickup.com/t/20556900/TECH-90"],
    ["TECH-93", "https://app.clickup.com/t/abc"],
  ]);

  const report = assembleReport(DAY, at(DAY, 18), [toReportProject(entry!, null)], { created: [], updated: [], stabilized: [], returned: [], error: null }, "Résumé.");
  expect(report.totals).toEqual(expect.objectContaining({ mergeRequests: 1, ticketsReady: 1 }));
  expect(report.summary).toBe("Résumé.");
  expect(summaryPrompt(DAY, report.projects)).toContain("TECH-93");
  expect(parseSummary({ summary: "  Deux\n phrases. " })).toBe("Deux phrases.");
  expect(parseSummary({ summary: "" })).toBeNull();
  expect(parseSummary("rien")).toBeNull();
  void changelog;
  db.close();
});

test("un rapport sauvé sans +/− reprend les lignes du changelog à la lecture", () => {
  const { db, project, changelog } = setup();
  const sha = "e".repeat(40);
  changelog.import(project.id, [
    { repositoryPath: ".", sha, branch: "master", subject: "feat: après coup", committedAt: `${DAY}T08:00:00+02:00` },
  ], at(DAY, 9));
  changelog.setLineStats(project.id, [{ sha, added: 21, removed: 4 }]);
  const stale = {
    day: DAY, generatedAt: at(DAY, 18), summary: null,
    projects: [{
      projectId: project.id, projectName: "Pupitre", userMs: 0, agentMs: 0, topics: [], topicsSource: "titles" as const,
      conversations: [], unlinkedCommitCount: 1, linesAdded: 0, linesRemoved: 0, tickets: [], todosDone: [],
      commits: [{ sha, repositoryPath: ".", branch: "master", subject: "feat: après coup", productMessage: null, linesAdded: null, linesRemoved: null, committedAt: `${DAY}T08:00:00+02:00`, conversationId: null, isMerge: false }],
    }],
    totals: { userMs: 0, agentMs: 0, commits: 1, linesAdded: 0, linesRemoved: 0, conversations: 0 },
    retro: { created: [], updated: [], stabilized: [], returned: [], error: null },
  } as unknown as ActivityReport;
  const fresh = hydrateReport(stale, changelog);
  expect(fresh.projects[0]!.commits[0]).toEqual(expect.objectContaining({ linesAdded: 21, linesRemoved: 4 }));
  expect(fresh.projects[0]!.mergeRequests).toEqual([]);
  expect(fresh.totals).toEqual(expect.objectContaining({ linesAdded: 21, linesRemoved: 4, mergeRequests: 0, ticketsReady: 0 }));
  expect(fresh.projects[0]!.commits[0]!.isMerge).toBe(false);
  db.close();
});

test("une fusion reste dans la liste avec ses +/− et sort des totaux du jour", () => {
  const { db, project, changelog, journal } = setup();
  const authored = "a".repeat(40);
  const merge = "b".repeat(40);
  changelog.import(project.id, [
    { repositoryPath: ".", sha: authored, branch: "feature/TECH-1", subject: "feat: jauge", committedAt: `${DAY}T10:00:00+02:00` },
    { repositoryPath: ".", sha: merge, branch: "feature/TECH-1", subject: "Merge origin/develop", committedAt: `${DAY}T15:00:00+02:00`, isMerge: true },
  ], at(DAY, 16));
  changelog.setLineStats(project.id, [
    { sha: authored, added: 128, removed: 75 },
    { sha: merge, added: 33_586, removed: 69_336 },
  ]);
  const [entry] = journal.build(DAY);
  expect(entry!.commits).toHaveLength(2);
  expect(entry!.commits.find((commit) => commit.sha === merge)).toEqual(expect.objectContaining({
    isMerge: true, linesAdded: 33_586, linesRemoved: 69_336,
  }));
  expect(entry!.linesAdded).toBe(128);
  expect(entry!.linesRemoved).toBe(75);
  const stale = {
    day: DAY, generatedAt: at(DAY, 18), summary: null,
    projects: [{
      projectId: project.id, projectName: "Pupitre", userMs: 0, agentMs: 0, topics: [], topicsSource: "titles" as const,
      conversations: [], unlinkedCommitCount: 2, linesAdded: 33_714, linesRemoved: 69_411, tickets: [], todosDone: [],
      commits: [
        { sha: authored, repositoryPath: ".", branch: "feature/TECH-1", subject: "feat: jauge", productMessage: null, linesAdded: 128, linesRemoved: 75, committedAt: `${DAY}T10:00:00+02:00`, conversationId: null },
        { sha: merge, repositoryPath: ".", branch: "feature/TECH-1", subject: "Merge origin/develop", productMessage: null, linesAdded: 33_586, linesRemoved: 69_336, committedAt: `${DAY}T15:00:00+02:00`, conversationId: null },
      ],
    }],
    totals: { userMs: 0, agentMs: 0, commits: 2, linesAdded: 33_714, linesRemoved: 69_411, conversations: 0 },
    retro: { created: [], updated: [], stabilized: [], returned: [], error: null },
  } as unknown as ActivityReport;
  const fresh = hydrateReport(stale, changelog);
  expect(fresh.projects[0]!.commits[1]).toEqual(expect.objectContaining({ isMerge: true, linesAdded: 33_586 }));
  expect(fresh.projects[0]!.linesAdded).toBe(128);
  expect(fresh.totals).toEqual(expect.objectContaining({ commits: 2, linesAdded: 128, linesRemoved: 75 }));
  db.close();
});


test("les totaux quotidiens du changelog suivent le jour local du commit, et la présence quotidienne recolle les tranches", () => {
  const { db, project, changelog, time } = setup();
  changelog.import(project.id, [
    { repositoryPath: ".", sha: "1".repeat(40), branch: "master", subject: "tard", committedAt: "2026-08-24T23:50:00+02:00" },
    { repositoryPath: ".", sha: "2".repeat(40), branch: "master", subject: "tôt", committedAt: "2026-08-25T00:10:00+02:00" },
    { repositoryPath: ".", sha: "3".repeat(40), branch: "master", subject: "hors", committedAt: "2026-08-20T12:00:00+02:00" },
  ], at(DAY, 12));
  changelog.setLineStats(project.id, [{ sha: "1".repeat(40), added: 5, removed: 1 }, { sha: "2".repeat(40), added: 7, removed: 0 }]);
  expect(changelog.dailyTotals("2026-08-24", "2026-08-25")).toEqual([
    { day: "2026-08-24", projectId: project.id, commits: 1, linesAdded: 5, linesRemoved: 1 },
    { day: "2026-08-25", projectId: project.id, commits: 1, linesAdded: 7, linesRemoved: 0 },
  ]);
  changelog.import(project.id, [
    { repositoryPath: ".", sha: "4".repeat(40), branch: "feature/x", subject: "Merge origin/develop", committedAt: "2026-08-24T23:55:00+02:00", isMerge: true },
  ], at(DAY, 12));
  changelog.setLineStats(project.id, [{ sha: "4".repeat(40), added: 33_586, removed: 69_336 }]);
  expect(changelog.dailyTotals("2026-08-24", "2026-08-24")).toEqual([
    { day: "2026-08-24", projectId: project.id, commits: 2, linesAdded: 5, linesRemoved: 1 },
  ]);
  for (const minute of [0, 1, 30]) {
    time.addPresence({ projectId: project.id, startedAt: at(DAY, 9, minute), endedAt: at(DAY, 9, minute + 1) });
  }
  expect(time.dailyPresence(DAY, DAY)).toEqual({ [DAY]: 3 * 60_000 });
  db.close();
});
