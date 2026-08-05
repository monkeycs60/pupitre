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
  expect(() => memory.read("escape.md")).toThrow(/invalide/);
  memory.delete("project/notes.md");
  expect(memory.list().map((file) => file.path)).toEqual(["MEMORY.md"]);
});
