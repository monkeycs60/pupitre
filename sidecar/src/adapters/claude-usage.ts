import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TIMEOUT_MS = 8_000;

interface ClaudeOAuthCredentials {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  refreshTokenExpiresAt?: unknown;
  scopes?: unknown;
  [key: string]: unknown;
}

interface CredentialsFile {
  claudeAiOauth?: ClaudeOAuthCredentials;
  [key: string]: unknown;
}

interface ClaudeSessionRefreshDeps {
  readCredentials?: () => CredentialsFile | null;
  fetchToken?: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;
  writeCredentials?: (credentials: CredentialsFile) => void;
  now?: () => number;
}

interface ClaudeUsageDeps {
  readAccessToken?: () => string | null;
  fetchUsage?: (token: string, signal: AbortSignal) => Promise<Response>;
  refreshSession?: () => Promise<boolean>;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function credentialsPath(): string {
  return join(configDir(), ".credentials.json");
}

function credentialsFile(): CredentialsFile | null {
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf8")) as CredentialsFile;
  } catch {
    return null;
  }
}

/** Jeton OAuth partagé avec Claude Code : jamais mis en cache ici. */
function accessToken(): string | null {
  const token = credentialsFile()?.claudeAiOauth?.accessToken;
  return typeof token === "string" && token !== "" ? token : null;
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

async function fetchToken(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function writeCredentials(credentials: CredentialsFile): void {
  const path = credentialsPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(credentials), { mode: 0o600 });
  renameSync(temporary, path);
}

export async function refreshClaudeSession(
  deps: ClaudeSessionRefreshDeps = {},
): Promise<boolean> {
  try {
    const read = deps.readCredentials ?? credentialsFile;
    const request = deps.fetchToken ?? fetchToken;
    const persist = deps.writeCredentials ?? writeCredentials;
    const now = deps.now ?? Date.now;
    const before = read();
    const oauth = before?.claudeAiOauth;
    const refreshToken = oauth?.refreshToken;
    if (typeof refreshToken !== "string" || refreshToken === "") return false;
    const scopes = Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const response = await request(
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CODE_CLIENT_ID,
        ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
      },
      AbortSignal.timeout(TIMEOUT_MS),
    );
    if (!response.ok) return false;
    const renewed = await response.json() as Record<string, unknown>;
    if (
      typeof renewed.access_token !== "string"
      || renewed.access_token === ""
      || typeof renewed.expires_in !== "number"
    ) return false;

    const current = read();
    if (!current?.claudeAiOauth) return false;
    if (current.claudeAiOauth.refreshToken !== refreshToken) return true;
    const refreshedAt = now();
    current.claudeAiOauth = {
      ...current.claudeAiOauth,
      accessToken: renewed.access_token,
      refreshToken: typeof renewed.refresh_token === "string"
        ? renewed.refresh_token
        : refreshToken,
      expiresAt: refreshedAt + renewed.expires_in * 1_000,
      ...(typeof renewed.refresh_token_expires_in === "number"
        ? { refreshTokenExpiresAt: refreshedAt + renewed.refresh_token_expires_in * 1_000 }
        : {}),
      ...(typeof renewed.scope === "string"
        ? { scopes: renewed.scope.split(" ").filter(Boolean) }
        : {}),
    };
    persist(current);
    return true;
  } catch {
    return false;
  }
}

async function refreshSession(): Promise<boolean> {
  return refreshClaudeSession();
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
