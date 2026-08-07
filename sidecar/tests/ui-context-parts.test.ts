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

test("regroupe le contexte en charge fixe, conversation et outils", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.map((part) => [part.label, part.group])).toEqual([
    ["Charge fixe", "fixe"],
    ["Vos messages", "conversation"],
    ["Réponses de l’agent", "conversation"],
    ["Fichiers lus et commandes", "outils"],
  ]);
});

test("la charge fixe absorbe le reliquat du total provider", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(10_000);
  // Consigne Pupitre (95) + tout ce que le CLI ne publie pas.
  expect(parts[0]).toMatchObject({ label: "Charge fixe", tokens: 10_000 - (100 + 200 + 300) });
});

test("sans total provider crédible, la charge fixe reste celle qu'on mesure", () => {
  const fixed = contextParts(events, 0).find((part) => part.label === "Charge fixe");
  expect(fixed?.tokens).toBe(95);
  expect(fixed?.inferred).toBe(false);
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

test("une seule part est marquée incompressible : la charge fixe", () => {
  const persistent = contextParts(events, 10_000, 1_000_000)
    .filter((part) => part.persistent)
    .map((part) => part.label);
  expect(persistent).toEqual(["Charge fixe"]);
});

test("les grands nombres s'abrègent en millions", () => {
  expect(formatCompact(1_000_000)).toBe("1 M");
  expect(formatCompact(1_234_567)).toBe("1,23 M");
  expect(formatCompact(12_340)).toBe("12,3 k");
  expect(formatCompact(842)).toBe("842");
});

test("le bridge conductor entre dans la charge fixe sans gonfler le total", () => {
  const withBridge = contextParts(events, 10_000, 1_000_000, 1_200);
  const without = contextParts(events, 10_000, 1_000_000, 0);
  const fixed = (parts: typeof withBridge) =>
    parts.find((part) => part.label === "Charge fixe")?.tokens;
  // Mesurer le bridge déplace des tokens du déduit vers le mesuré : le total
  // de la charge fixe, lui, ne bouge pas.
  expect(fixed(withBridge)).toBe(fixed(without));
  expect(withBridge.reduce((sum, part) => sum + part.tokens, 0)).toBe(1_000_000);
});

test("le ratio incompressible se rapporte à la fenêtre entière", () => {
  const parts = contextParts(events, 10_000, 20_000);
  // Charge fixe = 10 000 - (100 + 200 + 300) = 9 400, sur une fenêtre de 20 000.
  expect(persistentRatio(parts, 20_000)).toBeCloseTo(0.47, 2);
  expect(persistentRatio(parts, 0)).toBe(0);
});

test("le seuil d'alerte reste sous la moitié de la fenêtre", () => {
  expect(PERSISTENT_ALERT_RATIO).toBeGreaterThan(0);
  expect(PERSISTENT_ALERT_RATIO).toBeLessThan(0.5);
});
