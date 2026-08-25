import { expect, test } from "bun:test";
import { readClaudeUsage, refreshClaudeSession } from "../src/adapters/claude-usage";

test("renouvelle réellement le jeton OAuth Claude et le persiste", async () => {
  let credentials = {
    untouched: "kept",
    claudeAiOauth: {
      accessToken: "expired",
      refreshToken: "refresh-before",
      expiresAt: 1,
      scopes: ["user:inference", "user:profile"],
    },
  };
  let requestBody: Record<string, unknown> | null = null;

  const refreshed = await refreshClaudeSession({
    readCredentials: () => structuredClone(credentials),
    fetchToken: async (body) => {
      requestBody = body;
      return Response.json({
        access_token: "renewed",
        refresh_token: "refresh-after",
        expires_in: 3_600,
        refresh_token_expires_in: 86_400,
        scope: "user:inference user:profile",
      });
    },
    writeCredentials: (next) => {
      credentials = next as typeof credentials;
    },
    now: () => 10_000,
  });

  expect(refreshed).toBe(true);
  expect(requestBody).toMatchObject({
    grant_type: "refresh_token",
    refresh_token: "refresh-before",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scope: "user:inference user:profile",
  });
  expect(credentials).toEqual({
    untouched: "kept",
    claudeAiOauth: {
      accessToken: "renewed",
      refreshToken: "refresh-after",
      expiresAt: 3_610_000,
      refreshTokenExpiresAt: 86_410_000,
      scopes: ["user:inference", "user:profile"],
    },
  });
});

test("renouvelle la session Claude et retente après un access token expiré", async () => {
  let token = "expired";
  const requestedTokens: string[] = [];
  let refreshes = 0;

  const usage = await readClaudeUsage(undefined, {
    readAccessToken: () => token,
    fetchUsage: async (currentToken) => {
      requestedTokens.push(currentToken);
      return currentToken === "expired"
        ? new Response(null, { status: 401 })
        : Response.json({ five_hour: { utilization: 12 } });
    },
    refreshSession: async () => {
      refreshes += 1;
      token = "renewed";
      return true;
    },
  });

  expect(refreshes).toBe(1);
  expect(requestedTokens).toEqual(["expired", "renewed"]);
  expect(usage).toEqual({ five_hour: { utilization: 12 } });
});

test("ne lance pas le CLI quand le relevé Claude réussit", async () => {
  let refreshes = 0;
  const usage = await readClaudeUsage(undefined, {
    readAccessToken: () => "valid",
    fetchUsage: async () => Response.json({ ok: true }),
    refreshSession: async () => {
      refreshes += 1;
      return true;
    },
  });

  expect(refreshes).toBe(0);
  expect(usage).toEqual({ ok: true });
});

test("conserve l'ancien relevé si Claude ne peut pas renouveler sa session", async () => {
  let requests = 0;
  const usage = await readClaudeUsage(undefined, {
    readAccessToken: () => "expired",
    fetchUsage: async () => {
      requests += 1;
      return new Response(null, { status: 401 });
    },
    refreshSession: async () => false,
  });

  expect(requests).toBe(1);
  expect(usage).toBeNull();
});
