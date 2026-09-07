import type { Database } from "bun:sqlite";
import type { HtmlDocumentService, HtmlDocumentSnapshot } from "./html-documents";
import type { MediaStore } from "./media";

export interface SharedFileOrigin {
  conversationId: string;
  conversationTitle: string;
  eventId: number;
  sender: "user" | "assistant";
  createdAt: string;
}

export interface SharedFile {
  id: string;
  name: string;
  kind: "image" | "document" | "file";
  mimeType: string;
  sizeBytes: number | null;
  mediaName: string | null;
  document: HtmlDocumentSnapshot | null;
  origins: SharedFileOrigin[];
}

interface FileEvent {
  id: number;
  conversation_id: string;
  title: string;
  created_at: string;
  type: string;
  images: string | null;
  attachments: string | null;
  document_id: string | null;
  text: string | null;
}

function mediaName(value: string): string | null {
  if (typeof value !== "string") return null;
  const name = value.startsWith("/media/") ? value.slice(7) : value;
  return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name) ? name : null;
}

export class SharedFilesService {
  constructor(private db: Database, private media: MediaStore, private documents: HtmlDocumentService) {}

  list(projectId: string, conversationId?: string): SharedFile[] {
    // Projection évitant de transférer les sorties d'outils et les transcriptions complètes.
    const rows = this.db.query(`
      SELECT e.id, e.conversation_id, c.title, e.created_at,
        json_extract(e.payload, '$.type') AS type,
        json_extract(e.payload, '$.images') AS images,
        json_extract(e.payload, '$.attachments') AS attachments,
        json_extract(e.payload, '$.documentId') AS document_id,
        CASE WHEN json_extract(e.payload, '$.type') = 'text-final'
          THEN json_extract(e.payload, '$.text') ELSE NULL END AS text
      FROM conversations c JOIN events e ON e.conversation_id = c.id
      WHERE c.project_id = ? AND c.deleted_at IS NULL
        AND (? IS NULL OR c.id = ?)
        AND json_valid(e.payload)
        AND (json_extract(e.payload, '$.type') IN ('user-message', 'tool-end', 'document-ref', 'html-document-ref', 'test-scope-result')
          OR (json_extract(e.payload, '$.type') = 'text-final' AND instr(e.payload, '/media/') > 0))
      ORDER BY e.id DESC
    `).all(projectId, conversationId ?? null, conversationId ?? null) as FileEvent[];
    const files = new Map<string, SharedFile>();
    const add = (file: Omit<SharedFile, "origins">, origin: SharedFileOrigin) => {
      const existing = files.get(file.id);
      if (existing) {
        if (existing.mediaName && file.name !== file.mediaName) existing.name = file.name;
        if (existing.document?.state === "expired" && file.document && file.document.state !== "expired") existing.document = file.document;
        if (!existing.origins.some((entry) => entry.eventId === origin.eventId)) existing.origins.push(origin);
      } else files.set(file.id, { ...file, origins: [origin] });
    };
    for (const row of rows) {
      const origin: SharedFileOrigin = { conversationId: row.conversation_id, conversationTitle: row.title,
        eventId: row.id, sender: row.type === "user-message" ? "user" : "assistant", createdAt: row.created_at };
      const addMedia = (value: string, attachment?: { originalName: string; mimeType: string; size: number }) => {
        const name = mediaName(value);
        if (!name) return;
        let sizeBytes: number | null = null;
        try { sizeBytes = this.media.byteLength(name); } catch { /* La référence reste consultable si le fichier a disparu. */ }
        const mimeType = attachment?.mimeType ?? (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(name) ? `image/${name.split('.').pop()}` : "application/octet-stream");
        add({ id: `media:${name}`, name: attachment?.originalName ?? name, kind: mimeType.startsWith("image/") ? "image" : "file",
          mimeType, sizeBytes, mediaName: name, document: null }, origin);
      };
      for (const attachment of JSON.parse(row.attachments ?? "[]")) addMedia(attachment.name, attachment);
      for (const value of JSON.parse(row.images ?? "[]")) addMedia(value);
      for (const match of row.text?.matchAll(/!?\[[^\]]*\]\(<?(\/media\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)>?\)/g) ?? []) addMedia(match[1]!);
      if (row.document_id) {
        const document = this.documents.get(row.document_id, { readOnly: true });
        if (!document || document.projectId !== projectId || document.state === "deleted") continue;
        add({ id: `document:${document.sha256 || document.id}`, name: document.title, kind: "document", mimeType: document.mimeType,
          sizeBytes: document.sizeBytes, mediaName: null, document }, origin);
      }
    }
    return [...files.values()];
  }
}
