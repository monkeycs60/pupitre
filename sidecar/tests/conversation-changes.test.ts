import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationChanges } from "../src/conversation-changes";
import { writeRevision, type EditorWorkspacePlan } from "../src/editor-workspace";

const root = mkdtempSync(join(tmpdir(), "pupitre-changes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const repository = join(root, "app");
mkdirSync(join(repository, "lib"), { recursive: true });
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const commitAll = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};
writeFileSync(join(repository, "lib/gate.js"), "a\nb\nc\n");
writeFileSync(join(repository, "lib/old.js"), "ancien\ncontenu\n");
git("init", "-q", "-b", "main");
commitAll("init");
writeFileSync(join(repository, "lib/gate.js"), "a\nB\nc\n");
const first = commitAll("gate");
writeFileSync(join(repository, "lib/other.js"), "autre conversation\n");
const foreign = commitAll("travail d'une autre conversation");
rmSync(join(repository, "lib/old.js"));
writeFileSync(join(repository, "lib/new.js"), "neuf\n");
const second = commitAll("ménage");
writeFileSync(join(repository, "lib/gate.js"), "a\nB\nC\n");
writeFileSync(join(repository, "lib/draft.js"), "brouillon\n");

const plan: EditorWorkspacePlan = { workspace: null, folders: [{ name: "app", path: repository, branch: "main", location: "" }] };

test("cumule les commits consécutifs en un diff par fichier, comme une merge request", async () => {
  const changes = await conversationChanges(plan, [{ repositoryPath: repository, shas: [second, foreign, first] }], []);

  expect(changes.repositories).toHaveLength(1);
  const [group] = changes.repositories;
  expect([group!.kind, group!.commits, group!.title]).toEqual(["commits", 3, null]);
  expect(group!.files.map((file) => [file.status, file.path, file.added, file.removed])).toEqual([
    ["modified", "lib/gate.js", 1, 1],
    ["added", "lib/new.js", 1, 0],
    ["deleted", "lib/old.js", 0, 2],
    ["added", "lib/other.js", 1, 0],
  ]);
  expect(group!.files[0]).toMatchObject({ absolutePath: join(repository, "lib/gate.js"), firstLine: 2 });
  expect(group!.files[2]).toMatchObject({ absolutePath: null, firstLine: null });
});

test("montre commit par commit quand un autre travail s'intercale, puis le non commité", async () => {
  const changes = await conversationChanges(plan, [{ repositoryPath: repository, shas: [second, first] }], [repository]);

  expect(changes.repositories.map((group) => [group.kind, group.title?.replace(/^\w+ · /, ""), group.files.map((file) => file.path)])).toEqual([
    ["commits", "gate", ["lib/gate.js"]],
    ["commits", "ménage", ["lib/new.js", "lib/old.js"]],
    ["uncommitted", undefined, ["lib/gate.js", "lib/draft.js"]],
  ]);
  expect(changes.repositories[2]!.files[1]).toMatchObject({ status: "added", added: 1 });
});

test("extrait la dernière version d'un fichier supprimé, en lecture seule", async () => {
  const directory = join(root, "data");
  const path = await writeRevision(directory, repository, second, "lib/old.js");

  expect(readFileSync(path, "utf8")).toBe("ancien\ncontenu\n");
  expect(statSync(path).mode & 0o222).toBe(0);
  expect(await writeRevision(directory, repository, second, "lib/old.js")).toBe(path);
  await expect(writeRevision(directory, repository, second, "../../etc/passwd")).rejects.toThrow("révision invalide");
});
