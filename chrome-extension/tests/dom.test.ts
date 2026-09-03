import { beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { inspectElement } from "../src/dom";

beforeAll(() => GlobalRegistrator.register());

test("décrit l'élément sans exposer les valeurs de formulaire", () => {
  document.body.innerHTML = '<main><form><input id="email" value="secret@example.com"></form></main>';
  const input = document.querySelector("input")!;
  const result = inspectElement(input, { x: 12, y: 20 });
  expect(result.selectors).toContain("#email");
  expect(result.html).toContain('id="email"');
  expect(result.html).not.toContain("secret@example.com");
});

test("produit un sélecteur structurel quand aucun identifiant stable n'existe", () => {
  document.body.innerHTML = '<main><section><button class="save primary">Sauver</button></section></main>';
  const result = inspectElement(document.querySelector("button")!, { x: 5, y: 6 });
  expect(result.selectors.some((selector) => selector.includes("button.save.primary"))).toBe(true);
});

test("expurge aussi un champ ou contenu éditable ciblé directement", () => {
  document.body.innerHTML = '<textarea>secret textarea</textarea><div contenteditable="true">secret editable</div>';
  expect(inspectElement(document.querySelector("textarea")!, { x: 1, y: 1 }).html).not.toContain("secret textarea");
  expect(inspectElement(document.querySelector("div")!, { x: 1, y: 1 }).html).not.toContain("secret editable");
});
