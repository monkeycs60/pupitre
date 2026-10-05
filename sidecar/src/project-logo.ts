import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const LOGO_NAMES: readonly [RegExp, number][] = [
  [/^logo$/i, 0],
  [/^logo[-_]?(mark|icon|square)$/i, 1],
  [/^icon$/i, 2],
  [/^logo[-_]min[-_][\w-]+$/i, 3],
  [/^(128x128|icon[-_]?(512|256|192|128))$/i, 4],
  [/^apple-touch-icon$/i, 5],
  [/^favicon$/i, 6],
];
const LOGO_EXTENSIONS = new Set([".svg", ".png", ".webp"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage", "vendor", "tmp",
  "android", "ios", "Pods", "__pycache__", "venv",
]);
const MAX_DEPTH = 4;
const MAX_VISITED_ENTRIES = 6000;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;

export const LOGO_MIME_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

const cache = new Map<string, { at: number; path: string | null }>();

/**
 * Logo le plus probable d'un dépôt : nom reconnu, puis profondeur la plus
 * faible. Le parcours est borné, car un monorepo peut contenir des centaines
 * de milliers de fichiers. Un dossier hors Git (Téléchargements…) n'a pas de
 * logo : n'importe quelle image s'y appelle `logo.png`.
 */
export function detectProjectLogo(root: string, now = Date.now()): string | null {
  const cached = cache.get(root);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.path;
  if (!existsSync(join(root, ".git"))) {
    cache.set(root, { at: now, path: null });
    return null;
  }
  let best: { path: string; score: number } | null = null;
  let visited = 0;
  const queue: [string, number][] = [[root, 0]];
  while (queue.length && visited < MAX_VISITED_ENTRIES) {
    const [directory, depth] = queue.shift()!;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) queue.push([path, depth + 1]);
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || !LOGO_EXTENSIONS.has(extension)) continue;
      const stem = entry.name.slice(0, -extension.length);
      const rank = LOGO_NAMES.find(([pattern]) => pattern.test(stem))?.[1];
      if (rank === undefined) continue;
      try { if (statSync(path).size > MAX_LOGO_BYTES) continue; } catch { continue; }
      const segments = relative(root, path).split(sep).length - 1;
      const score = rank * 2 + segments + (extension === ".svg" ? 0 : 0.5);
      if (!best || score < best.score) best = { path, score };
    }
  }
  cache.set(root, { at: now, path: best?.path ?? null });
  return best?.path ?? null;
}
