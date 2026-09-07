import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { TodoStore } from "../src/stores/todos";
test("preserves prepared input and recovers in-flight without replay", () => {
  const db = new Database(":memory:");
  const store = new TodoStore(db);
  const item = store.create("p", {
    message: "Fix",
    provider: "codex",
    model: "m",
    targetBranch: "main",
    images: ["i"],
    integrate: false,
  });
  expect(item.images).toEqual(["i"]);
  expect(item.autonomy).toBe("local");
  store.update(item.id, { status: "running" });
  new TodoStore(db);
  expect(store.get(item.id)?.status).toBe("blocked");
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { TicketStore } from "../src/stores/tickets";
import { QuotaTracker } from "../src/quotas";
import { GitProjectService } from "../src/git";
import { TodoService, todoGit } from "../src/todos";
async function fixture(
  run?: (cwd: string) => Promise<void>,
  cancelled = false,
) {
  const root = mkdtempSync(join(tmpdir(), "pupitre-todos-"));
  const repo = join(root, "repo");
  await todoGit(root, ["init", "-b", "main", repo]);
  await todoGit(repo, ["config", "user.email", "test@example.com"]);
  await todoGit(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "initial"), "base");
  await todoGit(repo, ["add", "."]);
  await todoGit(repo, ["commit", "-m", "initial"]);
  await todoGit(root, ["init", "--bare", join(root, "remote")]);
  await todoGit(repo, ["remote", "add", "origin", join(root, "remote")]);
  await todoGit(repo, ["push", "-u", "origin", "main"]);
  const db = openDb(join(root, "data"));
  const projects = new ProjectStore(db),
    conversations = new ConversationStore(db),
    store = new TodoStore(db);
  const project = projects.create({ name: "test", path: repo });
  let calls = 0;
  const runner = {
    isRunning: () => false,
    runTurn: async (id: string) => {
      calls++;
      await run?.(conversations.get(id)!.worktree_path!);
      conversations.appendEvent(id, {
        type: "text-final",
        text: "Completed [TODO_READY]",
      });
      return { state: "done" as const, cancelled };
    },
  };
  const service = new TodoService(
    store,
    projects,
    conversations,
    runner,
    new GitProjectService(db, projects, {
      worktreeRoot: join(root, "worktrees"),
    }),
    new TicketStore(db),
    new QuotaTracker(db),
  );
  return {
    root,
    repo,
    db,
    project,
    store,
    service,
    calls: () => calls,
    clean: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
    add: (extra = {}) =>
      service.create(project.id, {
        message: "Implement",
        provider: "codex",
        model: "m",
        targetBranch: "main",
        ...extra,
      }),
  };
}
async function idle(f: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 500; i++) {
    if (!f.service.queue(f.project.id).activeTodoId) return;
    await Bun.sleep(10);
  }
  throw new Error("queue stuck");
}
test("manual queue preserves unique worktrees, refuses duplicates and pause drains only active", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(async () => gate);
  try {
    const a = await f.add(),
      b = await f.add();
    f.service.setQueue(f.project.id, true);
    expect(() => f.service.start(a.id)).toThrow();
    f.service.setQueue(f.project.id, false);
    release();
    await idle(f);
    expect(f.store.get(a.id)?.status).toBe("awaiting_validation");
    expect(f.store.get(b.id)?.status).toBe("queued");
    expect(f.calls()).toBe(1);
    expect(() => f.service.start(a.id)).toThrow();
    f.service.start(b.id);
    await idle(f);
    expect(f.store.get(a.id)?.worktree_path).not.toBe(
      f.store.get(b.id)?.worktree_path,
    );
  } finally {
    f.clean();
  }
});
test("integrated result is checked and pushed, next task branches from advanced target", async () => {
  let count = 0;
  const f = await fixture(async (cwd) => {
    count++;
    writeFileSync(join(cwd, `change-${count}`), "result");
  });
  try {
    const a = await f.add({ integrate: true, checks: ["test -f initial"] });
    const b = await f.add({ dependsOn: a.id });
    f.service.setQueue(f.project.id, true);
    await idle(f);
    expect(f.store.get(a.id)?.error).toBeNull();
    expect(f.store.get(a.id)?.status).toBe("done");
    const head = await todoGit(f.repo, ["rev-parse", "main"]);
    expect(
      await todoGit(f.store.get(b.id)!.worktree_path!, ["rev-parse", "HEAD"]),
    ).toBe(head);
    expect(await todoGit(join(f.root, "remote"), ["rev-parse", "main"])).toBe(
      head,
    );
    expect(f.store.get(b.id)?.status).toBe("awaiting_validation");
  } finally {
    f.clean();
  }
});
test("failed integration blocks dependents but continues independent tasks", async () => {
  const f = await fixture();
  try {
    const a = await f.add({ integrate: true, checks: ["exit 1"] });
    const b = await f.add({ dependsOn: a.id });
    const c = await f.add();
    f.service.setQueue(f.project.id, true);
    await idle(f);
    expect(f.store.get(a.id)?.status).toBe("blocked");
    expect(f.store.get(b.id)?.status).toBe("blocked");
    expect(f.store.get(c.id)?.status).toBe("awaiting_validation");
    expect(f.calls()).toBe(2);
  } finally {
    f.clean();
  }
});
test("cancelled done outcome blocks instead of integrating", async () => {
  const f = await fixture(undefined, true);
  try {
    const a = await f.add({ integrate: true, checks: ["true"] });
    f.service.start(a.id);
    await idle(f);
    expect(f.store.get(a.id)?.status).toBe("blocked");
  } finally {
    f.clean();
  }
});
test("manual reconciliation rechecks changed result and reports failure", async () => {
  const f = await fixture();
  try {
    const a = await f.add();
    f.service.start(a.id);
    await idle(f);
    await f.service.edit(a.id, { checks: ["exit 3"] });
    f.service.reconcile(a.id);
    await idle(f);
    expect(f.store.get(a.id)?.status).toBe("blocked");
    expect(f.calls()).toBe(1);
  } finally {
    f.clean();
  }
});
test("rejects client status injection and prevents reconciliation of cancelled execution", async () => {
  const f = await fixture(undefined, true);
  try {
    const a = await f.add();
    await expect(
      f.service.edit(a.id, { status: "done" } as never),
    ).rejects.toThrow();
    expect(f.store.get(a.id)?.status).toBe("queued");
    f.service.start(a.id);
    await idle(f);
    expect(() => f.service.reconcile(a.id)).toThrow();
  } finally {
    f.clean();
  }
});
test("failed merged-state check leaves target and remote unchanged", async () => {
  const f = await fixture(async (cwd) => {
    writeFileSync(join(cwd, "change"), "x");
  });
  try {
    const before = await todoGit(f.repo, ["rev-parse", "main"]);
    const a = await f.add({
      integrate: true,
      checks: ['test "$(git symbolic-ref -q --short HEAD)" != ""'],
    });
    f.service.start(a.id);
    await idle(f);
    expect(f.store.get(a.id)?.status).toBe("blocked");
    expect(await todoGit(f.repo, ["rev-parse", "main"])).toBe(before);
    expect(await todoGit(join(f.root, "remote"), ["rev-parse", "main"])).toBe(
      before,
    );
  } finally {
    f.clean();
  }
});
test("quota failure pauses queue without retry and preserves independent pending item", async () => {
  const f = await fixture(async () => {
    throw new Error("429 rate limit");
  });
  try {
    const a = await f.add(),
      b = await f.add();
    f.service.setQueue(f.project.id, true);
    await idle(f);
    expect(f.service.queue(f.project.id).running).toBe(false);
    expect(f.store.get(a.id)?.status).toBe("blocked");
    expect(f.store.get(b.id)?.status).toBe("queued");
    expect(f.calls()).toBe(1);
  } finally {
    f.clean();
  }
});
test("pending reorder and edit preserve scope and reject dependency cycles", async () => {
  const f = await fixture();
  try {
    const a = await f.add(),
      b = await f.add({ dependsOn: a.id });
    await expect(f.service.edit(a.id, { dependsOn: b.id })).rejects.toThrow(
      "cyclique",
    );
    f.service.reorder(f.project.id, [b.id, a.id]);
    expect(f.service.snapshot(f.project.id).items[0]!.id).toBe(b.id);
    await f.service.edit(a.id, { message: "updated", checks: ["true"] });
    expect(f.store.get(a.id)?.message).toBe("updated");
    expect(() => f.service.reorder(f.project.id, [a.id, a.id])).toThrow();
  } finally {
    f.clean();
  }
});
test("successful manual reconciliation releases previously blocked dependents", async () => {
  const f = await fixture();
  try {
    const a = await f.add({ integrate: true, checks: ["exit 1"] });
    const b = await f.add({ dependsOn: a.id });
    f.service.setQueue(f.project.id, true);
    await idle(f);
    expect(f.store.get(b.id)?.status).toBe("blocked");
    await f.service.edit(a.id, { checks: ["true"] });
    f.service.reconcile(a.id);
    await idle(f);
    expect(f.store.get(a.id)?.status).toBe("done");
    expect(f.store.get(b.id)?.status).toBe("awaiting_validation");
  } finally {
    f.clean();
  }
});

test("a rejected push blocks the target chain without advancing its local branch", async () => {
  let n = 0;
  const f = await fixture(async cwd => { writeFileSync(join(cwd, `extra-${++n}`), "x"); });
  try {
    const before = await todoGit(f.repo, ["rev-parse", "main"]);
    writeFileSync(join(f.root, "remote/hooks/pre-receive"), '#!/bin/sh\nrm -- "$0"\nexit 1\n', { mode: 0o755 });
    const a = await f.add({ integrate: true, checks: ["true"] });
    const b = await f.add({ integrate: true, checks: ["true"] });
    f.service.setQueue(f.project.id, true); await idle(f);
    expect(f.store.get(a.id)?.status).toBe("blocked");
    expect(f.store.get(b.id)?.status).toBe("queued");
    expect(await todoGit(f.repo, ["rev-parse", "main"])).toBe(before);
    expect(await todoGit(join(f.root, "remote"), ["rev-parse", "main"])).toBe(before);
    f.service.reconcile(a.id); await idle(f);
    expect(f.store.get(a.id)?.status).toBe("done");
    expect(f.store.get(b.id)?.status).toBe("done");
  } finally { f.clean(); }
});

test("an edit crossing a start cannot change the running task authorization", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const f = await fixture(async () => gate);
  try {
    const a = await f.add();
    const edit = f.service.edit(a.id, { message: "different task", integrate: true, checks: ["true"] });
    f.service.start(a.id);
    await expect(edit).rejects.toThrow();
    expect(f.store.get(a.id)?.integrate).toBe(false);
    expect(f.store.get(a.id)?.message).toBe(a.message);
    release(); await idle(f);
    expect(f.store.get(a.id)?.status).toBe("awaiting_validation");
  } finally { release(); await idle(f); f.clean(); }
});
