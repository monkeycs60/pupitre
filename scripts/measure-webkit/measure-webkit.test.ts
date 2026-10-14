import { expect, test } from "bun:test";
import { median, servesCurrentSource, summarize } from "./measure-webkit";

function served(source: string): string {
  const map = Buffer.from(JSON.stringify({ version: 3, sourcesContent: [source] })).toString("base64");
  return `const a = 1;\n//# sourceMappingURL=data:application/json;base64,${map}`;
}

test("reconnaît un Vite qui sert une version figée du fichier", () => {
  expect(servesCurrentSource(served("export const a = 1\n"), "export const a = 1\n")).toBe(true);
  expect(servesCurrentSource(served("export const a = 1\n"), "export const a = 2\n")).toBe(false);
  expect(servesCurrentSource("const a = 1;", "const a = 1;")).toBe(false);
});

test("résume plusieurs passages par leurs médianes et garde le pire saut de hauteur", () => {
  expect(median([30, 10, 20])).toBe(20);
  expect(summarize([
    { step: "done", p50: 30, p95: 50, max: 140, fps: 28, heightShift: 0, renderMs: 900, nodes: 4597 },
    { step: "done", p50: 34, p95: 70, max: 200, fps: 24, heightShift: -12, renderMs: 1100, nodes: 4600 },
    { step: "error" },
  ])).toEqual({ p50: 30, p95: 50, max: 140, fps: 24, heightShift: 12, renderMs: 900, nodes: 4597 });
});
