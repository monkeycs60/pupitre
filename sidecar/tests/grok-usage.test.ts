import { expect, test } from "bun:test";
import { readGrokUsage, refreshGrokSession } from "../src/adapters/grok-usage";

test("renouvelle le jeton OIDC Grok expiré et le persiste", async () => {
  let auth = {
    "https://auth.x.ai::client": {
      key: "expired",
      refresh_token: "refresh-before",
      expires_at: "2026-08-25T03:00:00.000Z",
      oidc_client_id: "client",
      oidc_issuer: "https://auth.x.ai",
      untouched: "kept",
    },
  };
  let tokenRequest: { url: string; body: string } | null = null;

  const refreshed = await refreshGrokSession({
    readAuth: () => structuredClone(auth),
    discover: async () => Response.json({ token_endpoint: "https://auth.x.ai/oauth2/token" }),
    fetchToken: async (url, body) => {
      tokenRequest = { url, body: body.toString() };
      return Response.json({
        access_token: "renewed",
        refresh_token: "refresh-after",
        expires_in: 3_600,
      });
    },
    writeAuth: (next) => {
      auth = next as typeof auth;
    },
    now: () => Date.parse("2026-08-25T08:00:00.000Z"),
  });

  expect(refreshed).toBe(true);
  expect(tokenRequest as { url: string; body: string } | null).toEqual({
    url: "https://auth.x.ai/oauth2/token",
    body: "grant_type=refresh_token&refresh_token=refresh-before&client_id=client",
  });
  expect(auth["https://auth.x.ai::client"]).toEqual({
    key: "renewed",
    refresh_token: "refresh-after",
    expires_at: "2026-08-25T09:00:00.000Z",
    oidc_client_id: "client",
    oidc_issuer: "https://auth.x.ai",
    untouched: "kept",
  });
});

test("relève Grok après avoir renouvelé un jeton déjà expiré", async () => {
  let token = "expired";
  const requestedTokens: string[] = [];

  const usage = await readGrokUsage(undefined, {
    readAccessToken: () => token,
    tokenExpired: () => token === "expired",
    refreshSession: async () => {
      token = "renewed";
      return true;
    },
    fetchUsage: async (currentToken) => {
      requestedTokens.push(currentToken);
      return Response.json({ config: { creditUsagePercent: 42 } });
    },
  });

  expect(requestedTokens).toEqual(["renewed"]);
  expect(usage).toEqual({ config: { creditUsagePercent: 42 } });
});
