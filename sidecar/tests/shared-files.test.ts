import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SharedFilesService } from "../src/shared-files";
import type { HtmlDocumentService } from "../src/html-documents";
import { MediaStore } from "../src/media";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shared-files-'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversations (id TEXT, project_id TEXT, title TEXT, deleted_at TEXT, archived INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, conversation_id TEXT, payload TEXT, created_at TEXT);
    INSERT INTO conversations VALUES ('active', 'p1', 'Active', NULL, 0), ('archive', 'p1', 'Archive', NULL, 1), ('trash', 'p1', 'Trash', '2026-01-01', 0), ('other', 'p2', 'Other', NULL, 0);`);
  const media = new MediaStore(directory);
  const image = media.importBytes(new Uint8Array([1, 2, 3]), 'png');
  const attachment = media.importBytes(new Uint8Array([4, 5]), 'txt');
  const append = (id: number, conversation: string, event: object) => db.query('INSERT INTO events VALUES (?, ?, ?, ?)').run(id, conversation, JSON.stringify(event), '2026-09-07T12:00:00Z');
  const documents = { get: (id: string) => id === 'doc-other' ? { id, projectId: 'p2' } : { id, projectId: 'p1', sha256: 'same', title: 'Audit', mimeType: 'text/html', sizeBytes: 50, state: 'available' } } as unknown as HtmlDocumentService;
  cleanups.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { append, image, attachment, service: new SharedFilesService(db, media, documents) };
}

test('isole le projet et la conversation, inclut les archives et exclut la corbeille', () => {
  const { append, image, service } = fixture();
  for (const [index, conversation] of ['active', 'archive', 'trash', 'other'].entries()) append(index + 1, conversation, { type: 'user-message', images: [image] });
  expect(service.list('p1')[0]?.origins.map((origin) => origin.conversationId)).toEqual(['archive', 'active']);
  expect(service.list('p1', 'active')[0]?.origins).toHaveLength(1);
  expect(service.list('p1', 'other')).toEqual([]);
});

test('déduplique les images utilisateur et agent, garde les pièces jointes et leurs origines', () => {
  const { append, image, attachment, service } = fixture();
  append(1, 'active', { type: 'user-message', images: [image], attachments: [{ name: attachment, originalName: 'notes.txt', mimeType: 'text/plain', size: 2 }] });
  append(2, 'active', { type: 'tool-end', images: [image, 'https://remote.test/image.png'], output: 'ignored' });
  append(3, 'active', { type: 'text-final', text: `![Image](/media/${image})` });
  const files = service.list('p1');
  expect(files).toHaveLength(2);
  expect(files.find((file) => file.kind === 'image')?.origins).toHaveLength(3);
  expect(files.find((file) => file.kind === 'file')?.name).toBe('notes.txt');
});

test('déduplique les documents identiques sans inclure les références d’un autre projet', () => {
  const { append, service } = fixture();
  append(1, 'active', { type: 'document-ref', documentId: 'doc-a' });
  append(2, 'archive', { type: 'html-document-ref', documentId: 'doc-b' });
  append(3, 'active', { type: 'document-ref', documentId: 'doc-other' });
  const files = service.list('p1');
  expect(files).toHaveLength(1);
  expect(files[0]?.origins).toHaveLength(2);
});
