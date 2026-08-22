import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker } from "../src/quotas";
import { QuotaRefresher } from "../src/quota-refresh";

let quotas: QuotaTracker;
let claudeReads: number;
let codexReads: number;
let grokReads: number;

/**
 * Forme réelle de `GET /api/oauth/usage` (relevée le 2026-08-06), réduite aux
 * champs que Pupitre lit. `limits[]` est la source riche : elle porte les
 * pourcentages et la fenêtre hebdo scopée par modèle.
 */
function usagePayload() {
  return {
    five_hour: { utilization: 13.0, resets_at: "2026-08-06T03:20:00.302453+00:00" },
    seven_day: { utilization: 8.0, resets_at: "2026-08-12T12:00:00.302475+00:00" },
    limits: [
      {
        kind: "session",
        percent: 13,
        resets_at: "2026-08-06T03:20:00.302453+00:00",
        scope: null,
      },
      {
        kind: "weekly_all",
        percent: 8,
        resets_at: "2026-08-12T12:00:00.302475+00:00",
        scope: null,
      },
      {
        kind: "weekly_scoped",
        percent: 6,
        resets_at: "2026-08-12T12:00:00.302778+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  };
}

function grokCreditsPayload() {
  return {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-20T13:33:02.366Z",
        end: "2026-08-27T13:33:02.366Z",
      },
      creditUsagePercent: 25,
      billingPeriodEnd: "2026-08-27T13:33:02.366Z",
    },
  };
}

function refresher(claudeUsage: unknown = null, grokUsage: unknown = null): QuotaRefresher {
  return new QuotaRefresher(quotas, {
    readCodexRateLimits: async () => {
      codexReads += 1;
      return null;
    },
    readClaudeUsage: async () => {
      claudeReads += 1;
      return claudeUsage;
    },
    readGrokUsage: async () => {
      grokReads += 1;
      return grokUsage;
    },
  });
}

beforeEach(() => {
  quotas = new QuotaTracker(openDb(mkdtempSync(join(tmpdir(), "pupitre-quota-refresh-"))));
  claudeReads = 0;
  codexReads = 0;
  grokReads = 0;
});

test("le relevé OAuth donne les pourcentages claude, dont la fenêtre par modèle", async () => {
  await refresher(usagePayload()).refresh();
  expect(claudeReads).toBe(1);

  expect(quotas.get("claude")?.windows).toEqual([
    {
      label: "five_hour",
      usedPercent: 13,
      resetsAt: "2026-08-06T03:20:00.302Z",
      windowDurationMins: 300,
    },
    {
      label: "seven_day",
      usedPercent: 8,
      resetsAt: "2026-08-12T12:00:00.302Z",
      windowDurationMins: 10_080,
    },
    {
      label: "seven_day_fable",
      usedPercent: 6,
      resetsAt: "2026-08-12T12:00:00.302Z",
      windowDurationMins: 10_080,
    },
  ]);
});

test("la relève est gratuite : elle tourne à chaque appel, sans condition", async () => {
  const shared = refresher(usagePayload());
  await shared.refresh();
  await shared.refresh();
  expect(claudeReads).toBe(2);
  expect(codexReads).toBe(2);
  expect(grokReads).toBe(2);
});

test("deux relèves simultanées n'en font qu'une", async () => {
  const shared = refresher(usagePayload());
  await Promise.all([shared.refresh(), shared.refresh(), shared.refresh()]);
  expect(claudeReads).toBe(1);
});

test("une source indisponible laisse l'état précédent intact", async () => {
  await refresher(usagePayload()).refresh();
  const before = quotas.get("claude");

  const failing = new QuotaRefresher(quotas, {
    readCodexRateLimits: async () => {
      throw new Error("app-server absent");
    },
    readClaudeUsage: async () => {
      throw new Error("jeton expiré");
    },
    readGrokUsage: async () => {
      throw new Error("session grok expirée");
    },
  });
  await expect(failing.refresh()).resolves.toBeDefined();
  expect(quotas.get("claude")).toEqual(before);

  // Un endpoint qui répond « rien » (null) ne doit pas non plus tout effacer.
  await refresher(null).refresh();
  expect(quotas.get("claude")).toEqual(before);
});

test("le rate_limit_event du flux n'efface pas un pourcentage déjà relevé", async () => {
  await refresher(usagePayload()).refresh();

  // Fin d'un tour claude : l'event ne porte que la date de reset de la fenêtre
  // 5 h. Reçu tel quel, il repasserait usedPercent à null.
  quotas.ingest({
    type: "rate-limit",
    provider: "claude",
    payload: {
      status: "allowed",
      rateLimitType: "five_hour",
      resetsAt: Math.floor(Date.parse("2026-08-06T03:20:00.302Z") / 1000),
    },
  });

  const fiveHour = quotas.get("claude")?.windows.find((w) => w.label === "five_hour");
  expect(fiveHour?.usedPercent).toBe(13);
  // Les fenêtres hebdo, absentes de l'event, survivent au merge.
  expect(quotas.get("claude")?.windows).toHaveLength(3);
});

test("une nouvelle fenêtre (reset déplacé) remplace l'ancienne au lieu de la compléter", async () => {
  await refresher(usagePayload()).refresh();
  quotas.ingest({
    type: "rate-limit",
    provider: "claude",
    payload: {
      rateLimitType: "five_hour",
      resetsAt: Math.floor(Date.parse("2026-08-06T08:20:00.000Z") / 1000),
    },
  });

  const fiveHour = quotas.get("claude")?.windows.find((w) => w.label === "five_hour");
  expect(fiveHour?.resetsAt).toBe("2026-08-06T08:20:00.000Z");
  // Fenêtre suivante : l'usage de la précédente ne la décrit plus.
  expect(fiveHour?.usedPercent).toBeNull();
});

test("un relevé OAuth complet retire une fenêtre qui a disparu", async () => {
  await refresher(usagePayload()).refresh();
  expect(quotas.get("claude")?.windows).toHaveLength(3);

  await refresher({ limits: [usagePayload().limits[0]] }).refresh();
  expect(quotas.get("claude")?.windows.map((w) => w.label)).toEqual(["five_hour"]);
});

test("le relevé crédits Grok donne le pourcentage hebdo", async () => {
  await refresher(null, grokCreditsPayload()).refresh();
  expect(grokReads).toBe(1);
  expect(quotas.get("grok")?.windows).toEqual([
    {
      label: "weekly",
      usedPercent: 25,
      resetsAt: "2026-08-27T13:33:02.366Z",
      windowDurationMins: 10_080,
    },
  ]);
});
