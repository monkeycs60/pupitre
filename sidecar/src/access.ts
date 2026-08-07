import { homedir } from "node:os";
import { join } from "node:path";

export const FILESYSTEM_SCOPES = [
  "project-and-ai-roots",
  "full-system",
] as const;

export type FilesystemScope = typeof FILESYSTEM_SCOPES[number];

export const DEFAULT_FILESYSTEM_SCOPE: FilesystemScope = "project-and-ai-roots";

export function normalizeFilesystemScope(value: unknown): FilesystemScope {
  return value === "full-system" ? "full-system" : DEFAULT_FILESYSTEM_SCOPE;
}

/** Racines toujours accessibles : instructions, skills, plugins, prompts et mémoire. */
export function aiRoots(): string[] {
  const home = homedir();
  return [join(home, ".claude"), join(home, ".codex")];
}

