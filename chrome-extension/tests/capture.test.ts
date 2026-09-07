import { beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let shadow: ShadowRoot;
const messages: Array<{ type: string; panelHidden: boolean }> = [];

beforeAll(async () => {
  if (typeof document === "undefined") GlobalRegistrator.register();
  // Le panneau vit dans un shadow root fermé : le test l'ouvre pour pouvoir
  // observer ce que `captureVisibleTab` photographierait.
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    shadow = attach.call(this, { ...init, mode: "open" });
    return shadow;
  };
  (globalThis as any).Option ??= class {
    constructor(text: string, value: string, _default?: boolean, selected?: boolean) {
      const option = document.createElement("option");
      option.textContent = text;
      option.value = value;
      if (selected) option.selected = true;
      return option as unknown as HTMLOptionElement;
    }
  };
  (globalThis as any).chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (message: any) => {
        const panel = shadow.querySelector<HTMLElement>(".panel");
        messages.push({ type: message.type, panelHidden: panel?.hidden !== false });
        if (message.type === "RESOLVE") {
          return {
            status: "resolved",
            via: "cwd",
            project: { id: "p1", name: "Projet" },
            projects: [{ id: "p1", name: "Projet" }],
            instance: "dev",
            instancePort: 4821,
            destinations: { branches: ["main"], currentBranch: "main", conversations: [] },
          };
        }
        if (message.type === "GET_STATE") return { carts: {}, branches: {}, conversations: {} };
        if (message.type === "ADD_ANNOTATION") {
          return { annotations: [{ ...message.annotation, number: 1 }] };
        }
        return {};
      },
    },
  };
  document.body.innerHTML = '<section id="cible">texte</section>';
  await import("../src/content");
  await Bun.sleep(10);
});

test("le panier est retiré du DOM pendant la capture", async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", altKey: true, shiftKey: true, bubbles: true }));
  document.getElementById("cible")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await Bun.sleep(10);
  const textarea = shadow.querySelector<HTMLTextAreaElement>(".bubble textarea")!;
  expect(textarea).not.toBeNull();
  textarea.value = "Resserre ce bloc";
  shadow.querySelector<HTMLButtonElement>(".bubble button.primary")!.click();
  await Bun.sleep(60);

  const capture = messages.find((item) => item.type === "ADD_ANNOTATION");
  expect(capture).toBeDefined();
  expect(capture!.panelHidden).toBe(true);
  expect(shadow.querySelectorAll(".bubble").length).toBe(0);
});

test("le panier revient après la capture, et nomme l'instance visée", () => {
  const panel = shadow.querySelector<HTMLElement>(".panel")!;
  expect(panel.hidden).toBe(false);
  expect(panel.querySelector("strong")!.textContent).toBe("Panier Pupitre dev · 4821 · 1");
  expect(shadow.querySelectorAll(".marker").length).toBe(1);
});
