import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Le cycle de vie d'un signalement est écrit à trois endroits : le type TS de
 * l'UI, les contraintes CHECK de SQLite et la page d'aide. Rien n'empêche
 * structurellement l'un de bouger sans les autres — ces tests le vérifient.
 */

const root = join(import.meta.dir, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Libellé utilisateur attendu dans l'aide, pour chaque statut du type. */
const HELP_LABELS: Record<string, string> = {
  open: "ouvert",
  countered: "contre-avisé",
  agent_running: "agent en cours",
  treated: "traité",
  ignored: "ignoré",
  resolved: "résolu",
};

function typeStatuses(): string[] {
  const union = read("ui/src/types.ts")
    .match(/export type ReviewFlagStatus = ([^\n]+)/)?.[1];
  expect(union).toBeDefined();
  return [...union!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

test("les contraintes SQLite couvrent exactement les statuts du type", () => {
  const expected = typeStatuses();
  const checks = [...read("sidecar/src/db.ts")
    .matchAll(/CHECK \(status IN \(([^)]*'countered'[^)]*)\)\)/g)]
    .map((match) => [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((item) => item[1]!));

  // Le schéma initial et la table de reconstruction doivent tous deux suivre.
  expect(checks.length).toBeGreaterThanOrEqual(2);
  for (const check of checks) expect([...check].sort()).toEqual([...expected].sort());
});

test("l'aide décrit chaque statut du cycle de vie", () => {
  const help = read("docs/help/gardien.md").toLowerCase();
  for (const status of typeStatuses()) {
    const label = HELP_LABELS[status];
    expect(label, `statut ${status} sans libellé d'aide déclaré`).toBeDefined();
    expect(help).toContain(label!);
  }
});
