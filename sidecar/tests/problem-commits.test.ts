import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { problemIdsInCommit } from "../src/problems";
import { ProblemStore } from "../src/stores/problems";
import { ProjectStore } from "../src/stores/projects";

test("reconnaît uniquement les marqueurs PB exacts et sans doublon", () => {
  expect(problemIdsInCommit("fix [PB-7K3M9Q] et [PB-ABC123]\n\nRefs [PB-7K3M9Q]")).toEqual([
    "PB-7K3M9Q",
    "PB-ABC123",
  ]);
  expect(problemIdsInCommit("PB-7K3M9Q [PB-OOOOOO] [PB-ABC12] [pb-ABC123]")).toEqual([]);
});

test("ferme chaque problématique du même projet une seule fois", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-problem-commits-")));
  const projects = new ProjectStore(db);
  const firstProject = projects.create({ name: "Premier", path: `/tmp/first-${crypto.randomUUID()}` });
  const otherProject = projects.create({ name: "Autre", path: `/tmp/other-${crypto.randomUUID()}` });
  const store = new ProblemStore(db);
  const createProblem = (projectId: string, publicId: string) => {
    const capture = store.createCapture(projectId, "source");
    store.completeCapture(capture.id, [{
      publicId,
      title: "Titre",
      context: "Contexte",
      resolution: "Résolution",
      ticketId: null,
      plans: [{ title: "Traiter", instruction: "Faire le travail." }],
    }]);
  };
  createProblem(firstProject.id, "PB-7K3M9Q");
  createProblem(firstProject.id, "PB-ABC123");
  createProblem(otherProject.id, "PB-DEF456");

  expect(store.closeFromCommit(
    firstProject.id,
    "fix: résoudre [PB-7K3M9Q] et [PB-ABC123] sans toucher [PB-DEF456]",
    "abc123",
  )).toBe(2);
  expect(store.closeFromCommit(firstProject.id, "fix [PB-7K3M9Q]", "abc123")).toBe(0);
  expect(store.getByPublicId("PB-7K3M9Q")).toMatchObject({ status: "closed", closed_commit_sha: "abc123" });
  expect(store.getByPublicId("PB-DEF456")?.status).toBe("open");
});
