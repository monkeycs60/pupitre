import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  ActivityJournal,
  ActivityReportService,
  ActivityBusyError,
  DEFAULT_ACTIVITY_MODEL,
  motifTaskMessage,
  type JournalProject,
} from "../src/activity-report";
import {
  MIN_MOTIF_EVIDENCE,
  RETRO_CONVERSATION_CHARS,
  applyRetroOperations,
  boundedTranscript,
  knownRefsFor,
  parseRetroOperations,
  retroPrompt,
} from "../src/activity-retro";
import type { DebriefGenerationInput } from "../src/debriefs";
import { GitProjectService } from "../src/git";
import { QuotaTracker } from "../src/quotas";
import { ActivityStore } from "../src/stores/activity";
import { ChangelogStore } from "../src/stores/changelog";
import { ConversationStore } from "../src/stores/conversations";
import { PresetStore } from "../src/stores/presets";
import { ProblemStore } from "../src/stores/problems";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";
import { TodoStore } from "../src/stores/todos";
import { TimeTrackingService } from "../src/time-tracking";
import { TodoService } from "../src/todos";

const DAY = "2026-08-24";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function at(day: string, hour: number, minute = 0): string {
  const date = new Date(`${day}T00:00:00`);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-activity-retro-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "Pupitre", path: dir });
  const conversations = new ConversationStore(db);
  const changelog = new ChangelogStore(db);
  const tickets = new TicketStore(db);
  const todoStore = new TodoStore(db);
  const presets = new PresetStore(db);
  const problems = new ProblemStore(db);
  const time = new TimeTrackingService(db, projects, new GitProjectService(db, projects));
  const journal = new ActivityJournal(db, projects, changelog, time, tickets, todoStore);
  const todos = new TodoService(
    todoStore, projects, conversations,
    { isRunning: () => false, runTurn: async () => ({ state: "done" as const, cancelled: false }) },
    new GitProjectService(db, projects, { worktreeRoot: join(dir, "worktrees") }),
    tickets, new QuotaTracker(db),
  );
  const store = new ActivityStore(db);
  const strongCalls: DebriefGenerationInput[] = [];
  let strongReply: (input: DebriefGenerationInput) => string = () => JSON.stringify({ operations: [] });
  let cheapReply: unknown = null;
  const clock = { now: new Date(`${DAY}T18:00:00`) };
  const service = new ActivityReportService(
    store, journal, projects, problems, todos, conversations, presets, time, changelog,
    async () => cheapReply,
    async (input) => {
      strongCalls.push(input);
      return strongReply(input);
    },
    () => DEFAULT_ACTIVITY_MODEL,
    () => new Date(clock.now),
  );
  const insertEvent = (conversationId: string, payload: unknown, createdAt: string) => {
    db.query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
      .run(conversationId, JSON.stringify(payload), createdAt);
  };
  const seedDay = () => {
    const first = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-5.6-sol", firstMessage: "Sidecar périmé" });
    const second = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-5.6-sol", firstMessage: "Encore le sidecar" });
    insertEvent(first.id, { type: "user-message", text: "Le sidecar ne répond plus" }, at(DAY, 9));
    insertEvent(first.id, { type: "text-final", text: "Je relance." }, at(DAY, 9, 3));
    insertEvent(second.id, { type: "user-message", text: "Latence de 124 secondes" }, at(DAY, 11));
    changelog.import(project.id, [
      { repositoryPath: ".", sha: SHA, branch: "master", subject: "fix: garde-fou frontendAt", committedAt: `${DAY}T12:00:00+02:00` },
    ], at(DAY, 12));
    return { first, second };
  };
  return {
    db, dir, project, projects, conversations, changelog, tickets, todoStore, todos, presets, store, service, journal,
    strongCalls, setStrong: (reply: typeof strongReply) => { strongReply = reply; },
    setCheap: (reply: unknown) => { cheapReply = reply; }, clock, insertEvent, seedDay,
  };
}

function journalProject(overrides: Partial<JournalProject> = {}): JournalProject {
  return {
    projectId: "p", projectName: "Pupitre", cwd: "/tmp/p", userMs: 0, agentMs: 0,
    conversations: [], commits: [], unlinkedCommitCount: 0, linesAdded: 0, linesRemoved: 0, tickets: [], mergeRequests: [], ticketsReady: [], todosDone: [],
    ...overrides,
  };
}

test("une transcription trop longue garde le début et la fin", () => {
  const events = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1, type: "user-message" as const, text: `message ${index} ${"x".repeat(1_000)}`, images: [],
  }));
  const transcript = boundedTranscript(events, RETRO_CONVERSATION_CHARS);
  expect(transcript.length).toBeLessThan(RETRO_CONVERSATION_CHARS + 120);
  expect(transcript.startsWith("Utilisateur :\nmessage 0")).toBe(true);
  expect(transcript).toContain("message 39");
  expect(transcript).toContain("caractères coupés");
  expect(boundedTranscript(events.slice(0, 2), RETRO_CONVERSATION_CHARS)).not.toContain("coupés");
});

test("le prompt de recul ne porte que l'état et la matière du jour, bornée par projet", () => {
  const project = journalProject({
    conversations: Array.from({ length: 8 }, (_, index) => ({
      id: `c${index}`, projectId: "p", title: `Conversation ${index}`, summary: "", ticketId: null, ticketKey: null,
      startedDay: DAY, userMs: (8 - index) * 60_000, agentMs: 0, turns: 1,
      events: Array.from({ length: 12 }, (_, turn) => ({ id: index * 100 + turn, type: "user-message" as const, text: "y".repeat(4_000), images: [] })),
    })),
    commits: [{ sha: SHA, repositoryPath: ".", branch: "master", subject: "fix", productMessage: null, linesAdded: 3, linesRemoved: 1, committedAt: `${DAY}T12:00:00Z`, conversationId: null }],
  });
  const prompt = retroPrompt(project, DAY, [], []);
  expect(prompt.length).toBeLessThan(200_000);
  expect(prompt).toContain("budget du jour épuisé");
  expect(prompt).toContain(`MATIÈRE DU ${DAY}`);
  expect(prompt).toContain(SHA);
  expect(prompt).toContain("ÉTAT : []");
});

test("les opérations sont filtrées : identifiants inconnus, preuves insuffisantes, motif inconnu", () => {
  const project = journalProject({
    conversations: [{ id: "c1", projectId: "p", title: "Un", summary: "", ticketId: null, ticketKey: null, startedDay: DAY, userMs: 0, agentMs: 0, turns: 1, events: [] }],
    commits: [{ sha: SHA, repositoryPath: ".", branch: "master", subject: "fix", productMessage: "Garde-fou", linesAdded: 1, linesRemoved: 0, committedAt: `${DAY}T12:00:00Z`, conversationId: null }],
  });
  const known = knownRefsFor(project, []);
  const raw = JSON.stringify({ operations: [
    { op: "create", kind: "recurrence", title: "Valide", statement: "Constat.", evidence: [{ kind: "conversation", ref: "c1" }, { kind: "commit", ref: SHA }, { kind: "conversation", ref: "c1" }] },
    { op: "create", kind: "recurrence", title: "Inventé", statement: "Constat.", evidence: [{ kind: "conversation", ref: "c1" }, { kind: "conversation", ref: "fantôme" }] },
    { op: "create", kind: "bizarre", title: "Type inconnu", statement: "Constat.", evidence: [{ kind: "conversation", ref: "c1" }, { kind: "commit", ref: SHA }] },
    { op: "update", id: "motif-inconnu", evidence: [{ kind: "commit", ref: SHA }] },
    { op: "stabilize", id: "m1", evidence: [{ kind: "conversation", ref: "c1" }] },
    { op: "stabilize", id: "m1", evidence: [{ kind: "commit", ref: SHA }] },
    { op: "update", id: "m1", statement: "  ", evidence: [{ kind: "conversation", ref: "c1" }] },
  ] });
  const motif = { id: "m1", evidence: [] } as unknown as Parameters<typeof parseRetroOperations>[2][number];
  const operations = parseRetroOperations(raw, known, [motif]);
  expect(operations).toEqual([
    { op: "create", kind: "recurrence", title: "Valide", statement: "Constat.", evidence: [
      { kind: "conversation", ref: "c1", label: "Un" }, { kind: "commit", ref: SHA, label: "Garde-fou" },
    ] },
    { op: "stabilize", id: "m1", evidence: [{ kind: "commit", ref: SHA, label: "Garde-fou" }] },
    { op: "update", id: "m1", statement: null, evidence: [{ kind: "conversation", ref: "c1", label: "Un" }] },
  ]);
  expect(MIN_MOTIF_EVIDENCE).toBe(2);
  expect(() => parseRetroOperations("pas du JSON", known, [])).toThrow(/illisible/);
});

test("un motif écarté revient seulement avec une preuve nouvelle ; un commit lié le stabilise", () => {
  const { db, project, store } = setup();
  const now = at(DAY, 18);
  const motif = store.createMotif({
    projectId: project.id, kind: "recurrence", title: "Sidecar périmé", statement: "Ça revient.", day: "2026-08-20",
    evidence: [{ kind: "conversation", ref: "c1", label: "Un" }, { kind: "conversation", ref: "c2", label: "Deux" }],
  }, at("2026-08-20", 18));
  store.updateMotif(motif.id, { status: "dismissed", dismissed_at: at("2026-08-21", 9) }, at("2026-08-21", 9));

  const unchanged = applyRetroOperations(store, project.id, DAY, [
    { op: "update", id: motif.id, statement: "Rien de neuf", evidence: [{ kind: "conversation", ref: "c1", label: "Un" }] },
  ], now);
  expect(unchanged).toEqual({ created: [], updated: [], stabilized: [], returned: [] });
  expect(store.motif(motif.id)!.status).toBe("dismissed");

  const returned = applyRetroOperations(store, project.id, DAY, [
    { op: "update", id: motif.id, statement: "Encore aujourd'hui.", evidence: [{ kind: "conversation", ref: "c3", label: "Trois" }] },
  ], now);
  expect(returned.returned).toEqual([motif.id]);
  const back = store.motif(motif.id)!;
  expect(back.status).toBe("open");
  expect(back.returned_at).toBe(now);
  expect(back.statement).toBe("Encore aujourd'hui.");
  expect(back.evidence.filter((item) => item.created_at > back.dismissed_at!).map((item) => item.ref)).toEqual(["c3"]);

  const stabilized = applyRetroOperations(store, project.id, DAY, [
    { op: "stabilize", id: motif.id, evidence: [{ kind: "commit", ref: SHA, label: "fix" }] },
  ], now);
  expect(stabilized.stabilized).toEqual([motif.id]);
  expect(store.motif(motif.id)!.status).toBe("stabilized");
  db.close();
});

test("la passe complète sauve le journal, crée les motifs prouvés et préserve les décisions à la relance", async () => {
  const context = setup();
  const { db, project, store, service, strongCalls, setStrong, setCheap, seedDay, clock } = context;
  const { first, second } = seedDay();
  setCheap({ topics: [{ title: "Sidecar périmé", detail: "Deux relances.", conversationIds: [first.id, second.id] }] });
  setStrong(() => JSON.stringify({ operations: [
    { op: "create", kind: "recurrence", title: "Le sidecar périmé revient", statement: "Deux conversations relancent le sidecar.", evidence: [
      { kind: "conversation", ref: first.id }, { kind: "conversation", ref: second.id },
    ] },
    { op: "create", kind: "idea", title: "Sans preuve", statement: "…", evidence: [{ kind: "conversation", ref: first.id }] },
  ] }));

  const report = await service.generate(DAY);
  expect(report).not.toBeNull();
  expect(report!.projects[0]!.topics[0]!.title).toBe("Sidecar périmé");
  expect(report!.projects[0]!.topicsSource).toBe("model");
  expect(report!.retro.created).toHaveLength(1);
  expect(report!.retro.error).toBeNull();
  expect(strongCalls).toHaveLength(1);
  expect(strongCalls[0]).toEqual(expect.objectContaining({ cwd: project.path, provider: "codex", model: "gpt-5.6-luna", effort: "high" }));
  expect(strongCalls[0]!.prompt).toContain("Le sidecar ne répond plus");
  expect(store.days().map((item) => item.day)).toEqual([DAY]);
  expect(store.state()).toEqual(expect.objectContaining({ first_day: DAY, last_day: DAY, last_error: null }));
  const [motif] = store.listMotifs();
  expect(motif!.evidence).toHaveLength(2);

  service.dismiss(motif!.id);
  setStrong((input) => {
    expect(input.prompt).toContain(motif!.id);
    expect(input.prompt).toContain('"status":"dismissed"');
    return JSON.stringify({ operations: [{ op: "update", id: motif!.id, evidence: [{ kind: "conversation", ref: first.id }] }] });
  });
  clock.now = new Date(`${DAY}T22:00:00`);
  const regenerated = await service.generate(DAY);
  expect(regenerated!.generatedAt).not.toBe(report!.generatedAt);
  expect(regenerated!.retro).toEqual({ created: [], updated: [], stabilized: [], returned: [], error: null });
  expect(store.motif(motif!.id)!.status).toBe("dismissed");
  expect(store.listMotifs()).toHaveLength(1);
  expect(service.retro().motifs).toEqual([]);
  db.close();
});

test("le recul en échec n'empêche pas le journal, et une journée vide ne laisse rien", async () => {
  const { db, store, service, setStrong, seedDay } = setup();
  seedDay();
  setStrong(() => { throw new Error("modèle indisponible"); });
  const report = await service.generate(DAY);
  expect(report!.retro.error).toBe("Pupitre : modèle indisponible");
  expect(report!.projects[0]!.topicsSource).toBe("titles");
  expect(store.state().last_error).toBe("Pupitre : modèle indisponible");

  expect(await service.generate("2026-08-25")).toBeNull();
  expect(store.days().map((item) => item.day)).toEqual([DAY]);
  await expect(service.generate("2026-13-40")).rejects.toThrow(/jour invalide/);
  db.close();
});

test("deux passes ne se chevauchent pas", async () => {
  const { db, service, setStrong, seedDay } = setup();
  seedDay();
  let release: () => void = () => {};
  setStrong(() => { throw new Error("jamais"); });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  service["strong"] = async () => { await blocked; return JSON.stringify({ operations: [] }); };
  const running = service.generate(DAY);
  expect(service.runState()).toEqual(expect.objectContaining({ running: true, runningDay: DAY }));
  await expect(service.generate(DAY)).rejects.toBeInstanceOf(ActivityBusyError);
  release();
  await running;
  expect(service.runState().running).toBe(false);
  db.close();
});

test("créer une tâche depuis un motif produit un backlog avec le constat et les preuves, jamais en file", async () => {
  const { db, project, store, service, todoStore, tickets, presets } = setup();
  const ticket = tickets.upsert(project.id, { key: "TECH-9", source: "clickup", title: "Sidecar", status: "todo", externalUrl: null });
  const motif = store.createMotif({
    projectId: project.id, kind: "stabilize", title: "Stabiliser le redémarrage", statement: "Le sidecar périmé sert encore l'UI.", day: DAY,
    evidence: [
      { kind: "conversation", ref: "c1", label: "Latence 124 s" },
      { kind: "commit", ref: SHA, label: "fix: garde-fou" },
      { kind: "ticket", ref: ticket.id, label: "TECH-9 Sidecar" },
    ],
  }, at(DAY, 18));

  const { motif: handled, todo } = await service.createTask(motif.id, { provider: "claude", model: "opus", effort: "high", speed: "fast" });
  expect(todo.status).toBe("backlog");
  expect(todo.project_id).toBe(project.id);
  expect(todo.provider).toBe("claude");
  expect(todo.model).toBe("opus");
  expect(todo.ticket_id).toBe(ticket.id);
  expect(todo.title).toBe("Stabiliser le redémarrage");
  expect(todo.message).toBe(motifTaskMessage(motif));
  expect(todo.message).toContain("Le sidecar périmé sert encore l'UI.");
  expect(todo.message).toContain(`Commit ${SHA.slice(0, 7)} · fix: garde-fou`);
  expect(handled.status).toBe("handled");
  expect(handled.todo_id).toBe(todo.id);

  const again = await service.createTask(motif.id);
  expect(again.todo.id).toBe(todo.id);
  expect(todoStore.list(project.id)).toHaveLength(1);

  const preset = presets.create({ name: "Rapide", provider: "grok", model: "grok-4.6", effort: "low", speed: "fast" });
  const projects = new ProjectStore(db);
  projects.setDefaultTodoPreset(project.id, preset.id);
  const other = store.createMotif({
    projectId: project.id, kind: "idea", title: "Idée", statement: "Piste.", day: DAY,
    evidence: [{ kind: "conversation", ref: "c1", label: "Un" }, { kind: "conversation", ref: "c2", label: "Deux" }],
  }, at(DAY, 18));
  const fromPreset = await service.createTask(other.id, null);
  expect(fromPreset.todo).toEqual(expect.objectContaining({ provider: "grok", model: "grok-4.6", effort: "low", speed: "fast", ticket_id: null }));
  db.close();
});

test("le bilan cumulé et les tendances viennent du suivi de temps et du changelog", async () => {
  const { db, project, service, time, changelog } = (() => {
    const context = setup();
    return { ...context, time: context.journal["time"] as TimeTrackingService };
  })();
  for (let minute = 0; minute < 60; minute += 20) {
    time.addPresence({ projectId: project.id, startedAt: at(DAY, 9, minute), endedAt: at(DAY, 9, minute + 20) });
  }
  changelog.import(project.id, [
    { repositoryPath: ".", sha: SHA, branch: "master", subject: "a", committedAt: `${DAY}T12:00:00+02:00` },
    { repositoryPath: ".", sha: OTHER_SHA, branch: "master", subject: "b", committedAt: "2026-01-10T12:00:00+01:00" },
  ], at(DAY, 12));
  changelog.setLineStats(project.id, [{ sha: SHA, added: 10, removed: 4 }, { sha: OTHER_SHA, added: 100, removed: 50 }]);
  const retro = service.retro();
  expect(retro.cumulative).toEqual(expect.objectContaining({ userMs: 3_600_000, commits: 2, linesAdded: 110, linesRemoved: 54, activeDays: 1, firstDay: DAY }));
  expect(retro.trends.map((trend) => [trend.days, trend.userMs, trend.commits, trend.linesAdded])).toEqual([[7, 3_600_000, 1, 10], [30, 3_600_000, 1, 10]]);
  db.close();
});

test("le calendrier couvre seize semaines jusqu'à aujourd'hui, du lundi, avec commits, présence et rapport par jour", () => {
  const { db, project, changelog, service, seedDay, clock } = setup();
  seedDay();
  changelog.import(project.id, [
    { repositoryPath: ".", sha: "9".repeat(40), branch: "master", subject: "cal", committedAt: `${DAY}T10:00:00+02:00` },
  ], `${DAY}T12:00:00.000Z`);
  changelog.setLineStats(project.id, [{ sha: "9".repeat(40), added: 12, removed: 3 }]);
  clock.now = new Date(`${DAY}T18:00:00`);
  const calendar = service.calendar();
  expect(calendar.to).toBe(DAY);
  expect(new Date(`${calendar.from}T12:00:00`).getDay()).toBe(1);
  expect(calendar.days).toHaveLength(15 * 7 + ((new Date(`${DAY}T12:00:00`).getDay() + 6) % 7) + 1);
  expect(calendar.days[calendar.days.length - 1]).toEqual(expect.objectContaining({
    day: DAY, hasReport: false, linesAdded: 12, linesRemoved: 3,
    projects: [expect.objectContaining({ projectName: "Pupitre", commits: 2 })],
  }));
  expect(calendar.days[calendar.days.length - 1]!.commits).toBe(2);
  expect(calendar.days[0]!.commits).toBe(0);
  db.close();
});
