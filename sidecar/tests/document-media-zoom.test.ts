import { expect, test } from "bun:test";
import { withMediaZoom } from "../src/document-media-zoom";

test("injecte le script d'agrandissement avant la dernière balise body", () => {
  const html = "<html><body><p>&lt;/body&gt;</p><img src=\"data:image/png;base64,AA\"></body></html>";
  const result = withMediaZoom(html);
  expect(result.indexOf("pupitre:media-zoom")).toBeLessThan(result.lastIndexOf("</body>"));
  expect(result.endsWith("</body></html>")).toBe(true);
});

test("ajoute le script en fin de document sans balise body", () => {
  expect(withMediaZoom("<!doctype html><p>x</p>")).toMatch(/<p>x<\/p><script>[\s\S]*<\/script>$/);
});
