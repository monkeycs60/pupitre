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

// Ratios calibrés : 3,5 pour la prose, 3 pour le code des sorties d'outils.
const MESURE = { user: 114, assistant: 229, tools: 400, pupitre: 95 };

test("regroupe le contexte en charge fixe, conversation et outils", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.map((part) => [part.label, part.group])).toEqual([
    ["Consignes Pupitre", "fixe"],
    ["Vos messages", "conversation"],
    ["Réponses de l’agent", "conversation"],
    ["Autres", "conversation"],
    ["Fichiers lus et commandes", "outils"],
  ]);
});

test("le ratio caractères/token calibré vaut 3,5", () => {
  const parts = contextParts(events, 10_000);
  // 400 caractères de message utilisateur → 114 tokens, pas 100.
  expect(parts.find((part) => part.label === "Vos messages")?.tokens).toBe(MESURE.user);
  expect(parts.find((part) => part.label === "Réponses de l’agent")?.tokens)
    .toBe(MESURE.assistant);
});

test("le raisonnement est la génération que le texte visible n'explique pas", () => {
  const withUsage = [
    ...events,
    { type: "usage" as const, inputTokens: 500, outputTokens: 900 },
  ];
  const parts = contextParts(withUsage, 10_000);
  // 900 tokens générés, 229 de texte visible : le reste est du raisonnement.
  expect(parts.find((part) => part.label === "Raisonnement du modèle")?.tokens)
    .toBe(900 - MESURE.assistant);
});

test("sans surplus de génération, aucune part de raisonnement n'apparaît", () => {
  const withUsage = [
    ...events,
    { type: "usage" as const, inputTokens: 500, outputTokens: 100 },
  ];
  expect(contextParts(withUsage, 10_000).some((part) => part.label === "Raisonnement du modèle"))
    .toBe(false);
});

test("la charge fixe absorbe le reliquat du total provider", () => {
  const parts = contextParts(events, 10_000);
  expect(parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(10_000);
  // Sans mesure de référence, tout le reliquat est déclaré non attribué.
  expect(parts.find((part) => part.label === "Autres")?.tokens)
    .toBe(10_000 - (MESURE.user + MESURE.assistant + MESURE.tools + MESURE.pupitre));
});

test("sans total provider crédible, seule la part Pupitre subsiste", () => {
  const parts = contextParts(events, 0);
  expect(parts.find((part) => part.inferred)).toBeUndefined();
  expect(parts.find((part) => part.label === "Consignes Pupitre")?.tokens).toBe(95);
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

test("la charge fixe reste bornée par la mesure de référence", () => {
  // Sans mesure : seules les consignes Pupitre sont déclarées incompressibles.
  expect(
    contextParts(events, 10_000, 1_000_000).filter((part) => part.persistent)
      .map((part) => part.label),
  ).toEqual(["Consignes Pupitre"]);

  // Avec une mesure de 30 000, la charge fixe vaut exactement ça — jamais le
  // reliquat entier, qui absorbe aussi l'erreur d'estimation.
  const measured = contextParts(events, 500_000, 1_000_000, 0, 30_000);
  // Sans profil détaillé, toute la base est imputée au prompt système.
  expect(measured.find((part) => part.label === "Prompt système du CLI")?.tokens)
    .toBe(30_000);
  expect(measured.find((part) => part.label === "Autres")?.tokens)
    .toBeGreaterThan(400_000);
});

test("les grands nombres s'abrègent en millions", () => {
  expect(formatCompact(1_000_000)).toBe("1 M");
  expect(formatCompact(1_234_567)).toBe("1,23 M");
  expect(formatCompact(12_340)).toBe("12,3 k");
  expect(formatCompact(842)).toBe("842");
});

test("le bridge conductor bascule du déduit vers les consignes Pupitre", () => {
  const withBridge = contextParts(events, 10_000, 1_000_000, 1_200);
  const without = contextParts(events, 10_000, 1_000_000, 0);
  const part = (parts: typeof withBridge, label: string) =>
    parts.find((item) => item.label === label)!.tokens;
  expect(part(withBridge, "Consignes Pupitre") - part(without, "Consignes Pupitre")).toBe(1_200);
  expect(part(without, "Autres") - part(withBridge, "Autres")).toBe(1_200);
  expect(withBridge.reduce((sum, item) => sum + item.tokens, 0)).toBe(1_000_000);
});

test("le ratio incompressible se rapporte à la fenêtre entière", () => {
  // Charge fixe mesurée à 9 000 sur une fenêtre de 20 000.
  const parts = contextParts(events, 10_000, 20_000, 0, 9_000);
  expect(persistentRatio(parts, 20_000)).toBeCloseTo(0.45, 2);
  expect(persistentRatio(parts, 0)).toBe(0);
});

test("le seuil d'alerte reste sous la moitié de la fenêtre", () => {
  expect(PERSISTENT_ALERT_RATIO).toBeGreaterThan(0);
  expect(PERSISTENT_ALERT_RATIO).toBeLessThan(0.5);
});

test("la charge fixe détaille instructions et MCP quand ils sont mesurés", () => {
  const parts = contextParts(events, 500_000, 1_000_000, 0, 30_000, {
    instructionsTokens: 1_800,
    mcpTokens: 6_100,
  });
  const at = (label: string) => parts.find((part) => part.label === label)?.tokens;
  expect(at("Instructions globales")).toBe(1_800);
  expect(at("Outils MCP")).toBe(6_100);
  // Le prompt système est le reste de la base mesurée, jamais publié tel quel.
  expect(at("Prompt système du CLI")).toBe(30_000 - 1_800 - 6_100);
});

test("instructions et MCP s'affichent même sans mesure de référence", () => {
  // Le cas courant : on sait peser les fichiers et les serveurs sur disque,
  // alors que la base demande un tour CLI que l'utilisateur n'a pas lancé.
  const parts = contextParts(events, 500_000, 1_000_000, 0, 0, {
    instructionsTokens: 1_800,
    mcpTokens: 6_100,
  });
  const at = (label: string) => parts.find((part) => part.label === label)?.tokens;
  expect(at("Instructions globales")).toBe(1_800);
  expect(at("Outils MCP")).toBe(6_100);
  // Le prompt système, lui, reste absent tant qu'il n'est pas mesuré.
  expect(at("Prompt système du CLI")).toBeUndefined();
});

test("un profil plus lourd que le reliquat ne crée pas de part négative", () => {
  const parts = contextParts(events, 2_000, 1_000_000, 0, 5_000, {
    instructionsTokens: 9_000,
    mcpTokens: 9_000,
  });
  for (const part of parts) expect(part.tokens).toBeGreaterThanOrEqual(0);
});

test("les images d'un message sont comptées", () => {
  const withImage = [
    { type: "user-message" as const, text: "regarde", images: ["a.png", "b.png"] },
  ];
  expect(contextParts(withImage, 10_000).find((part) => part.label === "Images et captures")?.tokens)
    .toBe(3_000);
});

test("les sorties d'outils utilisent le ratio du code", () => {
  // 1 200 caractères de sortie d'outil : 400 tokens à 3 par token, pas 343.
  expect(contextParts(events, 10_000).find((part) => part.label === "Fichiers lus et commandes")?.tokens)
    .toBe(MESURE.tools);
});
