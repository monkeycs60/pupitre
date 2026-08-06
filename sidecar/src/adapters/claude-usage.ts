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

/** Payload d'usage brut, laissé au QuotaTracker qui sait le normaliser. */
export async function readClaudeUsage(signal?: AbortSignal): Promise<unknown | null> {
  const token = accessToken();
  if (token === null) return null;

  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        // Les mêmes en-têtes que Claude Code : l'endpoint les exige.
        "user-agent": "claude-code/2.0.31",
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Réseau coupé, jeton expiré, endpoint modifié : on garde l'état précédent.
    return null;
  }
}
