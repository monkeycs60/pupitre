import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import type { HtmlDocumentService } from "../src/html-documents";
import { ProjectDevlogService } from "../src/project-devlog";
test("le devlog publie un document du projet et les notes imposent un style utilisateur", async () => {
  const root = mkdtempSync(join(tmpdir(), "devlog-"));
  const db = openDb(root);
  try {
    const projects = new ProjectStore(db),
      conversations = new ConversationStore(db);
    const p = projects.create({ name: "Vrac", path: root });
    let prompt = "",
      published = "";
    const documents = {
      publish: async (id: string, input: { path: string; title: string }) => {
        published = input.title;
        expect(conversations.get(id)?.project_id).toBe(p.id);
        expect(conversations.get(id)?.origin_type).toBe("documents");
        expect(await Bun.file(input.path).text()).toBe(
          "Des idées plus faciles à retrouver.",
        );
        return { id: "doc" };
      },
    } as unknown as HtmlDocumentService;
    const service = new ProjectDevlogService(
      db,
      projects,
      conversations,
      documents,
      async (text) => {
        prompt = text;
        return "Des idées plus faciles à retrouver.";
      },
    );
    await service.create(p.id, {
      kind: "release",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(prompt).toContain("Aucun nom de fichier");
    const dedicated = service.documentsConversation(p.id);
    expect(dedicated.origin_type).toBe("documents");
    expect(dedicated.title).toBe("Documents du projet");
    conversations.create({
      projectId: p.id,
      provider: "claude",
      model: "x",
      firstMessage: "Autre travail",
    });
    expect(service.documentsConversation(p.id).id).toBe(dedicated.id);
    expect(
      (db.query("SELECT ticket_locked FROM conversations WHERE id=?").get(dedicated.id) as { ticket_locked: number }).ticket_locked,
    ).toBe(1);
    expect(published).toContain("Notes de version · Vrac");
    await expect(service.create(p.id, { from: "bad" })).rejects.toThrow(
      "période",
    );
    const insert = db.query(
      "INSERT INTO documents (id,project_id,title,relative_path,size_bytes,sha256,created_at,expired_at) VALUES (?,?,?,'x',1,'x',?,?)",
    );
    insert.run("d1", p.id, "Devlog · Vrac · a — b", "2026-09-02", null);
    insert.run("d2", p.id, "Notes de version · Vrac · a — b", "2026-09-03", null);
    insert.run("d3", p.id, "Capture de la landing", "2026-09-04", null);
    insert.run("d4", p.id, "Devlog · Vrac · ancien", "2026-08-01", "2026-08-30");
    expect(service.overview(p.id).documents.map((d: any) => d.id)).toEqual([
      "d2",
      "d1",
    ]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("la migration range les anciens devlogs dans « Documents du projet » avec leur carte", () => {
  const root = mkdtempSync(join(tmpdir(), "devlog-migration-"));
  const db = openDb(root);
  try {
    const projects = new ProjectStore(db),
      conversations = new ConversationStore(db);
    const p = projects.create({ name: "Vrac", path: root });
    const legacy = conversations.create({
      projectId: p.id,
      provider: "codex",
      model: "x",
      firstMessage: "Documents du projet",
    });
    const work = conversations.create({
      projectId: p.id,
      provider: "claude",
      model: "x",
      firstMessage: "Refonte de la landing",
    });
    const insert = db.query(
      "INSERT INTO documents (id,conversation_id,project_id,title,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,'x',1,'x','2026-09-02')",
    );
    insert.run("devlog", work.id, p.id, "Devlog · Vrac · a — b");
    insert.run("capture", work.id, p.id, "Capture de la landing");
    conversations.appendStoredEvent(work.id, { type: "document-ref", documentId: "devlog" } as any);
    conversations.appendStoredEvent(work.id, { type: "document-ref", documentId: "capture" } as any);
    const service = new ProjectDevlogService(
      db,
      projects,
      conversations,
      {} as HtmlDocumentService,
      async () => "",
    );
    expect(service.migrateDocuments()).toBe(1);
    expect(service.migrateDocuments()).toBe(0);
    const owner = (id: string) =>
      (db.query("SELECT conversation_id AS c FROM documents WHERE id=?").get(id) as { c: string }).c;
    const eventOwner = (id: string) =>
      (db.query("SELECT conversation_id AS c FROM events WHERE json_extract(payload,'$.documentId')=?").get(id) as { c: string }).c;
    expect(owner("devlog")).toBe(legacy.id);
    expect(eventOwner("devlog")).toBe(legacy.id);
    expect(owner("capture")).toBe(work.id);
    expect(eventOwner("capture")).toBe(work.id);
    expect(conversations.get(legacy.id)?.origin_type).toBe("documents");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
