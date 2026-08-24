// Teste la logique pure des signaux de quota du frontend (aucun DOM requis).
import { expect, test } from "bun:test";
import {
  DEFAULT_QUOTA_THRESHOLDS,
  formatCountdown,
  formatResetClock,
  quotaAlerts,
  quotaStateSignals,
  quotaSummary,
  quotaWindowSignals,
  quotaFreshness,
  quotaStateFreshness,
  nextQuotaReevaluationDelay,
  shouldPulse,
  tightestWindow,
  windowTitle,
} from "../../ui/src/quotaSignals";
import type { QuotaState, QuotaWindow } from "../../ui/src/types";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const MINUTE = 60_000;

function isoIn(minutes: number): string {
  return new Date(NOW + minutes * MINUTE).toISOString();
}

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    label: "primary",
    usedPercent: 20,
    resetsAt: isoIn(30),
    windowDurationMins: 300,
    ...overrides,
  };
}

function state(provider: QuotaState["provider"], windows: QuotaWindow[]): QuotaState {
  return { provider, windows, updatedAt: new Date(NOW).toISOString() };
}

test("les compte à rebours se formatent en minutes, heures puis jours", () => {
  expect(formatCountdown(-1)).toBe("imminent");
  expect(formatCountdown(30_000)).toBe("moins d’une minute");
  expect(formatCountdown(47 * MINUTE)).toBe("47 min");
  expect(formatCountdown(120 * MINUTE)).toBe("2 h");
  expect(formatCountdown(134 * MINUTE)).toBe("2 h 14");
  expect(formatCountdown(3 * 24 * 60 * MINUTE)).toBe("3 j");
});

test("l'heure de reset est rendue en local, sans minutes à l'heure pile", () => {
  const onTheHour = new Date(2026, 7, 3, 14, 0, 0);
  const withMinutes = new Date(2026, 7, 3, 14, 30, 0);

  expect(formatResetClock(onTheHour.toISOString())).toBe("lun. 14h");
  expect(formatResetClock(withMinutes.toISOString())).toBe("lun. 14h30");
  expect(formatResetClock(null)).toBeNull();
  expect(formatResetClock("pas une date")).toBeNull();
});

test("les libellés de fenêtre sont normalisés entre providers", () => {
  expect(windowTitle(window({ label: "five_hour" }))).toBe("5 h");
  expect(windowTitle(window({ label: "seven_day" }))).toBe("hebdo");
  expect(windowTitle(window({ label: "primary" }))).toBe("5 h");
  expect(windowTitle(window({ label: "secondary", windowDurationMins: 10_080 })))
    .toBe("hebdo");
  expect(windowTitle(window({ label: "primary", windowDurationMins: 10_080 })))
    .toBe("hebdo");
  // Label inconnu : on retombe sur la durée publiée.
  expect(windowTitle(window({ label: "bizarre", windowDurationMins: 10_080 })))
    .toBe("7 j");
  expect(windowTitle(window({ label: "bizarre", windowDurationMins: null })))
    .toBe("bizarre");
});

test("la fenêtre la plus contraignante est la plus consommée", () => {
  const codex = state("codex", [
    window({ label: "primary", usedPercent: 12 }),
    window({ label: "secondary", usedPercent: 71, resetsAt: isoIn(4000) }),
  ]);

  expect(tightestWindow(codex, NOW)?.label).toBe("secondary");
});

test("sans pourcentage publié, la fenêtre retenue est celle qui reset le plus tôt", () => {
  const claude = state("claude", [
    window({ label: "seven_day", usedPercent: null, resetsAt: isoIn(4000) }),
    window({ label: "five_hour", usedPercent: null, resetsAt: isoIn(90) }),
  ]);

  expect(tightestWindow(claude, NOW)?.label).toBe("five_hour");
});

test("résumé codex : pourcentage utilisé et fenêtre de reset, sans réserve", () => {
  const summary = quotaSummary(
    "codex",
    state("codex", [window({ usedPercent: 62, resetsAt: isoIn(150) })]),
    NOW,
  );
  expect(summary).toEqual({
    usedPercent: 62,
    headline: "62 % utilisé",
    note: "5 h · reset dans 2 h 30",
  });
});

test("résumé claude : le reset seul, et la raison de l'absence de pourcentage", () => {
  const summary = quotaSummary(
    "claude",
    state("claude", [
      window({ label: "five_hour", usedPercent: null, resetsAt: isoIn(75) }),
    ]),
    NOW,
  );
  expect(summary.usedPercent).toBeNull();
  expect(summary.headline).toBe("reset dans 1 h 15");
  // La donnée manquante est nommée : sans ça, l'UI se lit comme une panne.
  expect(summary.note).toContain("Relevé partiel");
});

test("résumé sans relevé : la cause dépend du provider", () => {
  expect(quotaSummary("claude", null, NOW)).toEqual({
    usedPercent: null,
    headline: "jamais relevé",
    note: expect.stringContaining("session Claude Code absente"),
  });
  expect(quotaSummary("codex", state("codex", []), NOW).note)
    .toContain("app-server codex");
  expect(quotaSummary("grok", null, NOW).note)
    .toContain("session Grok absente");
});

test("la fraîcheur retient le relevé provider le plus récent", () => {
  const snapshot = {
    claude: { ...state("claude", []), updatedAt: new Date(NOW - 80 * MINUTE).toISOString() },
    codex: { ...state("codex", []), updatedAt: new Date(NOW - 3 * MINUTE).toISOString() },
    grok: null,
  };

  expect(quotaFreshness(snapshot, NOW)).toBe("mis à jour il y a 3 min");
  expect(quotaFreshness({ claude: null, codex: null, grok: null }, NOW)).toBeNull();
});

test("la fraîcheur d'un provider distingue un relevé actuel d'un relevé périmé", () => {
  const current = { ...state("claude", []), updatedAt: new Date(NOW - 9 * MINUTE).toISOString() };
  const stale = { ...state("claude", []), updatedAt: new Date(NOW - 11 * MINUTE).toISOString() };

  expect(quotaStateFreshness(current, NOW)).toEqual({ stale: false, label: "il y a 9 min" });
  expect(quotaStateFreshness(stale, NOW)).toEqual({ stale: true, label: "il y a 11 min" });
  expect(quotaStateFreshness({ ...current, updatedAt: new Date(NOW - 10 * MINUTE).toISOString() }, NOW).stale)
    .toBe(true);
  expect(quotaStateFreshness(null, NOW)).toEqual({ stale: true, label: "jamais relevé" });
});

test("pulse : quota peu entamé et reset dans moins d'une heure, modèles chers", () => {
  const codex = state("codex", [window({ usedPercent: 20, resetsAt: isoIn(30) })]);

  expect(shouldPulse(codex, "gpt-5.6-sol", NOW)).toBe(true);
  expect(shouldPulse(codex, "gpt-5.6-luna", NOW)).toBe(false);
});

test("pulse : pas de pulse si le quota est déjà bien consommé ou le reset lointain", () => {
  const consumed = state("codex", [window({ usedPercent: 62, resetsAt: isoIn(30) })]);
  const far = state("codex", [window({ usedPercent: 20, resetsAt: isoIn(180) })]);
  const passed = state("codex", [window({ usedPercent: 20, resetsAt: isoIn(-5) })]);

  expect(shouldPulse(consumed, "gpt-5.6-sol", NOW)).toBe(false);
  expect(shouldPulse(far, "gpt-5.6-sol", NOW)).toBe(false);
  expect(shouldPulse(passed, "gpt-5.6-sol", NOW)).toBe(false);
});

test("pulse : sans pourcentage publié (claude), on ne devine pas le quota restant", () => {
  const claude = state("claude", [
    window({ label: "five_hour", usedPercent: null, resetsAt: isoIn(30) }),
  ]);

  expect(shouldPulse(claude, "opus", NOW)).toBe(false);
  expect(shouldPulse(null, "opus", NOW)).toBe(false);
});

test("pulse : une fenêtre parmi plusieurs suffit", () => {
  const codex = state("codex", [
    window({ label: "secondary", usedPercent: 90, resetsAt: isoIn(5000) }),
    window({ label: "primary", usedPercent: 5, resetsAt: isoIn(20) }),
  ]);

  expect(shouldPulse(codex, "gpt-5.6-sol", NOW)).toBe(true);
});

test("alerte dernière heure : déclenchée dans l'heure, pas avant, pas après le reset", () => {
  const inside = state("claude", [
    window({ label: "five_hour", usedPercent: null, resetsAt: isoIn(45) }),
  ]);
  const outside = state("claude", [
    window({ label: "five_hour", usedPercent: null, resetsAt: isoIn(75) }),
  ]);
  const past = state("claude", [
    window({ label: "five_hour", usedPercent: null, resetsAt: isoIn(-1) }),
  ]);

  const alerts = quotaAlerts(inside, DEFAULT_QUOTA_THRESHOLDS, NOW);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.key).toBe(`claude:five_hour:${isoIn(45)}:last-hour`);
  expect(alerts[0]?.body).toBe("Reset dans 45 min.");

  expect(quotaAlerts(outside, DEFAULT_QUOTA_THRESHOLDS, NOW)).toEqual([]);
  expect(quotaAlerts(past, DEFAULT_QUOTA_THRESHOLDS, NOW)).toEqual([]);
});

test("programme une réévaluation à l'entrée dans la dernière heure", () => {
  const snapshot = {
    claude: state("claude", [window({ resetsAt: isoIn(75) })]),
    codex: state("codex", [window({ resetsAt: isoIn(180) })]),
  };

  expect(nextQuotaReevaluationDelay(snapshot, DEFAULT_QUOTA_THRESHOLDS, NOW))
    .toBe(15 * MINUTE);
  expect(nextQuotaReevaluationDelay(snapshot, { lastHour: false, usedPercent: 80 }, NOW))
    .toBeNull();
});

test("alerte de seuil d'usage : au-delà du seuil seulement", () => {
  const below = state("codex", [window({ usedPercent: 79, resetsAt: isoIn(5000) })]);
  const above = state("codex", [window({ usedPercent: 81, resetsAt: isoIn(5000) })]);

  expect(quotaAlerts(below, DEFAULT_QUOTA_THRESHOLDS, NOW)).toEqual([]);
  const alerts = quotaAlerts(above, DEFAULT_QUOTA_THRESHOLDS, NOW);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.key).toBe(`codex:primary:${isoIn(5000)}:used-80`);
  expect(alerts[0]?.title).toBe("Quota 81% — codex · 5 h");
});

test("les deux seuils peuvent se déclencher sur la même fenêtre", () => {
  const both = state("codex", [window({ usedPercent: 95, resetsAt: isoIn(20) })]);

  expect(quotaAlerts(both, DEFAULT_QUOTA_THRESHOLDS, NOW).map((a) => a.key)).toEqual([
    `codex:primary:${isoIn(20)}:last-hour`,
    `codex:primary:${isoIn(20)}:used-80`,
  ]);
});

test("signaux visuels : seule la fenêtre Claude de 5 h pulse dans sa dernière heure", () => {
  const claudeFiveHour = window({ label: "five_hour", resetsAt: isoIn(45) });
  const codexFiveHour = window({ label: "primary", resetsAt: isoIn(45) });

  expect(quotaWindowSignals("claude", claudeFiveHour, NOW)).toEqual({
    lastHour: true,
    weeklyEnding: false,
  });
  expect(quotaWindowSignals("codex", codexFiveHour, NOW).lastHour).toBe(false);
  expect(quotaWindowSignals("claude", window({ resetsAt: isoIn(75) }), NOW).lastHour)
    .toBe(false);
});

test("signaux visuels : les fenêtres hebdo Claude, Fable et Codex changent à J-2", () => {
  const inThirtySixHours = isoIn(36 * 60);
  const weeklyWindows = [
    ["claude", window({ label: "seven_day", windowDurationMins: 10_080, resetsAt: inThirtySixHours })],
    ["claude", window({ label: "seven_day_fable", windowDurationMins: 10_080, resetsAt: inThirtySixHours })],
    ["codex", window({ label: "primary", windowDurationMins: 10_080, resetsAt: inThirtySixHours })],
  ] as const;

  for (const [provider, quotaWindow] of weeklyWindows) {
    expect(quotaWindowSignals(provider, quotaWindow, NOW).weeklyEnding).toBe(true);
  }
  expect(quotaWindowSignals("codex", window({
    label: "weekly",
    windowDurationMins: 10_080,
    resetsAt: isoIn(49 * 60),
  }), NOW).weeklyEnding).toBe(false);
});

test("signaux visuels : dernière heure et fin hebdo Claude se cumulent", () => {
  const claude = state("claude", [
    window({ label: "five_hour", resetsAt: isoIn(30) }),
    window({ label: "seven_day", windowDurationMins: 10_080, resetsAt: isoIn(24 * 60) }),
    window({ label: "seven_day_fable", windowDurationMins: 10_080, resetsAt: isoIn(30 * 60) }),
  ]);

  expect(quotaStateSignals("claude", claude, NOW)).toEqual({
    lastHour: true,
    weeklyEnding: true,
  });
});

test("la clé d'alerte change de fenêtre en fenêtre : une nouvelle fenêtre re-notifie", () => {
  const first = state("codex", [window({ usedPercent: 90, resetsAt: isoIn(20) })]);
  const next = state("codex", [window({ usedPercent: 90, resetsAt: isoIn(320) })]);

  const firstKeys = quotaAlerts(first, DEFAULT_QUOTA_THRESHOLDS, NOW).map((a) => a.key);
  const nextKeys = quotaAlerts(next, DEFAULT_QUOTA_THRESHOLDS, NOW).map((a) => a.key);

  expect(firstKeys).not.toEqual(nextKeys);
});

test("seuils désactivés : aucune alerte", () => {
  const hot = state("codex", [window({ usedPercent: 99, resetsAt: isoIn(10) })]);

  expect(quotaAlerts(hot, { lastHour: false, usedPercent: null }, NOW)).toEqual([]);
  expect(quotaAlerts(null, DEFAULT_QUOTA_THRESHOLDS, NOW)).toEqual([]);
});
