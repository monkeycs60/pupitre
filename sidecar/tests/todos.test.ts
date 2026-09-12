import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { TodoStore } from "../src/stores/todos";
test("preserves prepared input, normalizes legacy payloads and recovers in-flight without replay", () => {
  const db = new Database(":memory:");
  const store = new TodoStore(db);
  const item = store.create("p", {
    message: "Corriger le formulaire\n\nDétails en dessous",
    provider: "codex",
    model: "m",
    targetBranch: "main",
    images: ["i"],
  });
  expect(item.images).toEqual(["i"]);
  expect(item.finish).toBe("none");
  expect(item.title).toBe("Corriger le formulaire");
  store.update(item.id, { status: "running" });
  db.query("UPDATE project_todos SET payload=json_set(json_remove(payload,'$.finish'),'$.integrate',json('true'),'$.checks',json('[\"bun test\"]')) WHERE id=?").run(item.id);
  new TodoStore(db);
  const recovered = store.get(item.id)!;
  expect(recovered.status).toBe("blocked");
  expect(recovered.finish).toBe("commit_push");
  expect(recovered).not.toHaveProperty("checks");
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
import { TodoService, todoGit, commitMessageOf, remoteLinks } from "../src/todos";
test("commitMessageOf reads the commit block of the final answer and falls back to the title", () => {
  expect(commitMessageOf("Fait.\n```commit\nfix(todos): corrige le tri\n\nLe rang était perdu.\n```\nVoilà.", "Titre")).toBe("fix(todos): corrige le tri\n\nLe rang était perdu.");
  expect(commitMessageOf("Aucun bloc", "Titre")).toBe("Titre");
  expect(commitMessageOf("```commit\n\n```", "Titre")).toBe("Titre");
  expect(commitMessageOf(`\`\`\`commit\n${"x".repeat(100)}\n\`\`\``, "Titre")).toBe("x".repeat(72));
});
test("remoteLinks builds GitLab and GitHub branch and merge-request URLs, none for local remotes", () => {
  expect(remoteLinks("git@gitlab.com:acme/mono.git", "codex/todo-1", "main")).toEqual({
    branchUrl: "https://gitlab.com/acme/mono/-/tree/codex%2Ftodo-1",
    mergeRequestUrl: "https://gitlab.com/acme/mono/-/merge_requests/new?merge_request%5Bsource_branch%5D=codex%2Ftodo-1&merge_request%5Btarget_branch%5D=main",
  });
  expect(remoteLinks("https://github.com/acme/mono.git", "codex/todo-1", "main")).toEqual({
    branchUrl: "https://github.com/acme/mono/tree/codex%2Ftodo-1",
    mergeRequestUrl: "https://github.com/acme/mono/compare/main...codex%2Ftodo-1?expand=1",
  });
  expect(remoteLinks("/tmp/remote", "b", "main")).toEqual({ branchUrl: null, mergeRequestUrl: null });
});
async function fixture(
  run?: (cwd: string) => Promise<void>,
  cancelled = false,
  finalText = "Completed",
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
  const order: string[] = [];
  const runner = {
    isRunning: () => false,
    runTurn: async (id: string, message: string) => {
      calls++;
      order.push(message);
      await run?.(conversations.get(id)!.worktree_path!);
      conversations.appendEvent(id, { type: "text-final", text: finalText });
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
    projects,
    conversations,
    store,
    service,
    order,
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
async function idle(f: Awaited<ReturnType<typeof fixture>>, projectId = f.project.id) {
  for (let i = 0; i < 500; i++) {
    if (!f.service.queue(projectId).activeTodoId) return;
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
test("finish none leaves the worktree dirty, commit commits locally, commit_push publishes the branch", async () => {
  let count = 0;
  const f = await fixture(async (cwd) => {
    writeFileSync(join(cwd, `change-${++count}`), "result");
  }, false, "Terminé.\n```commit\nfeat: ajoute le fichier\n\nParce que.\n```");
  try {
    const none = await f.add({ finish: "none", title: "Sans commit" });
    const commit = await f.add({ finish: "commit", title: "Avec commit" });
    const push = await f.add({ finish: "commit_push", title: "Avec push" });
    f.service.setQueue(f.project.id, true);
    await idle(f);
    for (const id of [none.id, commit.id, push.id]) {
      expect(f.store.get(id)?.error).toBeNull();
      expect(f.store.get(id)?.status).toBe("awaiting_validation");
    }
    const noneItem = f.store.get(none.id)!;
    expect(await todoGit(noneItem.worktree_path!, ["status", "--porcelain"])).not.toBe("");
    const commitItem = f.store.get(commit.id)!;
    expect(await todoGit(commitItem.worktree_path!, ["status", "--porcelain"])).toBe("");
    expect(await todoGit(commitItem.worktree_path!, ["log", "-1", "--format=%B"])).toBe("feat: ajoute le fichier\n\nParce que.");
    expect(commitItem.commit_message).toBe("feat: ajoute le fichier\n\nParce que.");
    expect(commitItem.commit_sha).toBe(await todoGit(commitItem.worktree_path!, ["rev-parse", "HEAD"]));
    expect(noneItem.commit_sha).toBeNull();
    expect(commitItem.branch_url).toBeNull();
    await expect(todoGit(join(f.root, "remote"), ["rev-parse", "--verify", `refs/heads/${commitItem.branch}`])).rejects.toThrow();
    const pushItem = f.store.get(push.id)!;
    expect(await todoGit(join(f.root, "remote"), ["rev-parse", `refs/heads/${pushItem.branch}`]))
      .toBe(await todoGit(pushItem.worktree_path!, ["rev-parse", "HEAD"]));
    expect(await todoGit(f.repo, ["rev-parse", "main"])).toBe(await todoGit(join(f.root, "remote"), ["rev-parse", "main"]));
  } finally {
    f.clean();
  }
});
test("a rejected push blocks the task and keeps the local commit", async () => {
  const f = await fixture(async (cwd) => { writeFileSync(join(cwd, "extra"), "x"); });
  try {
    writeFileSync(join(f.root, "remote/hooks/pre-receive"), '#!/bin/sh\necho "Rejected" >&2\nexit 1\n', { mode: 0o755 });
    const a = await f.add({ finish: "commit_push" });
    const b = await f.add({ finish: "none" });
    f.service.setQueue(f.project.id, true);
    await idle(f);
    const item = f.store.get(a.id)!;
    expect(item.status).toBe("blocked");
    expect(item.error).toContain("Rejected");
    expect(await todoGit(item.worktree_path!, ["status", "--porcelain"])).toBe("");
    expect(f.store.get(b.id)?.status).toBe("awaiting_validation");
    expect(f.service.queue(f.project.id).running).toBe(true);
  } finally {
    f.clean();
  }
});
test("cancelled done outcome blocks instead of finishing", async () => {
  const f = await fixture(undefined, true);
  try {
    const a = await f.add({ finish: "commit" });
    f.service.start(a.id);
    await idle(f);
    expect(f.store.get(a.id)?.status).toBe("blocked");
  } finally {
    f.clean();
  }
});
test("rejects client status injection and unknown fields", async () => {
  const f = await fixture();
  try {
    const a = await f.add();
    await expect(f.service.edit(a.id, { status: "done" } as never)).rejects.toThrow();
    await expect(f.service.edit(a.id, { integrate: true } as never)).rejects.toThrow();
    await expect(f.service.edit(a.id, { finish: "merge" } as never)).rejects.toThrow();
    expect(f.store.get(a.id)?.status).toBe("queued");
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
test("reorder covers every open task, keeps done tasks behind and drives the queue order", async () => {
  const f = await fixture();
  try {
    const a = await f.add({ status: "backlog", message: "A" }),
      b = await f.add({ status: "backlog", message: "B" }),
      c = await f.add({ status: "backlog", message: "C" });
    f.service.complete(c.id);
    expect(() => f.service.reorder(f.project.id, [b.id])).toThrow();
    expect(() => f.service.reorder(f.project.id, [a.id, a.id])).toThrow();
    f.service.reorder(f.project.id, [b.id, a.id]);
    expect(f.service.snapshot(f.project.id).items.map((t) => t.id)).toEqual([b.id, a.id, c.id]);
    await f.service.edit(a.id, { message: "updated" });
    expect(f.store.get(a.id)?.message).toBe("updated");
    await f.service.drain(f.project.id);
    await idle(f);
    expect(f.order).toEqual(["B", "updated"]);
  } finally {
    f.clean();
  }
});
test("drain enqueues backlog in list order and blocks only the task with an unknown branch", async () => {
  const f = await fixture();
  try {
    const a = await f.add({ status: "backlog", targetBranch: null, message: "first" });
    const bad = await f.add({ status: "backlog", targetBranch: "missing-branch", message: "bad" });
    const b = await f.add({ status: "backlog", targetBranch: null, message: "second" });
    const done = await f.add({ status: "backlog", message: "closed" });
    f.service.complete(done.id);
    const snapshot = await f.service.drain(f.project.id);
    expect(snapshot.queue.running).toBe(true);
    await idle(f);
    expect(f.order).toEqual(["first", "second"]);
    expect(f.store.get(a.id)?.status).toBe("awaiting_validation");
    expect(f.store.get(b.id)?.status).toBe("awaiting_validation");
    expect(f.store.get(bad.id)?.status).toBe("blocked");
    expect(f.store.get(done.id)?.status).toBe("done");
    expect(f.calls()).toBe(2);
  } finally {
    f.clean();
  }
});
test("an edit crossing a start cannot change the running task", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const f = await fixture(async () => gate);
  try {
    const a = await f.add();
    const edit = f.service.edit(a.id, { message: "different task", finish: "commit_push" });
    f.service.start(a.id);
    await expect(edit).rejects.toThrow();
    expect(f.store.get(a.id)?.finish).toBe("none");
    expect(f.store.get(a.id)?.message).toBe(a.message);
    release(); await idle(f);
    expect(f.store.get(a.id)?.status).toBe("awaiting_validation");
  } finally { release(); await idle(f); f.clean(); }
});

test("backlog captures and closes tasks without Git or an agent execution", async () => {
  const f = await fixture();
  try {
    const project = f.projects.create({ name: "Personal notes", path: f.root });
    const task = await f.service.create(project.id, {
      status: "backlog",
      message: "Organiser les notes",
      provider: "codex",
      model: "m",
    });
    expect(task.target_branch).toBe("");
    expect(task.status).toBe("backlog");
    const edited = await f.service.edit(task.id, { title: "Notes du projet" });
    expect(edited.status).toBe("backlog");
    f.service.setQueue(project.id, true);
    expect(f.service.queue(project.id).activeTodoId).toBeNull();
    expect(f.calls()).toBe(0);
    const completed = f.service.complete(task.id);
    expect(completed.status).toBe("done");
    expect(completed.execution_completed).toBe(false);
    expect(completed.conversation_id).toBeNull();
    expect(f.service.reopen(task.id).status).toBe("backlog");
    await expect(f.service.enqueue(task.id)).rejects.toThrow();
    expect(f.store.get(task.id)?.status).toBe("backlog");
    f.service.remove(task.id);
    expect(f.store.get(task.id)).toBeNull();
  } finally { f.clean(); }
});

test("backlog waits for explicit enqueue and resolves the current Git branch then", async () => {
  const f = await fixture();
  try {
    const a = await f.add({ status: "backlog", targetBranch: null });
    const b = await f.add({ status: "backlog", targetBranch: null });
    f.service.setQueue(f.project.id, true);
    expect(f.service.queue(f.project.id).activeTodoId).toBeNull();
    expect(f.calls()).toBe(0);
    await f.service.enqueue(a.id);
    await idle(f);
    expect(f.store.get(a.id)?.target_branch).toBe("main");
    expect(f.store.get(a.id)?.status).toBe("awaiting_validation");
    expect(f.store.get(b.id)?.status).toBe("backlog");
    expect(f.calls()).toBe(1);
    f.service.start(b.id);
    await idle(f);
    expect(f.store.get(b.id)?.target_branch).toBe("main");
    expect(f.calls()).toBe(2);
  } finally { await idle(f); f.clean(); }
});

test("enqueue rejects a concurrent closure and never launches the closed task", async () => {
  const f = await fixture();
  try {
    const task = await f.add({ status: "backlog" });
    f.service.setQueue(f.project.id, true);
    const enqueue = f.service.enqueue(task.id);
    f.service.complete(task.id);
    await expect(enqueue).rejects.toThrow("changé");
    expect(f.store.get(task.id)?.status).toBe("done");
    expect(f.calls()).toBe(0);
  } finally { await idle(f); f.clean(); }
});

test("a running task refuses closure and removal; an executed task can be closed, reopened and removed", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => gate);
  try {
    const task = await f.add({ status: "backlog" });
    f.service.start(task.id);
    expect(() => f.service.complete(task.id)).toThrow();
    expect(() => f.service.reopen(task.id)).toThrow();
    expect(() => f.service.remove(task.id)).toThrow();
    await expect(f.service.enqueue(task.id)).rejects.toThrow();
    release();
    await idle(f);
    expect(f.store.get(task.id)?.status).toBe("awaiting_validation");
    expect(f.service.complete(task.id).status).toBe("done");
    expect(f.service.reopen(task.id).status).toBe("awaiting_validation");
    expect(() => f.service.start(task.id)).toThrow();
    f.service.remove(task.id);
    expect(f.store.get(task.id)).toBeNull();

    const blocked = await f.add({ status: "backlog" });
    f.store.update(blocked.id, { status: "blocked", branch: "codex/existing", error: "Échec" });
    expect(f.service.complete(blocked.id).status).toBe("done");
    f.service.remove(blocked.id);
    expect(f.store.get(blocked.id)).toBeNull();
  } finally { release(); await idle(f); f.clean(); }
});

test("link attaches a manual conversation and takes the task out of the executable pile", async () => {
  const f = await fixture();
  try {
    const task = await f.add({ status: "backlog" });
    const conversation = f.conversations.create({ projectId: f.project.id, provider: "codex", model: "m", firstMessage: "Implement" });
    const other = f.projects.create({ name: "other", path: f.root });
    const foreign = f.conversations.create({ projectId: other.id, provider: "codex", model: "m", firstMessage: "x" });
    expect(() => f.service.link(task.id, foreign.id)).toThrow();
    expect(() => f.service.link(task.id, "missing")).toThrow();
    const linked = f.service.link(task.id, conversation.id);
    expect(linked.status).toBe("awaiting_validation");
    expect(linked.conversation_id).toBe(conversation.id);
    expect(() => f.service.link(task.id, conversation.id)).toThrow();
    expect(() => f.service.start(task.id)).toThrow();
    await expect(f.service.enqueue(task.id)).rejects.toThrow();
    f.service.setQueue(f.project.id, true);
    expect(f.calls()).toBe(0);
    expect(f.service.complete(task.id).status).toBe("done");
  } finally { f.clean(); }
});

test("queued edits validate Git while backlog edits preserve deferred configuration", async () => {
  const f = await fixture();
  try {
    const backlog = await f.add({ status: "backlog" });
    await f.service.edit(backlog.id, { targetBranch: "branch missing" });
    expect(f.store.get(backlog.id)?.status).toBe("backlog");
    await expect(f.service.enqueue(backlog.id)).rejects.toThrow();
    await expect(f.service.edit(backlog.id, { status: "queued" })).rejects.toThrow();
    const queued = await f.add();
    await expect(f.service.edit(queued.id, { targetBranch: "branch missing" })).rejects.toThrow();
    expect(f.store.get(queued.id)?.target_branch).toBe("main");
    await expect(f.add({ status: "done" })).rejects.toThrow();
  } finally { f.clean(); }
});

test("editing an unstarted blocked task returns it to backlog without requiring Git", async () => {
  const f = await fixture();
  try {
    const project = f.projects.create({ name: "Personal notes", path: f.root });
    const task = await f.service.create(project.id, {
      status: "backlog",
      message: "Planifier le projet",
      provider: "codex",
      model: "m",
      finish: "commit",
    });
    f.service.setQueue(project.id, true);
    f.service.start(task.id);
    await idle(f, project.id);
    expect(f.store.get(task.id)?.status).toBe("blocked");
    const edited = await f.service.edit(task.id, { message: "Ajouter les notes", targetBranch: null });
    expect(edited.status).toBe("backlog");
    expect(edited.error).toBeNull();
    expect(edited.target_branch).toBe("");
    expect(edited.finish).toBe("commit");
    expect(f.service.queue(project.id).activeTodoId).toBeNull();
    expect(f.calls()).toBe(0);
    f.service.complete(task.id);
    expect(f.store.get(task.id)?.status).toBe("done");
  } finally { f.clean(); }
});
