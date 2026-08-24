import { expect, test } from "bun:test";
import { readClaudeUsage } from "../src/adapters/claude-usage";

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
