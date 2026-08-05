import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { fleetSnapshot } from "../src/fleet";
import { MediaStore } from "../src/media";
import { QuotaTracker } from "../src/quotas";
import { ConversationRunner } from "../src/runner";
import { RoutineStore } from "../src/routines";
import { SubtaskRunner } from "../src/subtasks";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

let db: Database;
let projects: ProjectStore;
let conversations: ConversationStore;
let runner: ConversationRunner;
let subtasks: SubtaskRunner;
let routines: RoutineStore;
let projectId: string;
let previousClaudeBin: string | undefined;

beforeEach(() => {
  previousClaudeBin = process.env.PUPITRE_CLAUDE_BIN;
  const dir = mkdtempSync(join(tmpdir(), "pupitre-fleet-"));
  const projectPath = join(dir, "project");
  mkdirSync(projectPath);
  db = openDb(join(dir, "data"));
  projects = new ProjectStore(db);
  projectId = projects.create({ name: "Fleet demo", path: projectPath }).id;
  conversations = new ConversationStore(db);
  const quotas = new QuotaTracker(db);
  runner = new ConversationRunner(
    conversations,
    projects,
    new MediaStore(join(dir, "media")),
    () => {},
    quotas,
    () => 4321,
  );
  subtasks = new SubtaskRunner(db, conversations, projects, () => {}, quotas);
  routines = new RoutineStore(db);
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude");
});

afterEach(() => {
  db.close();
  if (previousClaudeBin === undefined) delete process.env.PUPITRE_CLAUDE_BIN;
  else process.env.PUPITRE_CLAUDE_BIN = previousClaudeBin;
});

test("agrège les tours et sous-tâches actifs de tous les projets", async () => {
  const conversation = conversations.create({
    projectId,
    provider: "claude",
    model: "haiku",
    firstMessage: "Tour principal",
  });
  const turn = runner.runTurn(conversation.id, "attends", []);
  const subtask = subtasks.start({
    conversationId: conversation.id,
    provider: "claude",
    model: "haiku",
    prompt: "attends aussi",
    label: "Lecture parallèle",
  });

  expect(fleetSnapshot({ runner, subtasks, conversations, projects, routineStore: routines }))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "turn", conversationId: conversation.id, projectName: "Fleet demo" }),
      expect.objectContaining({ kind: "subtask", id: `subtask:${subtask.id}`, title: "Lecture parallèle" }),
    ]));

  await Promise.all([turn, subtasks.waitResult(subtask.id)]);
  expect(fleetSnapshot({ runner, subtasks, conversations, projects, routineStore: routines })).toEqual([]);
});
