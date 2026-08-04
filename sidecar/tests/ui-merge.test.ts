// Teste la logique pure de raccord replay/WS du frontend (aucun DOM requis).
import { expect, test } from "bun:test";
import { mergeReplayAndBuffer } from "../../ui/src/mergeEvents";
import type { StoredEvent } from "../../ui/src/types";

function delta(id: number, text: string): StoredEvent {
  return { id, type: "text-delta", text };
}

test("un buffer vide laisse le replay intact", () => {
  const replay = [delta(1, "a"), delta(2, "b")];

  expect(mergeReplayAndBuffer(replay, [])).toEqual(replay);
});

test("les événements bufferisés déjà présents dans le replay ne sont pas dupliqués", () => {
  const replay = [delta(1, "a"), delta(2, "b")];
  const buffer = [delta(2, "b"), delta(3, "c")];

  expect(mergeReplayAndBuffer(replay, buffer)).toEqual([
    delta(1, "a"),
    delta(2, "b"),
    delta(3, "c"),
  ]);
});

test("un événement bufferisé absent du replay est conservé (fenêtre de perte fermée)", () => {
  const replay = [delta(1, "a")];
  const buffer: StoredEvent[] = [{ id: 2, type: "status", state: "done" }];

  expect(mergeReplayAndBuffer(replay, buffer)).toEqual([
    delta(1, "a"),
    { id: 2, type: "status", state: "done" },
  ]);
});

test("le résultat est trié par id même si le buffer arrive dans le désordre", () => {
  const replay = [delta(3, "c")];
  const buffer = [delta(5, "e"), delta(4, "d")];

  expect(mergeReplayAndBuffer(replay, buffer).map((event) => event.id)).toEqual([3, 4, 5]);
});

test("les doublons internes au buffer sont écrasés une seule fois", () => {
  const buffer = [delta(1, "a"), delta(1, "a")];

  expect(mergeReplayAndBuffer([], buffer)).toEqual([delta(1, "a")]);
});

test("le replay fait foi quand un même id existe des deux côtés", () => {
  const merged = mergeReplayAndBuffer([delta(1, "replay")], [delta(1, "buffer")]);

  expect(merged).toEqual([delta(1, "replay")]);
});
