import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { progressFromDiff, reviewProgress, snapshotOf } from "../src/review-progress";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { ReviewCommentStore } from "../src/stores/review-comments";

const root = mkdtempSync(join(tmpdir(), "pupitre-review-progress-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("un hunk sur les lignes commentées vaut traité, ailleurs fichier modifié, aucun en attente", () => {
  const diff = "diff --git a/a.js b/a.js\n@@ -10,2 +10,3 @@\n-x\n-y\n+z\n";
  expect(progressFromDiff(diff, "new", 11, 11)).toBe("treated");
  expect(progressFromDiff(diff, "new", 30, 32)).toBe("file-changed");
  expect(progressFromDiff("@@ -5,0 +6,2 @@\n+a\n+b\n", "new", 6, 6)).toBe("treated");
  expect(progressFromDiff("", "new", 1, 1)).toBe("pending");
  expect(progressFromDiff(diff, "old", 11, 11)).toBe("file-changed");
});

test("suit chaque commentaire envoyé depuis l'état du worktree à l'envoi, non commité compris", async () => {
  const repository = join(root, "repo");
  const run = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repository });
  Bun.spawnSync(["mkdir", "-p", repository]);
  writeFileSync(join(repository, "a.js"), Array.from({ length: 20 }, (_, index) => `ligne ${index + 1}`).join("\n") + "\n");
  writeFileSync(join(repository, "b.js"), "b\n");
  run("init", "-q", "-b", "main");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  writeFileSync(join(repository, "a.js"), ["en tête non commité", ...Array.from({ length: 20 }, (_, index) => `ligne ${index + 1}`)].join("\n") + "\n");

  const db = openDb(join(root, "data"));
  const project = new ProjectStore(db).create({ name: "repo", path: repository });
  const conversation = new ConversationStore(db).create({ projectId: project.id, provider: "claude", model: "test", firstMessage: "Relire" });
  const store = new ReviewCommentStore(db);
  const anchor = { repositoryLabel: "repo", worktreePath: repository, side: "new" as const, lineText: "" };
  store.create(conversation.id, { ...anchor, path: "a.js", startLine: 3, endLine: 4, body: "Renomme." });
  store.create(conversation.id, { ...anchor, path: "a.js", startLine: 15, endLine: 15, body: "Et ici ?" });
  store.create(conversation.id, { ...anchor, path: "b.js", startLine: 1, endLine: 1, body: "Pas touché." });
  store.markSent(conversation.id, new Map([[repository, await snapshotOf(repository)]]));
  const progress = async () => Promise.all(store.list(conversation.id).map(reviewProgress));

  expect(await progress()).toEqual(["pending", "pending", "pending"]);

  const lines = ["en tête non commité", ...Array.from({ length: 20 }, (_, index) => `ligne ${index + 1}`)];
  lines[3] = "ligne 3 renommée";
  writeFileSync(join(repository, "a.js"), lines.join("\n") + "\n");
  run("commit", "-q", "-am", "traite le premier commentaire");

  expect(await progress()).toEqual(["treated", "file-changed", "pending"]);
});
