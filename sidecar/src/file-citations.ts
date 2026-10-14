import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EditorFolder } from "./editor-workspace";

const EXTENSIONS = "js|jsx|ts|tsx|mjs|cjs|mts|cts|json|jsonc|md|mdx|css|scss|sass|less|html|vue|svelte|py|rb|go|rs|java|kt|swift|php|sql|sh|bash|zsh|ya?ml|toml|ini|env|lock|txt|xml|graphql|gql|proto|c|h|cpp|hpp|cs|dart|lua|twig|hbs|ejs";
const CITATION = new RegExp(
  `^((?:~|\\.{1,2})?/?(?:[\\w@.+\\-\\[\\]()]+/)*(?:[\\w@+\\-\\[\\]()][\\w@.+\\-\\[\\]()]*\\.(?:${EXTENSIONS})|\\.env(?:\\.[\\w-]+)?|Dockerfile|Makefile))(?:(?::|#L)(\\d+)(?:[-–]L?\\d+)?(?::\\d+)?)?$`,
  "i",
);
const MAX_CANDIDATES = 12;
const LISTING_TTL_MS = 10_000;

export interface FileCitation {
  path: string;
  line: number | null;
}

export type CitationResolution =
  | { status: "resolved"; path: string; line: number | null; label: string }
  | { status: "ambiguous"; line: number | null; candidates: Array<{ path: string; label: string }>; more: number }
  | { status: "missing" };

export function parseCitation(text: string): FileCitation | null {
  const match = text.trim().match(CITATION);
  if (!match || /^https?:/i.test(text)) return null;
  return { path: match[1]!, line: match[2] ? Number(match[2]) : null };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const listings = new Map<string, { at: number; files: Promise<string[]> }>();

function listFiles(folder: string): Promise<string[]> {
  const cached = listings.get(folder);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.files;
  const files = (async () => {
    const child = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: folder, stdout: "pipe", stderr: "ignore",
    });
    const output = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? output.split("\0").filter(Boolean) : [];
  })();
  listings.set(folder, { at: Date.now(), files });
  return files;
}

/** Chemins absolus cités dans les entrées d'outils : les fichiers que l'agent a réellement lus ou modifiés. */
export function touchedFiles(toolInputs: unknown[]): Set<string> {
  const found = new Set<string>();
  for (const input of toolInputs) {
    for (const match of JSON.stringify(input ?? null).matchAll(/(\/(?:home|Users|tmp)\/[^\s"'`\\]+\.[A-Za-z]{1,6})/g)) {
      found.add(resolve(match[1]!));
    }
  }
  return found;
}

function labelFor(path: string, folders: EditorFolder[]): string {
  const owner = folders
    .filter((folder) => path.startsWith(`${folder.path}${sep}`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!owner) return path;
  const inside = relative(owner.path, path).split(sep).join("/");
  return owner === folders[0] ? inside : `${owner.name}/${inside}`;
}

/**
 * Retrouve les fichiers cités dans une réponse parmi les dossiers que la
 * fenêtre VS Code de la conversation ouvrirait. Les citations d'un même lot
 * se départagent entre elles : `common.js` cité après
 * `lib/agent/mutations/index.js` désigne le fichier du même dossier.
 * `./chemin` se lit depuis le répertoire de travail de la conversation seul.
 */
export async function resolveCitations(
  texts: string[],
  folders: EditorFolder[],
  cwd: string,
  extraRoots: string[],
  touched: Set<string>,
): Promise<Record<string, CitationResolution>> {
  const roots = [...new Set([
    ...folders.map((folder) => folder.path),
    ...extraRoots,
    ...folders.slice(1).map((folder) => dirname(folder.path)),
  ])];
  const pending = new Map<string, { citation: FileCitation; candidates: string[] }>();
  const results: Record<string, CitationResolution> = {};

  for (const text of new Set(texts)) {
    const citation = parseCitation(text);
    if (!citation) {
      results[text] = { status: "missing" };
      continue;
    }
    const raw = citation.path.replace(/^\.\//, "");
    let candidates: string[];
    if (citation.path.startsWith("./")) {
      candidates = isFile(resolve(cwd, raw)) ? [resolve(cwd, raw)] : [];
    } else if (isAbsolute(raw) || raw.startsWith("~/")) {
      const absolute = raw.startsWith("~/") ? join(process.env.HOME ?? "", raw.slice(2)) : raw;
      candidates = isFile(absolute) ? [resolve(absolute)] : [];
    } else {
      const atRoots = [...new Set(roots.map((root) => resolve(root, raw)).filter(isFile))];
      candidates = raw.includes("/") ? atRoots : [];
      if (candidates.length === 0) {
        const suffix = `/${raw.replace(/^(\.\.\/)+/, "")}`;
        const listed = await Promise.all(folders.map(async (folder) => (await listFiles(folder.path))
          .filter((file) => `/${file}`.endsWith(suffix))
          .map((file) => join(folder.path, file))));
        candidates = [...new Set([...atRoots, ...listed.flat()])];
      }
    }
    pending.set(text, { citation, candidates });
  }

  const order = [...pending.keys()];
  const resolvedDirectory = order.map((text) => {
    const { candidates } = pending.get(text)!;
    return candidates.length === 1 ? dirname(candidates[0]!) : null;
  });
  for (const [index, text] of order.entries()) {
    const { citation, candidates } = pending.get(text)!;
    let narrowed = candidates;
    if (narrowed.length > 1) {
      const read = narrowed.filter((path) => touched.has(path));
      if (read.length >= 1) narrowed = read;
    }
    for (let distance = 1; narrowed.length > 1 && distance < order.length; distance += 1) {
      const directories = [resolvedDirectory[index - distance], resolvedDirectory[index + distance]];
      const near = narrowed.filter((path) => directories.includes(dirname(path)));
      if (near.length >= 1) narrowed = near;
    }
    if (narrowed.length === 0) {
      results[text] = { status: "missing" };
    } else if (narrowed.length === 1) {
      results[text] = { status: "resolved", path: narrowed[0]!, line: citation.line, label: labelFor(narrowed[0]!, folders) };
    } else {
      const ordered = [...narrowed].sort((left, right) =>
        left.length - right.length || left.localeCompare(right));
      results[text] = {
        status: "ambiguous",
        line: citation.line,
        candidates: ordered.slice(0, MAX_CANDIDATES).map((path) => ({ path, label: labelFor(path, folders) })),
        more: Math.max(0, ordered.length - MAX_CANDIDATES),
      };
    }
  }
  return results;
}
