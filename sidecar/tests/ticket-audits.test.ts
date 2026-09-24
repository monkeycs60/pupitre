import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { TicketAuditService } from "../src/ticket-audits";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { SettingsStore, TICKET_AUDIT_YOLO_MIGRATION_KEY } from "../src/stores/settings";
import { TicketStore } from "../src/stores/tickets";
import type { IntegrationsRefresher } from "../src/integrations/refresher";
import type { ConversationRunner } from "../src/runner";

test("la relecture démarre en YOLO et conserve l'interdiction d'écrire au premier tour", async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-ticket-audit-")));
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "Pupitre", path: "/tmp/pupitre-ticket-audit" });
  const tickets = new TicketStore(db);
  const ticket = tickets.upsert(project.id, {
    key: "TECH-42", source: "clickup", title: "Corriger le formulaire", status: "code review",
    externalUrl: null, payload: { assignedToMe: true, previousClickUpStatus: "in progress" },
  });
  tickets.upsertRef(ticket.id, { kind: "mr", ref: "reactor!42", payload: {} });
  const conversations = new ConversationStore(db);
  let resolveTurn!: () => void;
  const turnStarted = new Promise<void>((resolve) => { resolveTurn = resolve; });
  const runner = {
    runTurn: async (conversationId: string, prompt: string) => {
      expect(conversations.get(conversationId)?.permission_mode).toBe("bypassPermissions");
      expect(prompt).toContain("Ne modifie aucun fichier et ne publie rien");
      resolveTurn();
      return { state: "done", cancelled: false };
    },
  } as unknown as ConversationRunner;
  const refresher = { clickUpContext: async () => null } as unknown as IntegrationsRefresher;
  new TicketAuditService(db, tickets, conversations, projects, new SettingsStore(db), refresher, runner)
    .scan(project.id);
  await turnStarted;
  for (let attempt = 0; attempt < 20; attempt++) {
    const state = db.query("SELECT state FROM ticket_audits WHERE ticket_id = ?").get(ticket.id) as { state: string };
    if (state.state === "done") break;
    await Bun.sleep(10);
  }

  const audit = db.query("SELECT conversation_id, state FROM ticket_audits WHERE ticket_id = ?")
    .get(ticket.id) as { conversation_id: string; state: string };
  expect(audit.state).toBe("done");
  expect(conversations.get(audit.conversation_id)?.permission_mode).toBe("bypassPermissions");
  db.close();
});

test("la migration corrige les anciennes relectures une seule fois", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-ticket-audit-migration-"));
  const db = openDb(dir);
  const project = new ProjectStore(db).create({ name: "Pupitre", path: dir });
  const tickets = new TicketStore(db);
  const ticket = tickets.upsert(project.id, {
    key: "TECH-43", source: "clickup", title: "Relire", status: "code review", externalUrl: null,
  });
  const conversations = new ConversationStore(db);
  const audit = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-6-sol",
    permissionMode: "acceptEdits", firstMessage: "Audit", ticketId: ticket.id,
  });
  const unrelated = conversations.create({
    projectId: project.id, provider: "codex", model: "gpt-6-sol",
    permissionMode: "acceptEdits", firstMessage: "Autre conversation",
  });
  db.query("INSERT INTO ticket_audits (ticket_id, conversation_id, state, created_at, updated_at) VALUES (?, ?, 'done', ?, ?)")
    .run(ticket.id, audit.id, new Date().toISOString(), new Date().toISOString());
  db.query("DELETE FROM settings WHERE key = ?").run(TICKET_AUDIT_YOLO_MIGRATION_KEY);
  db.close();

  const reopened = openDb(dir);
  const migrated = new ConversationStore(reopened);
  expect(migrated.get(audit.id)?.permission_mode).toBe("bypassPermissions");
  expect(migrated.get(unrelated.id)?.permission_mode).toBe("acceptEdits");
  migrated.setPermissionMode(audit.id, "plan");
  reopened.close();

  const again = openDb(dir);
  expect(new ConversationStore(again).get(audit.id)?.permission_mode).toBe("plan");
  again.close();
});
