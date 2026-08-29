import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ConversationStore } from "../src/stores/conversations";
import { ProblemMissionStore } from "../src/stores/problem-missions";
import { ProblemStore } from "../src/stores/problems";
import { ProjectStore } from "../src/stores/projects";

let db: Database;
let projectId: string;
let problemStore: ProblemStore;
let missions: ProblemMissionStore;
let conversationId: string;

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-problem-missions-")));
  const projects = new ProjectStore(db);
  projectId = projects.create({ name: "Pupitre", path: `/tmp/pupitre-${crypto.randomUUID()}` }).id;
  problemStore = new ProblemStore(db);
  const capture = problemStore.createCapture(projectId, "Deux problématiques");
  problemStore.completeCapture(capture.id, [
    { publicId: "PB-ONE111", ticketId: null, title: "Première", context: "A", resolution: "A fini", plans: [{ title: "Axe A", instruction: "Faire A" }] },
    { publicId: "PB-TWO222", ticketId: null, title: "Deuxième", context: "B", resolution: "B fini", plans: [{ title: "Axe B", instruction: "Faire B" }] },
  ]);
  conversationId = new ConversationStore(db).create({
    projectId,
    provider: "codex",
    model: "gpt-5.6",
    firstMessage: "Lancer la mission",
  }).id;
  missions = new ProblemMissionStore(db);
});

test("crée une mission liée à sa conversation et calcule son avancement", () => {
  const problems = problemStore.listProject(projectId).problems;
  const mission = missions.create({
    projectId,
    conversationId,
    title: "Prouver Match AI",
    problemIds: problems.map((problem) => problem.id),
  });

  expect(mission.public_id).toMatch(/^MS-[0-9A-Z]{6}$/);
  expect(mission).toMatchObject({
    project_id: projectId,
    conversation_id: conversationId,
    title: "Prouver Match AI",
    status: "open",
    closed_count: 0,
    problem_count: 2,
  });
  expect(missions.getByConversation(conversationId)?.problem_ids.sort()).toEqual(
    problems.map((problem) => problem.id).sort(),
  );
  expect(problemStore.listProject(projectId).problems.map((problem) => problem.conversation_count)).toEqual([1, 1]);

  problemStore.close(problems[0]!.id);
  expect(missions.get(mission.id)).toMatchObject({ status: "open", closed_count: 1 });
  problemStore.close(problems[1]!.id);
  expect(missions.get(mission.id)).toMatchObject({ status: "closed", closed_count: 2 });
});

test("refuse les doublons, les problèmes étrangers et ne laisse aucun lot partiel", () => {
  const problem = problemStore.listProject(projectId).problems[0]!;
  expect(() => missions.create({
    projectId,
    conversationId,
    title: "Doublon",
    problemIds: [problem.id, problem.id],
  })).toThrow("distinctes");
  expect(missions.listProject(projectId)).toEqual([]);
});
