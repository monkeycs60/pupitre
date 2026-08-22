import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Relève gratuite du pool d'usage Grok (abonnement grok.com / SuperGrok).
 * Même jeton que `grok login`, lu dans `~/.grok/auth.json`.
 *
 * Endpoint observé (2026-08-22) :
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   { config: { creditUsagePercent, currentPeriod: { type, start, end }, … } }
 *
 * Un jeton expiré ou une session absente rend null : le QuotaTracker garde
 * l'état précédent, comme pour Claude.
 */

const USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const TIMEOUT_MS = 8_000;

function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), ".grok");
}

interface GrokAuthEntry {
  key?: unknown;
  expires_at?: unknown;
}

function accessToken(): string | null {
  try {
    const raw = readFileSync(join(grokHome(), "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, GrokAuthEntry>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    for (const entry of Object.values(parsed)) {
      const token = entry?.key;
      if (typeof token !== "string" || token === "") continue;
      if (typeof entry.expires_at === "string") {
        const expires = Date.parse(entry.expires_at);
        if (Number.isNaN(expires) || expires <= Date.now()) continue;
      }
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

export async function readGrokUsage(signal?: AbortSignal): Promise<unknown | null> {
  const token = accessToken();
  if (token === null) return null;

  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-xai-token-auth": "xai-grok-cli",
        accept: "application/json",
      },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
