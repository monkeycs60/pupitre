import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { SettingsStore } from "../src/stores/settings";
import {
  createVisualFeedbackToken,
  sanitizeVisualFeedbackSubmission,
  verifyVisualFeedbackToken,
  visualFeedbackPrompt,
  type VisualFeedbackSubmission,
} from "../src/visual-feedback";

const submission: VisualFeedbackSubmission = {
  version: 1,
  submissionId: "feedback-1",
  projectId: "project-1",
  branch: "feat/header",
  page: {
    url: "http://localhost:5173/settings",
    title: "Pupitre",
    viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
  },
  annotations: [
    {
      number: 2,
      instruction: "Réduis cet espace.",
      point: { x: 420, y: 210, elementX: 20, elementY: 10 },
      selectors: ["[data-testid=header]", "header.app-header"],
      html: '<header><input value="secret"><div contenteditable="true">privé</div></header>',
      styles: { display: "flex", marginTop: "24px", backgroundImage: "url(secret)" },
      cropDataUrl: "data:image/png;base64,YQ==",
      viewportDataUrl: "data:image/png;base64,Yg==",
    },
    {
      number: 1,
      instruction: "Aligne ce bouton.",
      point: { x: 100, y: 80, elementX: 5, elementY: 5 },
      selectors: ["#save"],
      html: '<button id="save">Sauver</button>',
      styles: { display: "inline-flex" },
    },
  ],
};

test("nettoie les données DOM sensibles avant de construire le prompt", () => {
  const clean = sanitizeVisualFeedbackSubmission(submission);
  expect(clean.annotations[0]!.html).toBe('<header><input><div contenteditable="true"></div></header>');
  expect(clean.annotations[0]!.styles).toEqual({ display: "flex", marginTop: "24px" });
});

test("ordonne les annotations par numéro dans un prompt exploitable", () => {
  const prompt = visualFeedbackPrompt(sanitizeVisualFeedbackSubmission(submission));
  expect(prompt.indexOf("## Annotation 1")).toBeLessThan(prompt.indexOf("## Annotation 2"));
  expect(prompt).toContain("URL : http://localhost:5173/settings");
  expect(prompt).toContain("Sélecteurs : #save");
  expect(prompt).not.toContain("data:image/png");
});

test("refuse les branches dangereuses et les paniers vides", () => {
  expect(() => sanitizeVisualFeedbackSubmission({ ...submission, branch: "../main" })).toThrow("branche invalide");
  expect(() => sanitizeVisualFeedbackSubmission({ ...submission, annotations: [] })).toThrow("annotation");
});

test("persiste les tables et remplace le jeton d'appairage", () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-visual-feedback-")));
  const settings = new SettingsStore(db);
  const first = createVisualFeedbackToken(settings);
  expect(verifyVisualFeedbackToken(settings, first)).toBe(true);
  const second = createVisualFeedbackToken(settings);
  expect(verifyVisualFeedbackToken(settings, first)).toBe(false);
  expect(verifyVisualFeedbackToken(settings, second)).toBe(true);
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  expect(tables.map((row) => row.name)).toContain("visual_feedback_submissions");
  expect(tables.map((row) => row.name)).toContain("visual_feedback_origins");
  db.close();
});
