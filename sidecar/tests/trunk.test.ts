import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trunkOf, isTrunkRef } from "../src/trunk";
const roots: string[] = [];
afterAll(() =>
  roots.forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function repository(branch: string) {
  const root = mkdtempSync(join(tmpdir(), "trunk-unit-"));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
  };
  git("init", "-b", branch);
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  git("remote", "add", "origin", "/tmp/unused");
  return { root, git };
}
for (const branch of ["main", "master", "develop"])
  test(`détecte ${branch} et ses références`, () => {
    const { root } = repository(branch);
    expect(trunkOf(root)).toBe(branch);
    for (const ref of [
      branch,
      `origin/${branch}`,
      `refs/heads/${branch}`,
      `refs/remotes/other/${branch}`,
    ])
      expect(isTrunkRef(root, ref)).toBe(true);
    expect(isTrunkRef(root, "feature/work")).toBe(false);
  });
test("origin/HEAD, surcharge, cache et worktree", () => {
  const { root, git } = repository("trunk");
  git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(trunkOf(root)).toBe("trunk");
  expect(trunkOf(root, "release")).toBe("release");
  expect(isTrunkRef(root, "origin/release", "release")).toBe(true);
  git(
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/changed",
  );
  expect(trunkOf(root)).toBe("trunk");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  git("worktree", "add", "--force", join(root, "work"), "trunk");
  expect(isTrunkRef(join(root, "work"), "trunk")).toBe(true);
});
