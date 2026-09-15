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
  parseTopics,
  toReportProject,
  topicsPrompt,
} from "../src/activity-report";
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
