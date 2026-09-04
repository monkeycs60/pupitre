import { beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { locateAnnotation } from "../src/overlay";
import type { Annotation } from "../src/types";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
});

const annotation: Annotation = {
  number: 1,
  instruction: "Resserre ce bloc",
  point: { x: 110, y: 220, elementX: 10, elementY: 20 },
  selectors: ["#target"],
  html: "<section id=\"target\"></section>",
  styles: {},
};

test("recalcule le rectangle et le point depuis l'élément vivant", () => {
  document.body.innerHTML = '<section id="target"></section>';
  const target = document.querySelector("#target")!;
  target.getBoundingClientRect = () => ({ left: 40, top: 60, width: 300, height: 120, right: 340, bottom: 180, x: 40, y: 60, toJSON() {} });
  expect(locateAnnotation(annotation, document)).toEqual({ left: 40, top: 60, width: 300, height: 120, pointX: 50, pointY: 80 });
});

test("signale un élément disparu au lieu de conserver des coordonnées périmées", () => {
  document.body.innerHTML = "";
  expect(locateAnnotation(annotation, document)).toBeNull();
});

test("ignore un sélecteur partagé au profit du sélecteur structurel unique", () => {
  document.body.innerHTML = '<main><article class="card"></article><article class="card"></article></main>';
  const cards = [...document.querySelectorAll(".card")];
  cards[0]!.getBoundingClientRect = () => ({ left: 20, top: 10, width: 100, height: 50, right: 120, bottom: 60, x: 20, y: 10, toJSON() {} });
  cards[1]!.getBoundingClientRect = () => ({ left: 220, top: 10, width: 100, height: 50, right: 320, bottom: 60, x: 220, y: 10, toJSON() {} });
  expect(locateAnnotation({ ...annotation, selectors: ["article.card", "main > article:nth-of-type(2)"] }, document)?.left).toBe(220);
});
