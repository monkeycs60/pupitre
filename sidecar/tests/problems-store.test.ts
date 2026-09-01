import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProblemStore } from "../src/stores/problems";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";

let db: Database;
let projects: ProjectStore;
let tickets: TicketStore;
let store: ProblemStore;
let projectId: string;

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-problems-store-")));
  projects = new ProjectStore(db);
  tickets = new TicketStore(db);
  store = new ProblemStore(db);
  projectId = projects.create({ name: "Pupitre", path: `/tmp/pupitre-${crypto.randomUUID()}` }).id;
});

test("persiste le collage avant ses résultats puis écrit le lot atomiquement", () => {
  const capture = store.createCapture(projectId, "Bug A et retour B");

  expect(store.queuedCaptures().map(({ id }) => id)).toEqual([capture.id]);
  expect(store.getCapture(capture.id)).toMatchObject({
    project_id: projectId,
    raw_text: "Bug A et retour B",
    status: "queued",
  });

  store.completeCapture(capture.id, [{
    publicId: "PB-7K3M9Q",
    title: "Bug A",
    context: "Le bouton ne répond pas.",
    resolution: "Corriger le gestionnaire de clic.",
    ticketId: null,
    plans: [{ title: "Corriger le bug", instruction: "Diagnostiquer puis corriger." }],
  }]);

  expect(store.getCapture(capture.id)?.status).toBe("done");
  expect(store.listProject(projectId, "open").problems).toEqual([
    expect.objectContaining({
      public_id: "PB-7K3M9Q",
      status: "open",
      conversation_count: 0,
      progress_status: "open",
      axis_states: [expect.objectContaining({ plan_index: 0, status: "pending" })],
      plans: [{ title: "Corriger le bug", instruction: "Diagnostiquer puis corriger." }],
    }),
  ]);

  const now = new Date().toISOString();
  db.query(`
    INSERT INTO conversations
      (id, project_id, title, summary, provider, model, origin_type, origin_key, created_at, updated_at)
    VALUES (?, ?, ?, '', 'codex', 'gpt-5.6', 'problem', 'PB-7K3M9Q', ?, ?)
  `).run(crypto.randomUUID(), projectId, "Conversation problème", now, now);

  expect(store.listProject(projectId, "open").problems[0]?.conversation_count).toBe(1);
});

test("expose le ticket et sa branche dans le contexte de reprise", () => {
  const ticket = tickets.upsert(projectId, {
    key: "TECH-42",
    source: "clickup",
    title: "Mesurer Match AI",
    status: "todo",
    externalUrl: null,
  });
  tickets.upsertRef(ticket.id, {
    kind: "branch",
    ref: "feature/TECH-42-match-ai",
    payload: {},
  });
  const capture = store.createCapture(projectId, "Mesure Match AI");
  store.completeCapture(capture.id, [{
    publicId: "PB-MATCH1",
    title: "Prouver la valeur de Match AI",
    context: "Relier les recommandations aux partenariats.",
    resolution: "Mesurer le cycle complet.",
    ticketId: ticket.id,
    plans: [{ title: "Instrumenter", instruction: "Ajouter les événements." }],
  }]);

  expect(store.listProject(projectId).problems[0]).toMatchObject({
    ticket_key: "TECH-42",
    ticket_title: "Mesurer Match AI",
    ticket_branch: "feature/TECH-42-match-ai",
  });
});

test("une écriture de lot invalide ne termine pas la capture à moitié", () => {
  const capture = store.createCapture(projectId, "Deux résultats");

  expect(() => store.completeCapture(capture.id, [{
    publicId: "PB-7K3M9Q",
    title: "Premier",
    context: "Contexte",
    resolution: "Résolution",
    ticketId: "ticket-inconnu",
    plans: [{ title: "Traiter", instruction: "Faire le travail." }],
  }])).toThrow();

  expect(store.getCapture(capture.id)?.status).toBe("queued");
  expect(store.listProject(projectId, "all").problems).toEqual([]);
});

test("ferme, rouvre, change le ticket du même projet et supprime", () => {
  const capture = store.createCapture(projectId, "Un résultat");
  store.completeCapture(capture.id, [{
    publicId: "PB-ABC123",
    title: "Titre",
    context: "Contexte",
    resolution: "Résolution",
    ticketId: null,
    plans: [{ title: "Traiter", instruction: "Faire le travail." }],
  }]);
  const problem = store.listProject(projectId, "open").problems[0]!;
  const ticket = tickets.upsert(projectId, {
    key: "TECH-42",
    source: "clickup",
    title: "Ticket lié",
    status: "todo",
    externalUrl: "https://app.clickup.com/t/TECH-42",
  });

  expect(store.setTicket(problem.id, ticket.id)?.ticket_id).toBe(ticket.id);
  expect(store.close(problem.id, "abc123")?.status).toBe("closed");
  expect(store.close(problem.id, "autre-sha")?.closed_commit_sha).toBe("abc123");
  expect(store.listProject(projectId, "open").problems).toHaveLength(0);
  expect(store.reopen(problem.id)).toMatchObject({ status: "open", closed_at: null, closed_commit_sha: null });
  expect(store.delete(problem.id)).toBe(true);
  expect(store.get(problem.id)).toBeNull();
});

test("refuse le ticket d'un autre projet et expose les erreurs relançables", () => {
  const otherProject = projects.create({ name: "Autre", path: `/tmp/autre-${crypto.randomUUID()}` });
  const foreignTicket = tickets.upsert(otherProject.id, {
    key: "OTHER-1",
    source: "clickup",
    title: "Étranger",
    status: "todo",
    externalUrl: null,
  });
  const capture = store.createCapture(projectId, "À retraiter");
  store.markError(capture.id, "sortie Luna invalide");
  const problemCapture = store.createCapture(projectId, "Problème sans ticket");
  store.completeCapture(problemCapture.id, [{
    publicId: "PB-DEF456",
    title: "Titre",
    context: "Contexte",
    resolution: "Résolution",
    ticketId: null,
    plans: [{ title: "Traiter", instruction: "Faire le travail." }],
  }]);
  const problem = store.listProject(projectId, "open").problems[0]!;

  expect(() => store.setTicket(problem.id, foreignTicket.id)).toThrow("ticket d'un autre projet");
  expect(store.listProject(projectId, "open").captures).toEqual([
    expect.objectContaining({ id: capture.id, status: "error", error: "sortie Luna invalide" }),
  ]);
  expect(store.queueAgain(capture.id)?.status).toBe("queued");
});
