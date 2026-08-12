import { expect, test } from "bun:test";
import { isRemovable, worktreeLabel, worktreeRows } from "../../ui/src/worktrees";
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
