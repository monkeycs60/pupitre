import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code lit lui-même son usage sur cet endpoint OAuth — c'est la source
// de la ligne « session / weekly » des status bars. Contrairement au
// `rate_limit_event` du flux d'un tour, il rend de VRAIS pourcentages, il est
// gratuit et il ne consomme aucun quota : c'est donc la source à préférer.
//
// Réponse observée (2026-08-06) :
//   { five_hour: {utilization, resets_at}, seven_day: {…},
//     limits: [ {kind:"session"|"weekly_all"|"weekly_scoped", percent,
//                resets_at, scope:{model:{display_name}}|null }, … ], … }
//
// L'endpoint n'est pas documenté publiquement : il peut changer sans préavis.
// Tout échec est donc silencieux et le QuotaTracker retombe sur le
// `rate_limit_event` du flux, qui reste la source stable (sans pourcentage).

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 8_000;

interface ClaudeUsageDeps {
  readAccessToken?: () => string | null;
  fetchUsage?: (token: string, signal: AbortSignal) => Promise<Response>;
  refreshSession?: () => Promise<boolean>;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Jeton OAuth de Claude Code, rafraîchi par le CLI lui-même : jamais mis en cache ici. */
function accessToken(): string | null {
  try {
    const raw = readFileSync(join(configDir(), ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    // Pas de session Claude Code sur cette machine : rien à lire.
    return null;
  }
}

async function fetchUsage(token: string, signal: AbortSignal): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "claude-code/2.0.31",
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
    },
    signal,
  });
}

async function refreshSession(): Promise<boolean> {
  const claude = process.env.PUPITRE_CLAUDE_BIN ?? Bun.which("claude");
  if (!claude) return false;
  const child = Bun.spawn([claude, "auth", "status"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const timeout = setTimeout(() => child.kill(), TIMEOUT_MS);
  try {
    return await child.exited === 0;
  } finally {
    clearTimeout(timeout);
  }
}

/** Payload d'usage brut, laissé au QuotaTracker qui sait le normaliser. */
export async function readClaudeUsage(
  signal?: AbortSignal,
  deps: ClaudeUsageDeps = {},
): Promise<unknown | null> {
  const readToken = deps.readAccessToken ?? accessToken;
  const request = deps.fetchUsage ?? fetchUsage;
  const renew = deps.refreshSession ?? refreshSession;
  const requestSignal = () => signal ?? AbortSignal.timeout(TIMEOUT_MS);
  let token = readToken();
  if (token === null) return null;

  try {
    let response = await request(token, requestSignal());
    if (response.status === 401 && await renew()) {
      token = readToken();
      if (token === null) return null;
      response = await request(token, requestSignal());
    }
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Réseau coupé, jeton expiré, endpoint modifié : on garde l'état précédent.
    return null;
  }
}
