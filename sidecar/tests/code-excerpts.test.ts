import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodeExcerpt } from "../src/code-excerpts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pupitre-code-"));
  roots.push(root);
  writeFileSync(join(root, "config.ts"), 'const port = 4821;\r\nexport const url = `http://localhost:${port}`;\r\n');
  return root;
}
const input = { path: "config.ts", title: "Le port local", explanation: "Le port détermine l’adresse du service.", startLine: 1, endLine: 2 };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("conserve le fichier exact et les surlignages même après une modification", async () => {
  const root = fixture();
  const excerpt = await readCodeExcerpt(root, { ...input, highlights: [{ startLine: 2, endLine: 2 }] });
  writeFileSync(join(root, "config.ts"), "modifié");
  expect(excerpt.path).toBe("config.ts");
  expect(excerpt.content).toContain("const port = 4821;\r\n");
  expect(excerpt.highlights).toEqual([{ startLine: 2, endLine: 2 }]);
  expect(excerpt.sha256).toHaveLength(64);
});

test("surligne le passage entier par défaut et accepte un chemin absolu du workspace", async () => {
  const root = fixture();
  expect((await readCodeExcerpt(root, { ...input, path: join(root, input.path) })).highlights)
    .toEqual([{ startLine: 1, endLine: 2 }]);
});

test("refuse les lignes hors fichier, inversées, fractionnaires et les surlignages hors passage", async () => {
  const root = fixture();
  for (const invalid of [
    { startLine: 0 }, { startLine: 1.5 }, { endLine: 3 }, { startLine: 2, endLine: 1 },
    { highlights: [{ startLine: 1, endLine: 3 }] }, { highlights: [{ startLine: 2, endLine: 1 }] },
    { explanation: " " }, { highlights: [] },
  ]) await expect(readCodeExcerpt(root, { ...input, ...invalid })).rejects.toThrow();
});

test("refuse les sorties du workspace, y compris les liens symboliques", async () => {
  const root = fixture();
  const other = fixture();
  symlinkSync(join(other, "config.ts"), join(root, "outside.ts"));
  for (const path of [join(other, "config.ts"), "../" + other.split('/').pop() + "/config.ts", "outside.ts"]) {
    await expect(readCodeExcerpt(root, { ...input, path })).rejects.toThrow("workspace");
  }
});

test("refuse les binaires, fichiers vides, UTF-8 invalide, dossiers et fichiers trop grands", async () => {
  const root = fixture();
  for (const content of [Buffer.from([0, 1, 2]), Buffer.from([255]), Buffer.from(''), Buffer.alloc(256 * 1024 + 1, 65), Buffer.from('a\n'.repeat(10_001))]) {
    writeFileSync(join(root, "config.ts"), content);
    await expect(readCodeExcerpt(root, input)).rejects.toThrow();
  }
  await expect(readCodeExcerpt(root, { ...input, path: "." })).rejects.toThrow();
});
