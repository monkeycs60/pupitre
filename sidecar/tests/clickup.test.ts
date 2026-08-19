import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClickUpClient, parseClickUpTasks, ClickUpAuthError } from "../src/integrations/clickup";

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

test("401 devient une ClickUpAuthError", async () => {
  const client = new ClickUpClient("bad", async () => new Response("{}", { status: 401 }));
  await expect(client.me()).rejects.toBeInstanceOf(ClickUpAuthError);
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
