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
  // `status TEXT NOT NULL DEFAULT 'open'` n'apparaît que pour la colonne de
  // review_flags : ça isole ses CHECK sans dépendre d'un statut particulier.
  const checks = [...read("sidecar/src/db.ts")
    .matchAll(/status TEXT NOT NULL DEFAULT 'open'\s*CHECK \(status IN \(([^)]*)\)\)/g)]
    .map((match) => [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((item) => item[1]!));

  // Le schéma d'une base neuve et la table de reconstruction historique.
  expect(checks.length).toBeGreaterThanOrEqual(2);
  // La base neuve suit exactement le type courant.
  expect([...checks[0]!].sort()).toEqual([...expected].sort());
  // Les reconstructions historiques restent un sur-ensemble : SQLite ne sait
  // pas resserrer un CHECK existant, et une base en cours de migration peut
  // encore porter un statut retiré du type (ex. 'countered') le temps qu'une
  // migration suivante le neutralise.
  for (const check of checks.slice(1)) {
    for (const status of expected) expect(check).toContain(status);
  }
});

test("l'aide décrit chaque statut du cycle de vie", () => {
  const help = read("docs/help/gardien.md").toLowerCase();
  for (const status of typeStatuses()) {
    const label = HELP_LABELS[status];
    expect(label, `statut ${status} sans libellé d'aide déclaré`).toBeDefined();
    expect(help).toContain(label!);
  }
});
