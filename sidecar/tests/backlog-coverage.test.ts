import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { TodoStore } from "../src/stores/todos";
import { BacklogCoverage } from "../src/backlog-coverage";
test("un commit couvrant un élément le marque probablement fait sans le supprimer", async () => {
  const root = mkdtempSync(join(tmpdir(), "harvest-proof-")),
    db = openDb(root);
  try {
    const projects = new ProjectStore(db),
      todos = new TodoStore(db);
    const p = projects.create({ name: "Test", path: root });
    const { TicketStore } = await import("../src/stores/tickets");
    const ticket = new TicketStore(db).upsert(p.id, {
      key: "TECH-1",
      source: "clickup",
      title: "Moteur",
      status: "",
      externalUrl: null,
    });
    const todo = todos.create(p.id, {
      title: "Corriger le moteur",
      message: "Corriger",
      provider: "claude",
      model: "test",
      ticketId: ticket.id,
      status: "backlog",
    });
    const service = new BacklogCoverage(
      db,
      projects,
      todos,
      async () => ({ coveredIds: [todo.id, "inconnu"] }),
    );
    await service.markCovered(ticket.id, "fix: moteur corrigé");
    expect(todos.get(todo.id)).toMatchObject({
      status: "backlog",
      probably_done: true,
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
