import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClickUpClient, ClickUpAuthError, ClickUpHttpError, parseClickUpTasks } from "../src/integrations/clickup";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/clickup-tasks.json"), "utf8"));

test("parse les tâches v2 en tickets normalisés", () => {
  const tasks = parseClickUpTasks(fixture);
  expect(tasks).toHaveLength(2);
  expect(tasks[0]).toEqual({
    id: "86caw5afd",
    key: "TECH-24657",
    title: "[Feature] - Ajout de la sélection des leviers",
    status: "in progress",
    statusColor: "#4466ff",
    url: "https://app.clickup.com/t/86caw5afd",
    updatedAt: new Date(1786716751258).toISOString(),
    list: "Features",
    priority: "normal",
    labels: ["BackOffice"],
  });
  expect(tasks[1]?.key).toBe("86cb0000x");
});

test("le client pagine jusqu'à last_page et envoie le token en Authorization", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe("pk_test");
    if (url.endsWith("/user")) return Response.json({ user: { id: 42 } });
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json(page === 0 ? { ...fixture, last_page: false } : { tasks: [], last_page: true });
  };
  const client = new ClickUpClient("pk_test", fetchImpl);
  expect(await client.me()).toBe(42);
  const tasks = await client.assignedTasks({ teamId: "20556900", listIds: ["900500195250"], userId: 42 });
  expect(tasks).toHaveLength(2);
  expect(calls.filter((url) => url.includes("/team/20556900/task"))).toHaveLength(2);
  expect(calls[1]).toContain("assignees%5B%5D=42");
  expect(calls[1]).toContain("list_ids%5B%5D=900500195250");
});

test("assignedTasks continue au-delà de 100 pages jusqu'à last_page", async () => {
  const pages: number[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    return Response.json({
      tasks: [{ id: `task-${page}`, custom_id: null, name: `Task ${page}`, status: { status: "Open" }, url: `https://app.clickup.com/t/task-${page}`, date_updated: "1", list: null, priority: null, custom_fields: [] }],
      last_page: page >= 100,
    });
  };
  const client = new ClickUpClient("pk_test", fetchImpl);
  const tasks = await client.assignedTasks({ teamId: "20556900", listIds: [], userId: 42 });
  expect(tasks).toHaveLength(101);
  expect(pages).toHaveLength(101);
  expect(pages.at(-1)).toBe(100);
});

test("taskContext tronque la description à 2000 caractères", async () => {
  const client = new ClickUpClient("pk", async (input) => {
    const url = String(input);
    if (url.endsWith("/comment")) return Response.json({ comments: [] });
    return Response.json({ id: "86caw5afd", description: "x".repeat(2500) });
  });
  const context = await client.taskContext("86caw5afd");
  expect(context.description).toHaveLength(2000);
  expect(context.description).toBe("x".repeat(2000));
});

test("401 devient une ClickUpAuthError", async () => {
  const client = new ClickUpClient("bad", async () => new Response("{}", { status: 401 }));
  await expect(client.me()).rejects.toBeInstanceOf(ClickUpAuthError);
});

test("403 devient une ClickUpAuthError", async () => {
  const client = new ClickUpClient("bad", async () => new Response("{}", { status: 403 }));
  await expect(client.me()).rejects.toBeInstanceOf(ClickUpAuthError);
});

test("un HTTP non-auth devient une ClickUpHttpError", async () => {
  const client = new ClickUpClient("bad", async () => new Response("{}", { status: 500 }));
  await expect(client.me()).rejects.toBeInstanceOf(ClickUpHttpError);
});

test("contexte d'une tâche : description et commentaires récents", async () => {
  const client = new ClickUpClient("pk", async (input) => {
    const url = String(input);
    if (url.endsWith("/comment")) {
      return Response.json({ comments: [{ id: "1", comment_text: "Dernier", user: { username: "Alex" }, date: "1785923853742" }] });
    }
    return Response.json({ id: "86caw5afd", description: "Faire la chose." });
  });
  const context = await client.taskContext("86caw5afd");
  expect(context.description).toBe("Faire la chose.");
  expect(context.comments[0]).toEqual({ author: "Alex", text: "Dernier", at: new Date(1785923853742).toISOString() });
});
