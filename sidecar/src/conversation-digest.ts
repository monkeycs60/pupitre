import { spawn } from "node:child_process";

/** Modèle volontairement bon marché : le digest tourne à chaque palier de tours. */
const DIGEST_MODEL = process.env.PUPITRE_DIGEST_MODEL ?? "claude-haiku-4-5-20251001";
const DIGEST_TIMEOUT_MS = 45_000;
/** Bornes des textes envoyés : un digest ne doit jamais coûter un vrai tour. */
const FIRST_MAX = 1_200;
const LATEST_MAX = 800;

export interface Digest {
  title: string;
  summary: string;
}

export interface DigestSource {
  first: string;
  latest: string[];
}

/**
 * Paliers de régénération : le tour 1 donne un titre tout de suite, puis on
 * rafraîchit assez rarement pour que le coût reste négligeable tout en suivant
 * la dérive d'une conversation longue.
 */
export function shouldRefreshDigest(turn: number, lastDigestTurn: number): boolean {
  if (turn <= 0) return false;
  if (lastDigestTurn === 0) return true;
  const step = turn < 12 ? 4 : 10;
  return turn - lastDigestTurn >= step;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function buildPrompt(source: DigestSource): string {
  const latest = source.latest.map((line) => clamp(line, LATEST_MAX)).join("\n\n");
  return [
    "Tu résumes une conversation entre un développeur et un agent de code.",
    "",
    "PREMIER MESSAGE (intention initiale) :",
    clamp(source.first, FIRST_MAX),
    "",
    "DERNIERS ÉCHANGES (où en est la conversation) :",
    latest,
    "",
    "Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :",
    '{"title": "...", "summary": "..."}',
    "",
    "- title : 45 caractères maximum, en français, sans ponctuation finale.",
    "  Décris le TRAVAIL réel, pas la formulation du premier message.",
    "  Exemples : « Rendu Mermaid dans le chat », « Fix des tableaux Markdown ».",
    "- summary : 2 phrases maximum, en français. Ce qui est demandé, où ça en est.",
  ].join("\n");
}

/** Extrait le premier objet JSON d'une sortie éventuellement bavarde. */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = process.env.PUPITRE_CLAUDE_BIN ?? "claude";
    const child = spawn(
      bin,
      ["-p", "--output-format", "json", "--model", DIGEST_MODEL, "--", prompt],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), DIGEST_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.slice(-500) || `exit ${code}`));
    });
  });
}

/**
 * Titre + résumé générés par un modèle bon marché. Renvoie null à la moindre
 * anomalie : l'appelant garde alors le digest précédent, jamais d'échec visible.
 */
export async function generateDigest(source: DigestSource, cwd: string): Promise<Digest | null> {
  if (!source.first.trim()) return null;
  let raw: string;
  try {
    raw = await runClaude(buildPrompt(source), cwd);
  } catch (error) {
    console.error("Digest de conversation impossible", error);
    return null;
  }
  // `--output-format json` enveloppe la réponse ; le texte utile est dans `result`.
  const envelope = extractJson(raw) as { result?: unknown } | null;
  const payload = typeof envelope?.result === "string"
    ? extractJson(envelope.result)
    : envelope;
  const digest = payload as { title?: unknown; summary?: unknown } | null;
  if (typeof digest?.title !== "string" || typeof digest.summary !== "string") return null;
  const title = digest.title.trim();
  const summary = digest.summary.trim();
  if (!title || !summary) return null;
  return { title, summary };
}
