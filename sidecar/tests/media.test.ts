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

test("importBytes écrit directement les octets reçus", async () => {
  const store = new MediaStore(mkdtempSync(join(tmpdir(), "pupitre-")));
  const name = store.importBytes(new Uint8Array([0, 1, 2, 255]), "png");
  expect(new Uint8Array(await Bun.file(store.absolutePath(name)).arrayBuffer()))
    .toEqual(new Uint8Array([0, 1, 2, 255]));
});
