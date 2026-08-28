import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DebriefGenerationInput, DebriefGenerator } from "../src/debriefs";
import { openDb } from "../src/db";
import { ProblemService, parseProblemDrafts, problemPublicId } from "../src/problems";
import { ProblemStore } from "../src/stores/problems";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";

let db: Database;
let projects: ProjectStore;
let tickets: TicketStore;
let store: ProblemStore;
let projectId: string;

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-problems-service-")));
  projects = new ProjectStore(db);
  tickets = new TicketStore(db);
  store = new ProblemStore(db);
  projectId = projects.create({ name: "Pupitre", path: `/tmp/pupitre-${crypto.randomUUID()}` }).id;
});

function serviceWith(generator: DebriefGenerator): ProblemService {
  return new ProblemService(store, projects, tickets, generator);
}

test("sauvegarde puis traite une capture avec Luna medium fast", async () => {
  const ticket = tickets.upsert(projectId, {
    key: "TECH-42",
    source: "clickup",
    title: "Réparer le bouton",
    status: "todo",
    externalUrl: null,
  });
  const calls: DebriefGenerationInput[] = [];
  const service = serviceWith(async (input) => {
    calls.push(input);
    return JSON.stringify([
      {
        title: "Le bouton ne répond pas",
        context: "Le clic reste sans effet.",
        resolution: "Corriger le gestionnaire.",
        ticketKey: "TECH-42",
        conversations: [{ title: "Corriger le bouton", instruction: "Reproduire et corriger." }],
      },
      {
        title: "Clarifier la copie",
        context: "Le libellé est ambigu.",
        resolution: "Réécrire le texte.",
        ticketKey: "INVENTE-1",
        conversations: [{ title: "Réviser la copie", instruction: "Proposer un libellé clair." }],
      },
    ]);
  });

  const capture = service.capture(projectId, "deux sujets dans le même collage");
  expect(store.getCapture(capture.id)?.status).toBe("queued");
  await service.processCapture(capture.id);

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(expect.objectContaining({
    cwd: projects.get(projectId)!.path,
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    speed: "fast",
  }));
  expect(calls[0]?.prompt).toContain("TECH-42");
  expect(calls[0]?.prompt).toContain("deux sujets dans le même collage");
  const byTitle = new Map(store.listProject(projectId, "open").problems
    .map((problem) => [problem.title, problem]));
  expect(byTitle.get("Clarifier la copie")?.ticket_id).toBeNull();
  expect(byTitle.get("Le bouton ne répond pas")?.ticket_id).toBe(ticket.id);
});

test("une sortie invalide garde le texte et ne crée aucun résultat partiel", async () => {
  const service = serviceWith(async () => '[{"title":"incomplet"}]');
  const capture = service.capture(projectId, "texte conservé");

  await service.processCapture(capture.id);

  expect(store.getCapture(capture.id)).toMatchObject({
    status: "error",
    raw_text: "texte conservé",
  });
  expect(store.listProject(projectId, "all").problems).toEqual([]);
});

test("reprend au démarrage les captures en attente ou interrompues", async () => {
  const first = store.createCapture(projectId, "première");
  const interrupted = store.createCapture(projectId, "interrompue");
  store.markProcessing(interrupted.id);
  const seen: string[] = [];
  const service = serviceWith(async (input) => {
    seen.push(input.prompt);
    return JSON.stringify([{
      title: "Sujet",
      context: "Contexte",
      resolution: "Résolution",
      ticketKey: null,
      conversations: [{ title: "Traiter", instruction: "Faire le travail." }],
    }]);
  });

  await service.resume();

  expect(store.getCapture(first.id)?.status).toBe("done");
  expect(store.getCapture(interrupted.id)?.status).toBe("done");
  expect(seen).toHaveLength(2);
});

test("refuse un collage vide ou trop long avant de le persister", () => {
  const service = serviceWith(async () => "[]");

  expect(() => service.capture(projectId, "   ")).toThrow("texte vide");
  expect(() => service.capture(projectId, "a".repeat(50_001))).toThrow("50 000");
  expect(store.listProject(projectId, "all").captures).toEqual([]);
});

test("valide les bornes du JSON et produit des IDs lisibles", () => {
  const raw = JSON.stringify([{
    title: "  Titre  ",
    context: "Contexte",
    resolution: "Résolution",
    ticketKey: null,
    conversations: [{ title: "Plan", instruction: "Instruction" }],
  }]);

  expect(parseProblemDrafts(raw, [])).toEqual([
    expect.objectContaining({
      title: "Titre",
      ticketId: null,
      plans: [{ title: "Plan", instruction: "Instruction" }],
    }),
  ]);
  expect(problemPublicId(() => 0)).toBe("PB-000000");
  expect(() => parseProblemDrafts("[]", [])).toThrow("entre 1 et 20");
});
