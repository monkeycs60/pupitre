import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaStore } from "../src/media";

test("importe un fichier image et renvoie un nom servable", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pupitre-"));
  const src = join(dataDir, "shot.png");
  writeFileSync(src, "fake-png-bytes");
  const store = new MediaStore(dataDir);
  const name = store.importFile(src);
  expect(name).toMatch(/^[0-9a-f-]+\.png$/);
  expect(existsSync(store.absolutePath(name))).toBe(true);
});

test("importFromBase64 écrit le fichier décodé", () => {
  const store = new MediaStore(mkdtempSync(join(tmpdir(), "pupitre-")));
  const name = store.importFromBase64(Buffer.from("hello").toString("base64"), "png");
  expect(Bun.file(store.absolutePath(name)).size).toBe(5);
});
