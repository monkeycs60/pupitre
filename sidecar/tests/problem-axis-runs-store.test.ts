import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProblemAxisRunStore, projectProblemProgress } from "../src/stores/problem-axis-runs";
import { ProblemStore } from "../src/stores/problems";
import { ProjectStore } from "../src/stores/projects";

let db: Database;
let problemId: string;
let runs: ProblemAxisRunStore;

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-axis-runs-")));
  const project = new ProjectStore(db).create({ name: "Pupitre", path: `/tmp/pupitre-${crypto.randomUUID()}` });
  const problems = new ProblemStore(db);
  const capture = problems.createCapture(project.id, "Deux axes");
  problemId = problems.completeCapture(capture.id, [{
    publicId: "PB-AXES01", ticketId: null, title: "Cycle", context: "C", resolution: "R",
    plans: [{ title: "A", instruction: "A" }, { title: "B", instruction: "B" }],
  }])[0]!.id;
  runs = new ProblemAxisRunStore(db);
});

test("projette les axes historiques puis leur cycle réel", () => {
  expect(runs.statesForProblem(problemId, 2).map((axis) => axis.status)).toEqual(["pending", "pending"]);
  const first = runs.create({ problemId, planIndex: 0 });
  expect(projectProblemProgress(runs.statesForProblem(problemId, 2))).toBe("running");
  runs.transition(first.id, "awaiting_validation");
  expect(projectProblemProgress(runs.statesForProblem(problemId, 2))).toBe("awaiting_validation");
  runs.transition(first.id, "completed");
  runs.transition(first.id, "failed", "tardif");
  expect(runs.get(first.id)?.status).toBe("completed");
});

test("un problème fermé sans exécution hydrate ses axes comme terminés", () => {
  expect(runs.statesForProblem(problemId, 2, true).map((axis) => axis.status)).toEqual(["completed", "completed"]);
  expect(() => runs.create({ problemId, planIndex: 2 })).toThrow("invalide");
});
