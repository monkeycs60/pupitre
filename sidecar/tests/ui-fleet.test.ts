// Teste la mémoire locale de Fleet sans DOM ni backend.
import { expect, test } from "bun:test";
import {
  FLEET_HISTORY_LIMIT,
  rememberDepartedFleetRuns,
} from "../../ui/src/useFleet";
import type { FleetItem } from "../../ui/src/types";

function item(id: string, lastEvent = "outil terminé"): FleetItem {
  return {
    id,
    kind: "turn",
    projectId: "project",
    projectName: "Projet",
    conversationId: `conversation-${id}`,
    title: `Run ${id}`,
    provider: "claude",
    model: "haiku",
    startedAt: "2026-08-07T10:00:00.000Z",
    lastEvent,
  };
}

test("un run sorti du snapshot est mémorisé avec son dernier état connu", () => {
  const previous = [item("one", "réponse du modèle")];
  const history = rememberDepartedFleetRuns(
    previous,
    [],
    [],
    "2026-08-07T10:02:00.000Z",
  );

  expect(history).toEqual([
    expect.objectContaining({
      id: "one",
      lastEvent: "réponse du modèle",
      leftActiveAt: "2026-08-07T10:02:00.000Z",
    }),
  ]);
});

test("un snapshot répété ne duplique pas un run et le retour actif retire l'entrée locale", () => {
  const first = rememberDepartedFleetRuns(
    [item("one")],
    [],
    [],
    "2026-08-07T10:02:00.000Z",
  );
  const repeated = rememberDepartedFleetRuns(
    [item("one")],
    [],
    first,
    "2026-08-07T10:03:00.000Z",
  );

  expect(repeated).toEqual(first);
  expect(rememberDepartedFleetRuns([], [item("one")], repeated, "2026-08-07T10:04:00.000Z"))
    .toEqual([]);
});

test("l'historique reste court", () => {
  const previous = Array.from({ length: FLEET_HISTORY_LIMIT + 3 }, (_, index) => item(String(index)));
  const history = rememberDepartedFleetRuns(previous, [], [], "2026-08-07T10:02:00.000Z");

  expect(history).toHaveLength(FLEET_HISTORY_LIMIT);
});
