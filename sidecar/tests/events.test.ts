import { test, expect } from "bun:test";
import { parseJsonlLine } from "../src/events";

test("parseJsonlLine parse une ligne valide", () => {
  expect(parseJsonlLine('{"type":"x","a":1}')).toEqual({ type: "x", a: 1 });
});

test("parseJsonlLine renvoie null sur ligne vide ou invalide", () => {
  expect(parseJsonlLine("")).toBeNull();
  expect(parseJsonlLine("not json")).toBeNull();
});
