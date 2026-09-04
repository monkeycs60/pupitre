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
