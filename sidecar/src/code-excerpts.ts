import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppEvent } from "./events";

const line = z.number().int().positive();
const range = z.object({ startLine: line, endLine: line });
export const codeExcerptInput = z.object({
  path: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  explanation: z.string().trim().min(1).max(4000),
  startLine: line,
  endLine: line,
  highlights: z.array(range).min(1).max(30).optional(),
});

export class CodeExcerptError extends Error {}

const MAX_BYTES = 256 * 1024;
const MAX_LINES = 10_000;

/** Worktree de dépôt que la conversation ouvre en plus de son répertoire de travail. */
export interface CodeExcerptRoot {
  name: string;
  path: string;
  /** Emplacement du dépôt dans le projet (`apps/hapigator`), tel que l'agent le voit depuis le monorepo. */
  location: string | null;
}

function inside(root: string, path: string): string | null {
  const inner = relative(root, path);
  return isAbsolute(inner) || inner === ".." || inner.startsWith(`..${sep}`) ? null : inner;
}

async function existing(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function readCodeExcerpt(
  root: string,
  input: unknown,
  extraRoots: CodeExcerptRoot[] = [],
): Promise<Extract<AppEvent, { type: "code-excerpt" }>> {
  const parsed = codeExcerptInput.safeParse(input);
  if (!parsed.success) throw new CodeExcerptError("Chemin, titre, explication et lignes valides requis.");
  const data = parsed.data;
  const workspace = await existing(root);
  if (!workspace) throw new CodeExcerptError("Fichier introuvable dans le workspace.");
  const roots = [
    { name: null as string | null, path: workspace },
    ...(await Promise.all(extraRoots.map(async (extra) => ({ name: extra.name, path: await existing(extra.path), location: extra.location }))))
      .flatMap((extra) => extra.path ? [{ ...extra, path: extra.path }] : []),
  ];

  let source: string | null = null;
  if (!isAbsolute(data.path)) {
    const wanted = data.path.replace(/^\.\//, "").split(sep).join("/");
    for (const extra of extraRoots) {
      if (!extra.location || !wanted.startsWith(`${extra.location}/`)) continue;
      source = await existing(join(extra.path, wanted.slice(extra.location.length + 1)));
      if (source) break;
    }
  }
  source ??= await existing(resolve(workspace, data.path));
  if (!source) throw new CodeExcerptError("Fichier introuvable dans le workspace.");
  const owner = roots
    .map((candidate) => ({ ...candidate, inner: inside(candidate.path, source!) }))
    .filter((candidate) => candidate.inner !== null)
    .sort((left, right) => (left.name === null ? -1 : 0) - (right.name === null ? -1 : 0) || right.path.length - left.path.length)[0];
  if (!owner) {
    throw new CodeExcerptError("Le fichier doit appartenir au workspace de la conversation ou à l'un de ses worktrees.");
  }
  const inner = owner.inner!.split(sep).join("/");
  const path = owner.name === null ? inner : `${owner.name}/${inner}`;
  const file = await open(source, "r");
  let content: string;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new CodeExcerptError("Un fichier texte est requis.");
    if (info.size > MAX_BYTES) throw new CodeExcerptError("Fichier trop volumineux (maximum 256 Kio).");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw new CodeExcerptError("Fichier trop volumineux (maximum 256 Kio).");
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead)); }
    catch { throw new CodeExcerptError("Un fichier texte UTF-8 est requis."); }
    if (content.includes("\0")) throw new CodeExcerptError("Les fichiers binaires ne sont pas pris en charge.");
  } finally {
    await file.close();
  }
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_LINES) throw new CodeExcerptError("Fichier trop long (maximum 10 000 lignes).");
  if (data.startLine > data.endLine || data.endLine > lines.length) {
    throw new CodeExcerptError(`Passage invalide : le fichier comporte ${lines.length} lignes.`);
  }
  const highlights = data.highlights ?? [{ startLine: data.startLine, endLine: data.endLine }];
  if (highlights.some((item) => item.startLine > item.endLine || item.startLine < data.startLine || item.endLine > data.endLine)) {
    throw new CodeExcerptError("Les surlignages doivent être compris dans le passage cité.");
  }
  return {
    type: "code-excerpt", excerptId: crypto.randomUUID(), path, absolutePath: source,
    title: data.title, explanation: data.explanation, content,
    startLine: data.startLine, endLine: data.endLine, highlights,
    sha256: createHash("sha256").update(content).digest("hex"), createdAt: new Date().toISOString(),
  };
}
