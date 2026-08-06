// L'UI décrit à l'utilisateur ce que la délégation ouvre : pool de modèles,
// routage recommandé, limite de concurrence. Ces informations sont dupliquées
// depuis le sidecar (descriptions d'outils MCP + SubtaskRunner) pour ne pas
// faire dépendre le front du back. Ce test empêche les deux de diverger : une
// UI qui promet un routage que l'orchestrateur ne suit plus est un mensonge.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CONCURRENT_SUBTASKS } from "../src/subtasks";
import {
  DELEGATION_ROUTING,
  MAX_CONCURRENT_SUBTASKS as UI_MAX_CONCURRENT_SUBTASKS,
  PROVIDER_MODELS,
} from "../../ui/src/modelOptions";

function conductorSource(): string {
  return readFileSync(join(import.meta.dir, "../src/conductor-mcp.ts"), "utf8");
}

test("la limite de sous-tâches affichée est celle qu'applique le runner", () => {
  expect(UI_MAX_CONCURRENT_SUBTASKS).toBe(MAX_CONCURRENT_SUBTASKS);
});

test("le routage recommandé par l'UI est celui documenté à l'orchestrateur", () => {
  const source = conductorSource();
  expect(source).toContain(
    `${DELEGATION_ROUTING.provider} / ${DELEGATION_ROUTING.model}`,
  );
});

test("le pool de modèles annoncé est celui que le conductor documente", () => {
  const source = conductorSource();
  for (const models of Object.values(PROVIDER_MODELS)) {
    for (const model of models) {
      expect(source).toContain(model);
    }
  }
});
