// Teste la logique pure des signaux de quota du frontend (aucun DOM requis).
import { expect, test } from "bun:test";
import {
  DEFAULT_QUOTA_THRESHOLDS,
  formatCountdown,
  formatResetClock,
  quotaAlerts,
  quotaChipLabel,
  quotaFreshness,
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

test("la chip affiche le pourcentage et le reset, ou le seul reset connu", () => {
  const resetsAt = new Date(2026, 7, 3, 14, 30, 0).toISOString();
  const codex = state("codex", [window({ usedPercent: 10, resetsAt })]);
  const claude = state("claude", [
    window({ label: "five_hour", usedPercent: null, resetsAt }),
  ]);

  expect(quotaChipLabel(codex, NOW)).toBe("10% · reset lun. 14h30");
  expect(quotaChipLabel(claude, NOW)).toBe("reset lun. 14h30");
});

test("quota inconnu : pas de chip", () => {
  expect(quotaChipLabel(null, NOW)).toBeNull();
  expect(quotaChipLabel(state("codex", []), NOW)).toBeNull();
  expect(
    quotaChipLabel(
      state("codex", [window({ usedPercent: null, resetsAt: null })]),
      NOW,
    ),
  ).toBeNull();
});

test("la fraîcheur retient le relevé provider le plus récent", () => {
  const snapshot = {
    claude: { ...state("claude", []), updatedAt: new Date(NOW - 80 * MINUTE).toISOString() },
    codex: { ...state("codex", []), updatedAt: new Date(NOW - 3 * MINUTE).toISOString() },
  };

  expect(quotaFreshness(snapshot, NOW)).toBe("mis à jour il y a 3 min");
  expect(quotaFreshness({ claude: null, codex: null }, NOW)).toBeNull();
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
