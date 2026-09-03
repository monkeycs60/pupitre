import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { StoredEvent } from "../src/events";
import { HtmlDocumentService } from "../src/html-documents";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(initialNow = "2026-08-10T10:00:00.000Z") {
  const directory = mkdtempSync(join(tmpdir(), "pupitre-html-documents-"));
  const projectPath = join(directory, "project");
  mkdirSync(projectPath);
  const db = openDb(directory);
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "Pupitre", path: projectPath });
  const conversations = new ConversationStore(db);
  const conversation = conversations.create({
    projectId: project.id,
    provider: "codex",
    model: "gpt-5.6-luna",
    firstMessage: "Publie un audit",
  });
  const broadcasts: StoredEvent[] = [];
  let now = new Date(initialNow);
  const service = new HtmlDocumentService(
    db,
    directory,
    conversations,
    projects,
    (_conversationId, event) => broadcasts.push(event),
    () => now,
  );
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    directory,
    projectPath,
    conversations,
    conversation,
    broadcasts,
    service,
    setNow(value: string) { now = new Date(value); },
  };
}

function minimalPdf(text: string): string {
  const stream = `BT /F1 18 Tf 72 740 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

test("publie une copie gérée, diffuse l'événement et supprime seulement la source temporaire", async () => {
  const env = harness();
  const source = join(env.directory, "audit.html");
  writeFileSync(source, "<!doctype html><html><body><h1>Audit</h1></body></html>");

  const document = await env.service.publish(env.conversation.id, {
    path: source,
    title: "Audit plateforme",
    summary: "Décisions prioritaires",
    deleteSource: true,
  });

  expect(document).toMatchObject({
    title: "Audit plateforme",
    summary: "Décisions prioritaires",
    state: "retained",
  });
  expect(existsSync(source)).toBe(false);
  expect(env.broadcasts).toHaveLength(1);
  expect(env.broadcasts[0]).toMatchObject({
    type: "html-document-ref",
    documentId: document.id,
    title: "Audit plateforme",
  });
  expect(env.conversations.listEvents(env.conversation.id).at(-1)).toMatchObject({
    type: "html-document-ref",
    documentId: document.id,
  });
  expect(await env.service.list({ query: "Audit" })).toEqual([
    expect.objectContaining({ id: document.id, searchSnippet: expect.stringContaining("<mark>") }),
  ]);

  const grant = env.service.issueViewToken(document.id);
  expect(readFileSync(env.service.contentPath(document.id, grant.token), "utf8"))
    .toContain("<h1>Audit</h1>");
});

test("ne supprime jamais un fichier source appartenant au projet", async () => {
  const env = harness();
  const source = join(env.projectPath, "decision.html");
  writeFileSync(source, "<html><body>Décision</body></html>");

  await env.service.publish(env.conversation.id, {
    path: source,
    title: "Décision",
    deleteSource: true,
  });

  expect(existsSync(source)).toBe(true);
});

test("accepte /tmp même quand TMPDIR pointe ailleurs", async () => {
  if (process.platform === "win32") return;
  const env = harness();
  const sourceDirectory = mkdtempSync("/tmp/pupitre-html-document-");
  const source = join(sourceDirectory, "audit.html");
  writeFileSync(source, "<!doctype html><title>Audit</title>");
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = env.directory;
  try {
    await env.service.publish(env.conversation.id, {
      path: source,
      title: "Audit",
      deleteSource: true,
    });
    expect(existsSync(source)).toBe(false);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    rmSync(sourceDirectory, { recursive: true, force: true });
  }
});

test("reste disponible après 24 heures sans expiration automatique", async () => {
  const env = harness();
  const source = join(env.directory, "roadmap.html");
  writeFileSync(source, "<html><body>Roadmap</body></html>");
  const document = await env.service.publish(env.conversation.id, {
    path: source,
    title: "Roadmap",
  });
  env.setNow("2026-08-11T10:00:01.000Z");
  expect(env.service.sweepExpired()).toBe(0);
  expect(env.service.get(document.id)).toMatchObject({ state: "retained", expiresAt: null });
  const grant = env.service.issueViewToken(document.id);
  expect(env.service.contentPath(document.id, grant.token)).toContain(document.id);
  expect(env.conversations.listEvents(env.conversation.id).at(-1)).toMatchObject({
    type: "html-document-ref",
    title: "Roadmap",
  });
});

test("la conservation annule l'expiration et la suppression reste idempotente", async () => {
  const env = harness();
  const source = join(env.directory, "plan.html");
  writeFileSync(source, "<html><body>Plan</body></html>");
  const document = await env.service.publish(env.conversation.id, { path: source, title: "Plan" });

  expect(env.service.retain(document.id)).toMatchObject({
    state: "retained",
    expiresAt: null,
  });
  env.setNow("2026-08-20T10:00:00.000Z");
  expect(env.service.sweepExpired()).toBe(0);
  expect(env.service.delete(document.id)).toMatchObject({ state: "deleted" });
  expect(env.service.delete(document.id)).toMatchObject({ state: "deleted" });
});

test("refuse un faux document HTML", async () => {
  const env = harness();
  const source = join(env.directory, "texte.html");
  writeFileSync(source, "ceci n'est pas un document HTML");
  await expect(env.service.publish(env.conversation.id, { path: source, title: "Faux" }))
    .rejects.toThrow(/contenu HTML autonome/i);
});

test("publie et retrouve un PDF avec sa provenance dans la vue Documents", async () => {
  const env = harness();
  const source = join(env.projectPath, "rapport.pdf");
  writeFileSync(source, minimalPdf("Recherche interieure PDF"));

  const document = await env.service.publish(env.conversation.id, {
    path: source,
    title: "Rapport PDF",
    summary: "Version imprimable",
  });

  expect(document).toMatchObject({
    kind: "pdf",
    mimeType: "application/pdf",
    originalName: "rapport.pdf",
    state: "retained",
  });
  expect(env.broadcasts.at(-1)).toMatchObject({
    type: "document-ref",
    kind: "pdf",
  });
  expect(await env.service.list({ kind: "pdf" })).toEqual([
    expect.objectContaining({
      id: document.id,
      projectName: "Pupitre",
      conversationTitle: expect.any(String),
    }),
  ]);
  expect(await env.service.list({ query: "interieure" })).toEqual([
    expect.objectContaining({ id: document.id, matchCount: 1 }),
  ]);
  const grant = env.service.issueViewToken(document.id);
  expect(env.service.content(document.id, grant.token)).toMatchObject({
    mimeType: "application/pdf",
    originalName: "rapport.pdf",
    kind: "pdf",
  });
});

test("enregistre atomiquement un document texte avec contrôle de version", async () => {
  const env = harness();
  const source = join(env.projectPath, "donnees.csv");
  writeFileSync(source, "nom,valeur\nalpha,1\n");
  const document = await env.service.publish(env.conversation.id, { path: source, title: "Données" });

  const updated = await env.service.updateText(document.id, "nom,valeur\nbeta,2\n", document.sha256);
  expect(updated.sha256).not.toBe(document.sha256);
  const grant = env.service.issueViewToken(document.id);
  expect(readFileSync(env.service.contentPath(document.id, grant.token), "utf8")).toContain("beta,2");
  await expect(env.service.updateText(document.id, "ancien", document.sha256)).rejects.toThrow(/modifié/i);
});
