import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EditorFolder } from "./editor-workspace";

const EXTENSIONS = "js|jsx|ts|tsx|mjs|cjs|mts|cts|json|jsonc|md|mdx|css|scss|sass|less|html|vue|svelte|py|rb|go|rs|java|kt|swift|php|sql|sh|bash|zsh|ya?ml|toml|ini|env|lock|txt|xml|graphql|gql|proto|c|h|cpp|hpp|cs|dart|lua|twig|hbs|ejs";
const CITATION = new RegExp(
  `^((?:~|\\.{1,2})?/?(?:[\\w@.+\\-\\[\\]()]+/)*(?:[\\w@+\\-\\[\\]()][\\w@.+\\-\\[\\]()]*\\.(?:${EXTENSIONS})|\\.env(?:\\.[\\w-]+)?|Dockerfile|Makefile))(?:(?::|#L)(\\d+)(?:[-–]L?\\d+)?(?::\\d+)?)?$`,
  "i",
);
const MAX_CANDIDATES = 12;
const LISTING_TTL_MS = 10_000;
const HISTORY_TTL_MS = 5 * 60_000;
const HISTORY_TIMEOUT_MS = 8_000;
const GENERIC_NAME = /^(?:package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|README\.md|CLAUDE\.md|AGENTS\.md|CHANGELOG\.md|\.env(?:\.[\w-]+)?|Dockerfile|Makefile|(?:index|main|app|config|routes|utils|types|constants|server)\.[a-z]+|[\w-]+\.config\.[a-z]+)$/i;

export interface FileCitation {
  path: string;
  line: number | null;
}

export type CitationResolution =
  | { status: "resolved"; path: string; line: number | null; label: string }
  | { status: "ambiguous"; line: number | null; candidates: Array<{ path: string; label: string }>; more: number }
  | { status: "elsewhere"; path: string | null; line: number | null; label: string; branch: string | null }
  | { status: "gone"; label: string; change: "deleted" | "renamed"; renamedTo: string | null; commit: string; date: string }
  | { status: "missing" };

/** Worktree du projet hors du workspace de la conversation : une autre branche où chercher un fichier cité. */
export interface OtherWorktree {
  path: string;
  branch: string | null;
  repositoryPath: string;
}

export interface CitationElsewhere {
  worktrees: OtherWorktree[];
  repositories: string[];
  /** Date (AAAA-MM-JJ) en deçà de laquelle une suppression ne peut pas concerner la conversation. */
  since?: string;
}

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
  elsewhere: CitationElsewhere = { worktrees: [], repositories: [] },
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

  const missing = [...pending].filter(([text, { citation }]) =>
    results[text]?.status === "missing"
    && !isAbsolute(citation.path) && !citation.path.startsWith("~/") && !citation.path.startsWith("./")
    && (citation.path.includes("/") || !GENERIC_NAME.test(citation.path))
    && ![...touched].some((path) => path.endsWith(`/${citation.path.replace(/^(\.\.\/)+/, "")}`)));
  const unresolved: Array<[string, string]> = [];
  for (const [text, { citation }] of missing) {
    const raw = citation.path.replace(/^(\.\.\/)+/, "");
    const found = await findElsewhere(raw, elsewhere.worktrees);
    if (found) {
      results[text] = {
        status: "elsewhere",
        path: found.path,
        line: citation.line,
        label: `${basename(found.worktree.repositoryPath)}/${relative(found.worktree.path, found.path).split(sep).join("/")}`,
        branch: found.worktree.branch,
      };
    } else {
      unresolved.push([text, raw]);
    }
  }
  if (unresolved.length > 0) {
    const scans = await Promise.all(elsewhere.repositories.map(async (repository) => ({
      repository,
      found: await history(repository, unresolved.map(([, raw]) => raw)),
    })));
    for (const [text, raw] of unresolved) {
      const hit = scans
        .flatMap(({ repository, found }) => {
          const trace = found.get(raw);
          return trace && (trace.kind === "kept" || !elsewhere.since || trace.date >= elsewhere.since) ? [{ repository, trace }] : [];
        })
        .sort((left, right) => right.trace.date.localeCompare(left.trace.date))[0];
      if (!hit) continue;
      const label = `${basename(hit.repository)}/${hit.trace.path}`;
      results[text] = hit.trace.kind === "kept"
        ? { status: "elsewhere", path: null, line: pending.get(text)!.citation.line, label, branch: hit.trace.branch }
        : {
          status: "gone",
          label,
          change: hit.trace.renamedTo ? "renamed" : "deleted",
          renamedTo: hit.trace.renamedTo,
          commit: hit.trace.commit,
          date: hit.trace.date,
        };
    }
  }
  return results;
}

async function findElsewhere(raw: string, worktrees: OtherWorktree[]): Promise<{ path: string; worktree: OtherWorktree } | null> {
  const suffix = `/${raw}`;
  for (const worktree of worktrees) {
    if (raw.includes("/") && isFile(join(worktree.path, raw))) return { path: join(worktree.path, raw), worktree };
  }
  const listed = await Promise.all(worktrees.map(async (worktree) => ({
    worktree,
    matches: (await listFiles(worktree.path)).filter((file) => `/${file}`.endsWith(suffix)),
  })));
  const holders = listed.filter((entry) => entry.matches.length > 0);
  const first = holders[0];
  return first && holders.every((entry) => entry.matches.length === 1) ? { path: join(first.worktree.path, first.matches[0]!), worktree: first.worktree } : null;
}

type FileTrace =
  | { kind: "gone"; path: string; renamedTo: string | null; commit: string; date: string }
  | { kind: "kept"; path: string; branch: string | null; commit: string; date: string };

const traces = new Map<string, { at: number; trace: Promise<FileTrace | null> }>();

function escapeGlob(path: string): string {
  return path.replace(/[[\]*?\\]/g, (character) => `\\${character}`);
}

async function git(repository: string, args: string[]): Promise<string | null> {
  const child = Bun.spawn(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), HISTORY_TIMEOUT_MS);
  const output = await new Response(child.stdout).text();
  clearTimeout(timer);
  return (await child.exited) === 0 ? output : null;
}

/**
 * Dernier commit qui touche chaque chemin cité, toutes branches confondues,
 * en une passe `git log` par dépôt. Une suppression ou un renommage donne
 * « supprimé » ; une simple modification veut dire que le fichier vit encore
 * sur une branche qui n'a pas de worktree.
 */
async function history(repository: string, paths: string[]): Promise<Map<string, FileTrace>> {
  const now = Date.now();
  const wanted = [...new Set(paths)].filter((path) => {
    const cached = traces.get(`${repository}\n${path}`);
    return !cached || now - cached.at > HISTORY_TTL_MS;
  });
  if (wanted.length > 0) {
    const scan = (async () => {
      const output = await git(repository, [
        "log", "--all", "-M", "--name-status", "--format=%x01%h%x00%as", "--",
        ...wanted.map((path) => `:(glob)**/${escapeGlob(path)}`),
      ]);
      const found = new Map<string, FileTrace>();
      for (const entry of (output ?? "").split("\x01").slice(1)) {
        const [header = "", ...lines] = entry.split("\n");
        const [commit = "", date = ""] = header.split("\0");
        for (const line of lines) {
          const [status = "", from = "", to = null] = line.split("\t");
          if (!from) continue;
          for (const path of wanted) {
            if (found.has(path) || !`/${from}`.endsWith(`/${path}`)) continue;
            found.set(path, /^[DR]/.test(status)
              ? { kind: "gone", path: from, renamedTo: status.startsWith("R") ? to : null, commit, date }
              : { kind: "kept", path: from, branch: null, commit, date });
          }
        }
      }
      for (const trace of found.values()) {
        if (trace.kind === "kept") {
          const branches = await git(repository, ["branch", "--all", "--contains", trace.commit, "--format=%(refname:short)"]);
          trace.branch = branches?.split("\n").find(Boolean) ?? null;
        } else if (trace.renamedTo === null) {
          const changes = await git(repository, ["show", "-M", "--name-status", "--format=", trace.commit]);
          const renamed = changes?.split("\n").map((line) => line.split("\t")).find(([status, from]) => status?.startsWith("R") && from === trace.path);
          trace.renamedTo = renamed?.[2] ?? null;
        }
      }
      return found;
    })();
    for (const path of wanted) {
      traces.set(`${repository}\n${path}`, { at: now, trace: scan.then((found) => found.get(path) ?? null) });
    }
  }
  const result = new Map<string, FileTrace>();
  for (const path of new Set(paths)) {
    const trace = await traces.get(`${repository}\n${path}`)!.trace;
    if (trace) result.set(path, trace);
  }
  return result;
}
