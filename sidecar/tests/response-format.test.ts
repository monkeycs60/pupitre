import { expect, test } from "bun:test";
import {
  DEFAULT_ACTION_FORMAT,
  actionFormat,
  actionFormatPreamble,
  withActionFormat,
} from "../src/response-format";

test("un réglage absent retombe entièrement sur les défauts", () => {
  expect(actionFormat(null)).toEqual(DEFAULT_ACTION_FORMAT);
  expect(actionFormat({})).toEqual(DEFAULT_ACTION_FORMAT);
});

test("les intitulés sont normalisés en majuscules et dédoublonnés", () => {
  expect(actionFormat({ todoHeadings: ["todo", " TODO ", "à faire"] }).todoHeadings)
    .toEqual(["TODO", "À FAIRE"]);
});

test("une liste vide ne désactive pas la détection", () => {
  expect(actionFormat({ todoHeadings: [] }).todoHeadings)
    .toEqual(DEFAULT_ACTION_FORMAT.todoHeadings);
  expect(actionFormat({ followUpHeadings: ["   "] }).followUpHeadings)
    .toEqual(DEFAULT_ACTION_FORMAT.followUpHeadings);
});

test("le premier intitulé est celui demandé à l'agent", () => {
  const preamble = actionFormatPreamble(
    actionFormat({ todoHeadings: ["Actions"], followUpHeadings: ["Idées"] }),
  );
  expect(preamble).toContain("*ACTIONS*");
  expect(preamble).toContain("*IDÉES*");
});

test("les livrables de réflexion longs privilégient un HTML éphémère", () => {
  const preamble = actionFormatPreamble(DEFAULT_ACTION_FORMAT);
  expect(preamble).toContain("document HTML autonome et éphémère");
  expect(preamble).toContain("dans /tmp");
  expect(preamble).toContain("publish_document");
  expect(preamble).toContain("Un simple lien local ne constitue pas une livraison");
});

test("la consigne précède la demande utilisateur", () => {
  const prompt = withActionFormat("corrige le bug", DEFAULT_ACTION_FORMAT);
  expect(prompt.endsWith("\n\ncorrige le bug")).toBe(true);
  expect(prompt.startsWith("[Format de réponse — Pupitre]")).toBe(true);
});

test("désactivé, le prompt part intact", () => {
  expect(withActionFormat("corrige le bug", { ...DEFAULT_ACTION_FORMAT, enabled: false }))
    .toBe("corrige le bug");
});
