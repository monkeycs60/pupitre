import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db";
import { TimeTrackingService, MILESTONE_HOURS, intersect, merge } from "../src/time-tracking";
import { GitProjectService } from "../src/git";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

const HOUR = 3_600_000;

function at(minutes: number): string {
  return new Date(Date.UTC(2026, 7, 24, 9, 0, 0) + minutes * 60_000).toISOString();
}

function span(from: number, to: number) {
  return { start: Date.parse(at(from)), end: Date.parse(at(to)) };
}

test("les intervalles contigus fusionnent, les disjoints restent séparés", () => {
  expect(merge([span(0, 10), span(10, 20)])).toEqual([span(0, 20)]);
  expect(merge([span(0, 10), span(9, 20)])).toEqual([span(0, 20)]);
  expect(merge([span(0, 10), span(30, 40)])).toEqual([span(0, 10), span(30, 40)]);
  // Les flushs de l'UI arrivent en tranches : elles doivent se recoller.
  expect(merge([span(0, 5), span(5, 10), span(10, 15)])).toEqual([span(0, 15)]);
  expect(merge([])).toEqual([]);
});

test("l'intersection isole les minutes de supervision", () => {
  // Présence 0→47, tour 12→18 : six minutes passées à regarder tourner.
  expect(intersect([span(0, 47)], [span(12, 18)])).toEqual([span(12, 18)]);
  // Le tour déborde de la présence : seule la partie commune compte.
  expect(intersect([span(40, 52)], [span(40, 58)])).toEqual([span(40, 52)]);
  expect(intersect([span(0, 10)], [span(20, 30)])).toEqual([]);
});

/** L'UI envoie des tranches courtes ; les tests font pareil. */
function presence(service: TimeTrackingService, projectId: string, from: number, to: number) {
  for (let cursor = from; cursor < to; cursor += 25) {
    service.addPresence({
      projectId,
      startedAt: at(cursor),
      endedAt: at(Math.min(cursor + 25, to)),
    });
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-time-"));
  const db = openDb(dir);
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "Test", path: dir });
  const conversations = new ConversationStore(db);
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    firstMessage: "Ajouter une feature",
  });
  const service = new TimeTrackingService(db, projects, new GitProjectService(db, projects));
  return { dir, db, projects, project, conversations, conversation, service };
}

test("une heure de présence vaut un niveau, les minutes remplissent la barre", () => {
  const { dir, db, project, service } = setup();
  try {
    presence(service, project.id, 0, 38);
    const first = service.snapshot(project.id);
    expect(first.user.level).toBe(0);
    expect(first.user.ms).toBe(38 * 60_000);
    expect(first.user.progress).toBeCloseTo(38 / 60, 5);

    presence(service, project.id, 60, 82);
    const second = service.snapshot(project.id);
    expect(second.user.ms).toBe(60 * 60_000);
    expect(second.user.level).toBe(1);
    expect(second.user.progress).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("les tranches successives d'un même moment ne comptent qu'une fois", () => {
  const { dir, db, project, service } = setup();
  try {
    for (let index = 0; index < 4; index += 1) {
      service.addPresence({ projectId: project.id, startedAt: at(index), endedAt: at(index + 1) });
    }
    // Rejeu d'une tranche déjà envoyée : le total ne doit pas doubler.
    service.addPresence({ projectId: project.id, startedAt: at(2), endedAt: at(3) });
    expect(service.snapshot(project.id).user.ms).toBe(4 * 60_000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("l'horloge agent se reconstruit depuis les tours et ne compte pas dans le niveau", () => {
  const { dir, db, project, conversations, conversation, service } = setup();
  try {
    conversations.appendEvent(conversation.id, {
      type: "turn-timing", phase: "completed", startedAt: at(12), completedAt: at(18),
    });
    presence(service, project.id, 0, 47);
    const snapshot = service.snapshot(project.id);
    expect(snapshot.user.ms).toBe(47 * 60_000);
    expect(snapshot.agent.ms).toBe(6 * 60_000);
    expect(snapshot.supervisionMs).toBe(6 * 60_000);
    expect(snapshot.writingMs).toBe(41 * 60_000);
    expect(snapshot.agentAloneMs).toBe(0);

    // Idempotence : deux lectures ne dupliquent pas le segment agent.
    expect(service.snapshot(project.id).agent.ms).toBe(6 * 60_000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("un tour joué hors présence gonfle l'agent seul, jamais le niveau", () => {
  const { dir, db, project, conversations, conversation, service } = setup();
  try {
    conversations.appendEvent(conversation.id, {
      type: "turn-timing", phase: "completed", startedAt: at(80), completedAt: at(91),
    });
    presence(service, project.id, 0, 47);
    const snapshot = service.snapshot(project.id);
    expect(snapshot.user.ms).toBe(47 * 60_000);
    expect(snapshot.agentAloneMs).toBe(11 * 60_000);
    expect(snapshot.supervisionMs).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("le temps d'un tour est la présence pendant ce tour, pas sa durée", () => {
  const { dir, db, project, conversations, conversation, service } = setup();
  try {
    conversations.appendEvent(conversation.id, {
      type: "turn-timing", phase: "completed", startedAt: at(40), completedAt: at(58),
    });
    // Présent sur les douze premières minutes du tour seulement.
    presence(service, project.id, 30, 52);
    const turns = service.conversationTurns(conversation.id);
    expect(turns[at(40)]).toBe(12 * 60_000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("la portée globale additionne les projets et garde chacun détaillé", () => {
  const { dir, db, projects, project, service } = setup();
  try {
    const other = projects.create({ name: "Autre", path: join(dir, "autre") });
    // Une personne n'est présente que sur un projet à la fois : les tranches
    // ne se chevauchent jamais entre projets, et le global les additionne.
    presence(service, project.id, 0, 90);
    presence(service, other.id, 90, 120);
    const global = service.snapshot();
    expect(global.scope).toBe("global");
    expect(global.user.ms).toBe(120 * 60_000);
    expect(global.user.level).toBe(2);
    expect(global.projectCount).toBe(2);
    expect(global.projects.map((entry) => entry.user.ms)).toEqual([90 * 60_000, 30 * 60_000]);
    expect(service.snapshot(project.id).user.ms).toBe(90 * 60_000);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("le palier suivant est le premier seuil non franchi", () => {
  const { dir, db, project, service } = setup();
  try {
    expect(MILESTONE_HOURS[0]).toBe(10);
    presence(service, project.id, 0, 12 * 60);
    const snapshot = service.snapshot(project.id);
    expect(snapshot.user.ms).toBe(12 * HOUR);
    expect(snapshot.nextMilestone).toBe(25);
    expect(snapshot.msToNextMilestone).toBe(13 * HOUR);
    expect(snapshot.milestones.find((step) => step.hours === 10)?.reached).toBe(true);
    expect(snapshot.milestones.find((step) => step.hours === 25)?.reached).toBe(false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("une tranche aberrante est refusée plutôt que stockée", () => {
  const { dir, db, project, service } = setup();
  try {
    expect(() => service.addPresence({
      projectId: project.id, startedAt: at(10), endedAt: at(5),
    })).toThrow();
    expect(() => service.addPresence({
      projectId: project.id, startedAt: at(0), endedAt: at(31),
    })).toThrow();
    expect(service.snapshot(project.id).user.ms).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
