import { expect, test } from "bun:test";
import { toggleAction, withTaskActions } from "../../ui/src/taskDraft";

const A2 = { index: 2, label: "Compile et vérifie", kind: "do-this" as const };
const A4 = { index: 4, label: "Lance bun test", kind: "do-this" as const };
const F1 = { index: 1, label: "Bouton tout cocher", kind: "follow-up" as const };
const F3 = { index: 3, label: "Persister l'état en base", kind: "follow-up" as const };

test("une seule action donne une consigne au singulier", () => {
  expect(withTaskActions("", [A2])).toBe(
    "Exécute l'action 2 du bloc DO THIS :\n2) Compile et vérifie",
  );
});

test("deux actions sont énumérées et listées avec leur numéro", () => {
  expect(withTaskActions("", [A4, A2])).toBe(
    [
      "Exécute les actions 2 et 4 du bloc DO THIS :",
      "2) Compile et vérifie",
      "4) Lance bun test",
    ].join("\n"),
  );
});

test("trois actions gardent une énumération lisible", () => {
  const draft = withTaskActions("", [A2, A4, { ...A2, index: 6, label: "Choisis la suite" }]);
  expect(draft.split("\n")[0]).toBe("Exécute les actions 2, 4 et 6 du bloc DO THIS :");
});

test("une piste FOLLOW-UP a son propre verbe", () => {
  expect(withTaskActions("", [F1])).toBe(
    "Explore la piste 1 du bloc FOLLOW-UP :\n1) Bouton tout cocher",
  );
});

test("les deux sections cohabitent, DO THIS en premier", () => {
  expect(withTaskActions("", [F3, A2, F1])).toBe(
    [
      "Exécute l'action 2 du bloc DO THIS :",
      "2) Compile et vérifie",
      "",
      "Explore les pistes 1 et 3 du bloc FOLLOW-UP :",
      "1) Bouton tout cocher",
      "3) Persister l'état en base",
    ].join("\n"),
  );
});

test("un même numéro dans les deux sections ne se télescope pas", () => {
  const selection = toggleAction(toggleAction([], A2, true), { ...F1, index: 2 }, true);
  expect(selection).toHaveLength(2);
});

test("le texte saisi à la main est conservé au-dessus", () => {
  expect(withTaskActions("Contexte : branche X", [A2]).split("\n")[0])
    .toBe("Contexte : branche X");
});

test("recomposer remplace les blocs précédents au lieu de les empiler", () => {
  const once = withTaskActions("Note", [A2]);
  const twice = withTaskActions(once, [A2, F1]);
  expect(twice.match(/du bloc/gu)).toHaveLength(2);
  expect(twice.startsWith("Note")).toBe(true);
});

test("tout décocher ne laisse que le texte saisi", () => {
  const draft = withTaskActions("Note", [A2, F1]);
  expect(withTaskActions(draft, [])).toBe("Note");
});

test("décocher une action retire sa ligne et met l'en-tête à jour", () => {
  const selection = toggleAction(toggleAction([], A2, true), A4, true);
  const reduced = toggleAction(selection, A2, false);
  expect(reduced).toEqual([A4]);
  expect(withTaskActions("", reduced).split("\n")[0])
    .toBe("Exécute l'action 4 du bloc DO THIS :");
});

test("cocher deux fois la même ligne ne la duplique pas", () => {
  expect(toggleAction(toggleAction([], A2, true), A2, true)).toEqual([A2]);
});
