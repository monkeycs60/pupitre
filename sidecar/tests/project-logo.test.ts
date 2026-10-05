import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectLogo } from "../src/project-logo";

function repo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "pupitre-logo-"));
  mkdirSync(join(root, ".git"));
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x");
  }
  return root;
}

test("prefers a named logo over app icons and favicons", () => {
  const root = repo(["ui/public/favicon.svg", "src-tauri/icons/icon.png", "src-tauri/icons/128x128.png", "assets/logo.png"]);
  try {
    expect(detectProjectLogo(root, 0)).toBe(join(root, "assets/logo.png"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ignores dependencies, hidden folders and unrelated images", () => {
  const root = repo(["node_modules/pkg/logo.svg", ".github/logo.svg", "public/hero.png", "favicon.ico"]);
  try {
    expect(detectProjectLogo(root, 0)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("finds nothing outside a Git repository", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-logo-"));
  writeFileSync(join(root, "logo.png"), "x");
  try {
    expect(detectProjectLogo(root, 0)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
