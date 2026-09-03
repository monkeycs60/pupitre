import { expect, test } from "bun:test";
import { addAnnotation, removeAnnotation } from "../src/cart";
import type { Carts } from "../src/types";

const annotation = {
  instruction: "Réduis la marge",
  point: { x: 10, y: 20, elementX: 2, elementY: 3 },
  selectors: ["#hero"],
  html: '<div id="hero"></div>',
  styles: {},
};

test("numérote et isole les paniers par projet", () => {
  let carts: Carts = {};
  carts = addAnnotation(carts, "project-a", annotation);
  carts = addAnnotation(carts, "project-b", annotation);
  carts = addAnnotation(carts, "project-a", annotation);
  expect(carts["project-a"]!.map((item) => item.number)).toEqual([1, 2]);
  expect(carts["project-b"]!.map((item) => item.number)).toEqual([1]);
});

test("renumérote après suppression", () => {
  let carts: Carts = addAnnotation({}, "project-a", annotation);
  carts = addAnnotation(carts, "project-a", annotation);
  carts = removeAnnotation(carts, "project-a", 1);
  expect(carts["project-a"]!.map((item) => item.number)).toEqual([1]);
});
