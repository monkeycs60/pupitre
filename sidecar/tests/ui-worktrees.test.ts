import { expect, test } from "bun:test";
import { branchSuggestions, cleanupInvitation, disposableWorktrees, isRemovable, worktreeLabel, worktreeRows } from "../../ui/src/worktrees";
import type { GitWorktree } from "../../ui/src/types";

function worktree(overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path: "/depot",
    head: "abc1234",
    branch: "main",
    detached: false,
    bare: false,
    ...overrides,
  };
}

const main = worktree();
const ticket = worktree({ path: "/wt/ticket-42", branch: "ticket-42" });
const fusionnee = worktree({ path: "/wt/fusionnee", branch: "fusionnee" });

test("le dépôt principal ouvre la liste et n'est jamais supprimable", () => {
  const [first] = worktreeRows([main, ticket], [], null);

  expect(first?.main).toBe(true);
  expect(isRemovable(first!)).toBe(false);
});

test("le worktree de la conversation ouverte est signalé et protégé", () => {
  const rows = worktreeRows([main, ticket], [], "/wt/ticket-42");
  const row = rows.find((item) => item.worktree.path === "/wt/ticket-42")!;

  expect(row.current).toBe(true);
  expect(isRemovable(row)).toBe(false);
});

test("un worktree fusionné est marqué, et supprimable s'il n'est pas le courant", () => {
  const rows = worktreeRows([main, ticket, fusionnee], [fusionnee], "/wt/ticket-42");
  const row = rows.find((item) => item.worktree.path === "/wt/fusionnee")!;

  expect(row.merged).toBe(true);
  expect(isRemovable(row)).toBe(true);
  // Le non fusionné reste supprimable aussi : c'est un choix, pas un blocage.
  expect(rows.find((item) => item.worktree.path === "/wt/ticket-42")!.merged).toBe(false);
});

test("l'étiquette dit la branche, ou l'état à défaut", () => {
  expect(worktreeLabel(ticket)).toBe("ticket-42");
  expect(worktreeLabel(worktree({ branch: null, detached: true }))).toBe("HEAD détachée");
  expect(worktreeLabel(worktree({ branch: null, path: "/ailleurs" }))).toBe("/ailleurs");
});

test("l'invite de nettoyage ne parle que des worktrees fusionnés et libres", () => {
  const rows = worktreeRows([main, ticket, fusionnee], [fusionnee], "/wt/ticket-42");

  expect(disposableWorktrees(rows).map((row) => row.worktree.path)).toEqual(["/wt/fusionnee"]);
  expect(cleanupInvitation(rows)).toBe("1 branche fusionnée : son worktree peut être retiré.");
});

test("aucune invite quand le seul worktree fusionné est celui où l'on travaille", () => {
  const rows = worktreeRows([main, fusionnee], [fusionnee], "/wt/fusionnee");

  expect(disposableWorktrees(rows)).toEqual([]);
  expect(cleanupInvitation(rows)).toBeNull();
});

test("l'invite s'accorde au pluriel", () => {
  const autre = worktree({ path: "/wt/autre", branch: "autre" });
  const rows = worktreeRows([main, fusionnee, autre], [fusionnee, autre], null);

  expect(cleanupInvitation(rows)).toBe("2 branches fusionnées : leurs worktrees peuvent être retirés.");
});

test("aucune invite sans worktree fusionné", () => {
  expect(cleanupInvitation(worktreeRows([main, ticket], [], null))).toBeNull();
});

test("la complétion propose les branches locales, puis les distantes inédites", () => {
  const branches = [
    { name: "master", fullName: "refs/heads/master", sha: "a", current: true, remote: false },
    { name: "ticket-42", fullName: "refs/heads/ticket-42", sha: "b", current: false, remote: false },
    { name: "origin/master", fullName: "refs/remotes/origin/master", sha: "a", current: false, remote: true },
    { name: "origin/ticket-99", fullName: "refs/remotes/origin/ticket-99", sha: "c", current: false, remote: true },
    { name: "origin/HEAD", fullName: "refs/remotes/origin/HEAD", sha: "a", current: false, remote: true },
  ];

  // master existe en local : sa jumelle distante n'est pas reproposée.
  expect(branchSuggestions(branches)).toEqual(["master", "ticket-42", "ticket-99"]);
});

test("l'alias HEAD d'un dépôt distant n'est pas proposé comme branche", () => {
  // Forme réelle observée dans l'app : refs/remotes/origin/HEAD est exposé
  // sous le nom « origin », qu'un filtre sur « HEAD » laisse passer.
  const branches = [
    { name: "master", fullName: "refs/heads/master", sha: "a", current: true, remote: false },
    { name: "origin", fullName: "refs/remotes/origin/HEAD", sha: "a", current: false, remote: true },
    { name: "origin/codex/ui", fullName: "refs/remotes/origin/codex/ui", sha: "b", current: false, remote: true },
  ];

  expect(branchSuggestions(branches)).toEqual(["master", "codex/ui"]);
});
