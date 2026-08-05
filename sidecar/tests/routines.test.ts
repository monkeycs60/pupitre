import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { MediaStore } from "../src/media";
import { QuotaTracker } from "../src/quotas";
import { nextCronDate, RoutineScheduler, RoutineStore } from "../src/routines";
import { ConversationRunner } from "../src/runner";
import { ConversationStore } from "../src/stores/conversations";
import { NotificationStore } from "../src/stores/notifications";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";
import { WorkflowStore } from "../src/stores/workflows";

let db: Database;
let projects: ProjectStore;
let projectId: string;
let routines: RoutineStore;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-routines-"));
  const projectPath = join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  db = openDb(join(dir, "data"));
  projects = new ProjectStore(db);
  projectId = projects.create({ name: "Demo", path: projectPath }).id;
  routines = new RoutineStore(db);
  process.env.PUPITRE_CLAUDE_BIN = join(import.meta.dir, "fake-bins/fake-claude");
});

test("calcule le prochain passage d'un cron cinq champs", () => {
  expect(nextCronDate("*/15 * * * *", new Date("2026-08-05T10:07:25Z")).toISOString())
    .toBe("2026-08-05T10:15:00.000Z");
  expect(nextCronDate("0 9 * * 1-5", new Date("2026-08-07T10:00:00Z")).toISOString())
    .toBe("2026-08-10T09:00:00.000Z");
  expect(nextCronDate("0 9 10 * 2", new Date("2026-08-05T10:00:00Z")).toISOString())
    .toBe("2026-08-10T09:00:00.000Z");
  expect(() => nextCronDate("* * *", new Date())).toThrow(/cinq champs/);
  expect(() => nextCronDate("70 * * * *", new Date())).toThrow(/plage/);
});

test("le scheduler lance une conversation normale taguée et notifie la fin", async () => {
  const conversations = new ConversationStore(db);
  const notifications = new NotificationStore(db);
  const presets = new PresetStore(db);
  const workflows = new WorkflowStore(db);
  const runner = new ConversationRunner(
    conversations,
    projects,
    new MediaStore(join(tmpdir(), `pupitre-routine-media-${crypto.randomUUID()}`)),
    () => {},
    new QuotaTracker(db),
    () => 4321,
  );
  const scheduler = new RoutineScheduler(
    routines, workflows, presets, projects, conversations, runner, notifications,
  );
  const routine = routines.save({
    projectId,
    name: "Bilan minute",
    schedule: "* * * * *",
    workflowId: null,
    prompt: "Prépare le bilan.",
    presetId: null,
    provider: "claude",
    model: "haiku",
    effort: "low",
    speed: null,
    orchestrator: false,
    enabled: true,
  });
  const now = new Date("2026-08-05T12:00:00Z");
  db.query("UPDATE routines SET next_run_at = ? WHERE id = ?")
    .run(new Date(now.getTime() - 60_000).toISOString(), routine.id);

  await scheduler.tick(now);

  const run = routines.runs(routine.id)[0];
  expect(run).toMatchObject({ status: "done", error: null });
  expect(run?.tokens).toBeGreaterThan(0);
  expect(run?.conversation_id).toBeString();
  expect(conversations.get(run!.conversation_id!)).toMatchObject({
    routine_id: routine.id,
  });
  expect(notifications.listAfter(0)[0]).toMatchObject({
    kind: "routine",
    title: "Routine terminée · Bilan minute",
    conversation_id: run?.conversation_id,
  });
});
