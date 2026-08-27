import { killGroup, spawnGroup } from "./process-group";
import {
  isDomainKind,
  normalizeDomainName,
  type DigestDomainSuggestion,
  type Domain,
} from "./stores/domains";

/** Modèle volontairement bon marché : le digest tourne à chaque palier de tours. */
const DIGEST_MODEL = process.env.PUPITRE_DIGEST_MODEL ?? "claude-haiku-4-5-20251001";
const DIGEST_TIMEOUT_MS = 45_000;
/** Bornes des textes envoyés : un digest ne doit jamais coûter un vrai tour. */
const FIRST_MAX = 1_200;
const LATEST_MAX = 800;
const DIGEST_DOMAIN_MAX = 2;

export interface Digest {
  title: string;
  summary: string;
  domains: DigestDomainSuggestion[];
}

export interface DigestSource {
  first: string;
  latest: string[];
  domainCatalog?: Array<Pick<Domain, "name" | "kind" | "status">>;
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

export function parseDomainSuggestions(raw: unknown): DigestDomainSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const suggestions: DigestDomainSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = normalizeDomainName(typeof (item as { name?: unknown }).name === "string"
      ? (item as { name: string }).name
      : "");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = (item as { kind?: unknown }).kind;
    suggestions.push({ name, kind: isDomainKind(kind) ? kind : "technique" });
    if (suggestions.length >= DIGEST_DOMAIN_MAX) break;
  }
  return suggestions;
}

export function parseDigestPayload(payload: unknown): Digest | null {
  if (!payload || typeof payload !== "object") return null;
  const digest = payload as { title?: unknown; summary?: unknown; domains?: unknown };
  if (typeof digest.title !== "string" || typeof digest.summary !== "string") return null;
  const title = digest.title.trim();
  const summary = digest.summary.trim();
  if (!title || !summary) return null;
  return { title, summary, domains: parseDomainSuggestions(digest.domains) };
}

export function buildDigestPrompt(source: DigestSource): string {
  const latest = source.latest.map((line) => clamp(line, LATEST_MAX)).join("\n\n");
  const catalog = (source.domainCatalog ?? [])
    .map((domain) => `${domain.name} (${domain.kind}, ${domain.status})`)
    .join(", ");
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
    '{"title": "...", "summary": "...", "domains": [{"name": "...", "kind": "métier"}]}',
    "",
    "- title : 45 caractères maximum, en français, sans ponctuation finale.",
    "  Décris le TRAVAIL réel, pas la formulation du premier message.",
    "  Exemples : « Rendu Mermaid dans le chat », « Fix des tableaux Markdown ».",
    "- summary : 2 phrases maximum, en français. Ce qui est demandé, où ça en est.",
    "- domains : 0, 1 ou 2 domaines touchés par cette conversation.",
    "  kind vaut « métier » ou « technique ». Préfère un nom du catalogue s'il convient ;",
    "  sinon propose un nom court nouveau. N'invente pas plus de deux domaines.",
    catalog ? `- Catalogue existant : ${catalog}.` : "- Aucun domaine n'existe encore pour ce projet.",
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
    const child = spawnGroup(
      bin,
      ["-p", "--output-format", "json", "--model", DIGEST_MODEL, "--", prompt],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), DIGEST_TIMEOUT_MS);
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
    raw = await runClaude(buildDigestPrompt(source), cwd);
  } catch (error) {
    console.error("Digest de conversation impossible", error);
    return null;
  }
  // `--output-format json` enveloppe la réponse ; le texte utile est dans `result`.
  const envelope = extractJson(raw) as { result?: unknown } | null;
  const payload = typeof envelope?.result === "string"
    ? extractJson(envelope.result)
    : envelope;
  return parseDigestPayload(payload);
}
