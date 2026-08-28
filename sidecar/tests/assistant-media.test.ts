import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importLocalMarkdownImages } from "../src/assistant-media";
import { assistantImageRoots } from "../src/assistant-media";
import { MediaStore } from "../src/media";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("importe une capture locale autorisée et réécrit sa source Markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-assistant-image-"));
  const data = mkdtempSync(join(tmpdir(), "pupitre-media-"));
  directories.push(root, data);
  const capture = join(root, "capture.png");
  writeFileSync(capture, new Uint8Array([137, 80, 78, 71]));

  const result = importLocalMarkdownImages(`![Capture](<${capture}>)`, new MediaStore(data), [root]);

  expect(result).toMatch(/^!\[Capture\]\(\/media\/[\w-]+\.png\)$/u);
});

test("laisse intacte une image située hors des racines autorisées", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-allowed-"));
  const outside = mkdtempSync(join(tmpdir(), "pupitre-outside-"));
  const data = mkdtempSync(join(tmpdir(), "pupitre-media-"));
  directories.push(root, outside, data);
  const capture = join(outside, "capture.png");
  writeFileSync(capture, new Uint8Array([137, 80, 78, 71]));

  const markdown = `![Capture](${capture})`;
  expect(importLocalMarkdownImages(markdown, new MediaStore(data), [root])).toBe(markdown);
});

test("importe les chemins Markdown avec parenthèses ou espaces encodées", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-assistant-image-"));
  const data = mkdtempSync(join(tmpdir(), "pupitre-media-"));
  directories.push(root, data);
  const capture = join(root, "Screenshot (1).png");
  writeFileSync(capture, new Uint8Array([137, 80, 78, 71]));
  const media = new MediaStore(data);

  const angled = importLocalMarkdownImages(`![Capture](<${capture}>)`, media, [root]);
  const encoded = importLocalMarkdownImages(`![Capture](${capture.replaceAll(" ", "%20")})`, media, [root]);

  expect(angled).toMatch(/^!\[Capture\]\(\/media\/[\w-]+\.png\)$/u);
  expect(encoded).toMatch(/^!\[Capture\]\(\/media\/[\w-]+\.png\)$/u);
});

test("refuse une image locale qui dépasse la limite média", () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-assistant-image-"));
  const data = mkdtempSync(join(tmpdir(), "pupitre-media-"));
  directories.push(root, data);
  const capture = join(root, "capture.png");
  writeFileSync(capture, new Uint8Array([137, 80, 78, 71]));
  const markdown = `![Capture](${capture})`;

  expect(importLocalMarkdownImages(markdown, new MediaStore(data), [root], new Map(), 3)).toBe(markdown);
});

test("autorise toutes les captures locales pour un projet full-system", () => {
  expect(assistantImageRoots({
    filesystemScope: "full-system",
    projectPath: "/workspace/project",
    conversationPath: "/workspace/project",
  }, ["/home/test/.claude", "/home/test/.codex"])).toEqual(["/"]);
});

test("borne les captures aux espaces de travail et racines IA par défaut", () => {
  expect(assistantImageRoots({
    filesystemScope: "project-and-ai-roots",
    projectPath: "/workspace/project",
    conversationPath: "/workspace/worktree",
  }, ["/home/test/.claude", "/home/test/.codex"])).toEqual([
    "/tmp",
    "/workspace/project",
    "/workspace/worktree",
    "/home/test/.claude",
    "/home/test/.codex",
  ]);
});
