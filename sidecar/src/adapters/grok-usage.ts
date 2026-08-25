import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
  refresh_token?: unknown;
  oidc_client_id?: unknown;
  oidc_issuer?: unknown;
  [key: string]: unknown;
}

type GrokAuthFile = Record<string, GrokAuthEntry>;

interface GrokRefreshDeps {
  readAuth?: () => GrokAuthFile | null;
  discover?: (url: string, signal: AbortSignal) => Promise<Response>;
  fetchToken?: (url: string, body: URLSearchParams, signal: AbortSignal) => Promise<Response>;
  writeAuth?: (auth: GrokAuthFile) => void;
  now?: () => number;
}

interface GrokUsageDeps {
  readAccessToken?: () => string | null;
  tokenExpired?: () => boolean;
  refreshSession?: () => Promise<boolean>;
  fetchUsage?: (token: string, signal: AbortSignal) => Promise<Response>;
}

function authPath(): string {
  return join(grokHome(), "auth.json");
}

function authFile(): GrokAuthFile | null {
  try {
    const parsed = JSON.parse(readFileSync(authPath(), "utf8")) as GrokAuthFile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function activeEntry(auth: GrokAuthFile | null = authFile()): GrokAuthEntry | null {
  if (auth === null) return null;
  return Object.values(auth).find((entry) => typeof entry.key === "string" && entry.key !== "") ?? null;
}

function accessToken(): string | null {
  const token = activeEntry()?.key;
  return typeof token === "string" ? token : null;
}

function tokenExpired(): boolean {
  const expiresAt = activeEntry()?.expires_at;
  if (typeof expiresAt !== "string") return false;
  const expires = Date.parse(expiresAt);
  return Number.isNaN(expires) || expires <= Date.now();
}

async function discover(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, { headers: { accept: "application/json" }, signal });
}

async function fetchToken(
  url: string,
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal,
  });
}

function writeAuth(auth: GrokAuthFile): void {
  const path = authPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(auth, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export async function refreshGrokSession(deps: GrokRefreshDeps = {}): Promise<boolean> {
  try {
    const read = deps.readAuth ?? authFile;
    const requestDiscovery = deps.discover ?? discover;
    const requestToken = deps.fetchToken ?? fetchToken;
    const persist = deps.writeAuth ?? writeAuth;
    const now = deps.now ?? Date.now;
    const before = read();
    const entry = activeEntry(before);
    if (entry === null) return false;
    const refreshToken = entry.refresh_token;
    const clientId = entry.oidc_client_id;
    const issuer = entry.oidc_issuer;
    if (
      typeof refreshToken !== "string" || refreshToken === ""
      || typeof clientId !== "string" || clientId === ""
      || typeof issuer !== "string" || issuer === ""
    ) return false;

    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== "https:") return false;
    const discovery = await requestDiscovery(
      new URL("/.well-known/openid-configuration", issuerUrl).toString(),
      AbortSignal.timeout(TIMEOUT_MS),
    );
    if (!discovery.ok) return false;
    const metadata = await discovery.json() as Record<string, unknown>;
    if (typeof metadata.token_endpoint !== "string") return false;
    const tokenEndpoint = new URL(metadata.token_endpoint);
    if (tokenEndpoint.protocol !== "https:" || tokenEndpoint.origin !== issuerUrl.origin) return false;

    const response = await requestToken(
      tokenEndpoint.toString(),
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
      AbortSignal.timeout(TIMEOUT_MS),
    );
    if (!response.ok) return false;
    const renewed = await response.json() as Record<string, unknown>;
    if (
      typeof renewed.access_token !== "string" || renewed.access_token === ""
      || typeof renewed.expires_in !== "number"
    ) return false;

    const current = read();
    if (current === null) return false;
    const currentKey = Object.keys(current).find((key) => current[key]?.refresh_token === refreshToken);
    if (currentKey === undefined) return true;
    current[currentKey] = {
      ...current[currentKey],
      key: renewed.access_token,
      refresh_token: typeof renewed.refresh_token === "string"
        ? renewed.refresh_token
        : refreshToken,
      expires_at: new Date(now() + renewed.expires_in * 1_000).toISOString(),
    };
    persist(current);
    return true;
  } catch {
    return false;
  }
}

async function fetchUsage(token: string, signal: AbortSignal): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-xai-token-auth": "xai-grok-cli",
      accept: "application/json",
    },
    signal,
  });
}

export async function readGrokUsage(
  signal?: AbortSignal,
  deps: GrokUsageDeps = {},
): Promise<unknown | null> {
  const readToken = deps.readAccessToken ?? accessToken;
  const isExpired = deps.tokenExpired ?? tokenExpired;
  const renew = deps.refreshSession ?? refreshGrokSession;
  const request = deps.fetchUsage ?? fetchUsage;
  const requestSignal = () => signal ?? AbortSignal.timeout(TIMEOUT_MS);
  let token = readToken();
  if (token === null) return null;

  try {
    if (isExpired() && await renew()) {
      token = readToken();
      if (token === null) return null;
    }
    let response = await request(token, requestSignal());
    if (response.status === 401 && await renew()) {
      token = readToken();
      if (token === null) return null;
      response = await request(token, requestSignal());
    }
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
