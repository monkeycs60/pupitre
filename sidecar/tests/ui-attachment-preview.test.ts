import { expect, test } from "bun:test";
import {
  formatAttachmentSize,
  getAttachmentPreviewKind,
  getAvailableAttachmentContent,
} from "../../ui/src/attachmentPreviewMeta";
import type { Attachment } from "../../ui/src/types";

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    name: "media-1",
    originalName: "document.txt",
    mimeType: "text/plain",
    size: 12,
    ...overrides,
  };
}

test("identifie les formats texte prévisualisables par MIME ou extension", () => {
  expect(getAttachmentPreviewKind(attachment())).toBe("text");
  expect(getAttachmentPreviewKind(attachment({ originalName: "notes.md", mimeType: "application/octet-stream" }))).toBe("markdown");
  expect(getAttachmentPreviewKind(attachment({ originalName: "data.json", mimeType: "" }))).toBe("json");
  expect(getAttachmentPreviewKind(attachment({ originalName: "payload", mimeType: "application/ld+json" }))).toBe("json");
  expect(getAttachmentPreviewKind(attachment({ originalName: "styles.css", mimeType: "text/css" }))).toBe("text");
  expect(getAttachmentPreviewKind(attachment({ originalName: "table.csv", mimeType: "text/csv" }))).toBe("csv");
  expect(getAttachmentPreviewKind(attachment({ originalName: "photo.pdf", mimeType: "application/pdf" }))).toBeNull();
});

test("lit uniquement le contenu inline déjà présent", () => {
  const inline = { ...attachment(), content: "déjà chargé" } as Attachment & { content: string };
  expect(getAvailableAttachmentContent(inline)).toBe("déjà chargé");
  expect(getAvailableAttachmentContent(attachment())).toBeNull();
  expect(getAvailableAttachmentContent({ ...inline, content: 42 } as Attachment)).toBeNull();
});

test("formate les métadonnées de taille sans effet de bord", () => {
  expect(formatAttachmentSize(12)).toBe("12 o");
  expect(formatAttachmentSize(2048)).toBe("2 Ko");
  expect(formatAttachmentSize(1_572_864)).toBe("1,5 Mo");
});
