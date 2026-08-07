import { expect, test } from "bun:test";
import {
  PERSISTENT_ALERT_RATIO,
  contextParts,
  persistentRatio,
} from "../../ui/src/contextEstimate";
import { formatCompact } from "../../ui/src/formatCompact";

const events = [
  { type: "user-message" as const, text: "a".repeat(400), images: [] },
  { type: "text-final" as const, text: "b".repeat(800) },
  { type: "tool-end" as const, toolId: "t1", output: "c".repeat(1_200), images: [] },
];

test("décompose le contexte par origine, du plus lourd au plus léger", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.map((part) => part.label)).toEqual([
    "Système, MCP tiers, mémoire",
    "Appels et sorties d’outils",
    "Réponses de l’agent",
    "Vos messages",
    "Consigne de format Pupitre",
  ]);
});

test("le reliquat comble l'écart avec le total du provider", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(10_000);
  expect(parts.find((part) => part.inferred)?.tokens).toBe(10_000 - (100 + 200 + 300 + 95));
});

test("sans total provider crédible, aucune ligne déduite n'est inventée", () => {
  expect(contextParts(events, 0).some((part) => part.inferred)).toBe(false);
});

test("une conversation vide ne produit aucune ligne", () => {
  expect(contextParts([], 0)).toEqual([]);
});

test("la place libre ferme l'anneau sur la fenêtre entière", () => {
  const parts = contextParts(events, 10_000, 1_000_000);
  const free = parts.at(-1);
  expect(free).toMatchObject({ label: "Disponible", free: true, tokens: 990_000 });
  expect(parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(1_000_000);
});

test("une fenêtre déjà pleine n'ajoute pas de part disponible", () => {
  expect(contextParts(events, 10_000, 10_000).some((part) => part.free)).toBe(false);
});

test("les parts rechargées à chaque session sont marquées incompressibles", () => {
  const persistent = contextParts(events, 10_000, 1_000_000)
    .filter((part) => part.persistent)
    .map((part) => part.label);
  expect(persistent).toEqual(["Système, MCP tiers, mémoire", "Consigne de format Pupitre"]);
});

test("les grands nombres s'abrègent en millions", () => {
  expect(formatCompact(1_000_000)).toBe("1 M");
  expect(formatCompact(1_234_567)).toBe("1,23 M");
  expect(formatCompact(12_340)).toBe("12,3 k");
  expect(formatCompact(842)).toBe("842");
});

test("le bridge conductor sort de l'agrégat déduit quand il est mesuré", () => {
  const parts = contextParts(events, 10_000, 1_000_000, 1_200);
  const bridge = parts.find((part) => part.label === "Bridge conductor (Pupitre)");
  expect(bridge).toMatchObject({ tokens: 1_200, persistent: true });
  expect(bridge?.inferred).toBeUndefined();
  // Le déduit se réduit d'autant : le total reste celui du provider.
  expect(parts.find((part) => part.inferred)?.tokens)
    .toBe(10_000 - (100 + 200 + 300 + 95 + 1_200));
});

test("le ratio incompressible se rapporte à la fenêtre entière", () => {
  const parts = contextParts(events, 10_000, 20_000);
  // Déduit (9 305) + consigne Pupitre (95) = 9 400 sur 20 000.
  expect(persistentRatio(parts, 20_000)).toBeCloseTo(0.47, 2);
  expect(persistentRatio(parts, 0)).toBe(0);
});

test("le seuil d'alerte reste sous la moitié de la fenêtre", () => {
  expect(PERSISTENT_ALERT_RATIO).toBeGreaterThan(0);
  expect(PERSISTENT_ALERT_RATIO).toBeLessThan(0.5);
});
