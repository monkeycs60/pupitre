import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { TicketStore } from "../src/stores/tickets";
import { TodoStore } from "../src/stores/todos";
import type { ProjectResumeService } from "../src/project-resume";
import { TelegramCapture, explicitProject } from "../src/telegram-capture";
test("préfixe, dédoublonnage, liste blanche et polling interdit en dev avec API simulée", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-")),
    db = openDb(root);
  try {
    const projects = new ProjectStore(db),
      tickets = new TicketStore(db),
      todos = new TodoStore(db);
    const p = projects.create({ name: "helion", path: root });
    const calls: string[] = [];
    const bot = new TelegramCapture(
      db,
      projects,
      tickets,
      todos,
      async () => {
        throw new Error("le préfixe doit primer");
      },
      {
        get: async () => ({ content: "Reprise" }),
      } as unknown as ProjectResumeService,
      "dev",
      root,
      async (method) => {
        calls.push(method);
        return [];
      },
    );
    bot.configure(p.id, "123:fake_token", "42");
    await bot.poll();
    expect(calls).toHaveLength(0);
    await bot.consume({
      update_id: 1,
      message: { chat: { id: 99 }, text: "helion : refus" },
    });
    expect(todos.list()).toHaveLength(0);
    const update = {
      update_id: 2,
      message: { chat: { id: 42 }, text: "helion : les bots devraient fuir" },
    };
    await bot.consume(update);
    await bot.consume(update);
    expect(todos.list()).toHaveLength(1);
    expect(todos.list()[0]?.project_id).toBe(p.id);
    expect(calls).toEqual(["sendMessage"]);
    await bot.consume({
      update_id: 3,
      callback_query: {
        id: "cb",
        message: { chat: { id: 42 } },
        data: "queue:2",
      },
    });
    expect(todos.list()[0]?.status).toBe("queued");
    expect(explicitProject(" HELION : idée", projects.list())?.id).toBe(p.id);
    expect(bot.status()).toEqual({
      configured: true,
      chatId: "42",
      polling: false,
    });
    expect(JSON.stringify(bot.status())).not.toContain("fake_token");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("une photo reprend après échec sans doubler le backlog, et le polling stable avance le curseur", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-photo-")),
    db = openDb(root);
  try {
    const projects = new ProjectStore(db),
      tickets = new TicketStore(db),
      todos = new TodoStore(db);
    const project = projects.create({ name: "helion", path: root });
    let downloads = 0;
    const offsets: number[] = [];
    const update = {
      update_id: 12,
      message: {
        chat: { id: 42 },
        caption: "helion : améliorer la carte",
        photo: [{ file_id: "photo" }],
      },
    };
    const bot = new TelegramCapture(
      db,
      projects,
      tickets,
      todos,
      async () => null,
      {
        get: async () => ({ content: "Reprise" }),
      } as unknown as ProjectResumeService,
      "stable",
      root,
      async (method, body) => {
        if (method === "getUpdates") {
          offsets.push(body.offset as number);
          return body.offset === 0 ? [update] : [];
        }
        if (method === "getFile") return { file_path: "photos/test.jpg" };
        return {};
      },
      async () => {
        if (downloads++ === 0) throw new Error("échec temporaire");
        return new Uint8Array([1, 2, 3]);
      },
    );
    bot.configure(project.id, "123:fake", "42");
    await expect(bot.poll()).rejects.toThrow("échec temporaire");
    expect(todos.list(project.id)).toHaveLength(1);
    await bot.poll();
    await bot.poll();
    expect(todos.list(project.id)).toHaveLength(1);
    expect(todos.list(project.id)[0]?.images).toEqual(["telegram-12.jpg"]);
    expect(offsets).toEqual([0, 0, 13]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
