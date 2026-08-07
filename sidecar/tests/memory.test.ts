import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory";

test("lit, édite et supprime uniquement les fichiers mémoire dans la racine", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-memory-"));
  mkdirSync(join(root, "project"));
  writeFileSync(join(root, "MEMORY.md"), "# Mémoire\n");
  writeFileSync(join(root, "project", "notes.md"), "Ancien");
  const outside = join(tmpdir(), `pupitre-outside-${crypto.randomUUID()}.md`);
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(root, "escape.md"));
  const memory = new MemoryStore(root);

  expect(memory.list().map((file) => file.path)).toEqual(["MEMORY.md", "project/notes.md"]);
  expect(memory.read("project/notes.md").content).toBe("Ancien");
  expect(memory.write("project/notes.md", "Nouveau").content).toBe("Nouveau");
  expect(() => memory.read("../secret.md")).toThrow(/invalide/);
  expect(() => memory.read("escape.md")).toThrow(/invalide|interdits/);
  memory.delete("project/notes.md");
  expect(memory.list().map((file) => file.path)).toEqual(["MEMORY.md"]);
});

test("crée et renomme un fichier Markdown sans écraser une cible", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-memory-create-"));
  const memory = new MemoryStore(root);

  expect(memory.create("notes.md", "# Notes").content).toBe("# Notes");
  expect(() => memory.create("notes.md", "autre")).toThrow(/existe déjà|porte déjà ce nom/);
  expect(() => memory.create("notes.txt", "texte")).toThrow(/Markdown/);
  expect(memory.rename("notes.md", "archive.md").path).toBe("archive.md");
  expect(() => memory.rename("archive.md", "../escape.md")).toThrow(/invalide/);
  expect(memory.read("archive.md").content).toBe("# Notes");
});
