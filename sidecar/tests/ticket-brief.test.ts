import { expect, test } from "bun:test";
import { composeTicketBrief, MAX_BRIEF_CHARS } from "../src/ticket-brief";

const base = {
  ticket: {
    key: "TECH-24657",
    title: "Leviers",
    status: "in progress",
    source: "clickup" as const,
    external_url: "https://app.clickup.com/t/x",
  },
  branches: ["feature/TECH-24657"],
  refs: [{
    kind: "mr" as const,
    ref: "reactor!1862",
    payload: {
      url: "https://git/1862",
      state: "opened",
      mergeStatus: "mergeable",
    },
  }],
  notes: [{ body: "penser au cache", created_at: "2026-08-19T10:00:00Z" }],
  clickup: {
    description: "Faire la chose.",
    comments: [{ author: "Alex", text: "Dernier mot", at: "2026-08-19T09:00:00Z" }],
  },
  siblings: [{
    id: "c1",
    title: "Première passe",
    summary: "Ajout du modèle",
    debrief: "# Débrief\n\nFait A, reste B.",
  }],
};

test("compose un brief markdown ordonné et borné", () => {
  const brief = composeTicketBrief(base);
  expect(brief.startsWith("# Reprise du ticket TECH-24657")).toBe(true);
  const order = [
    "## Ticket",
    "## Branche et MR",
    "## Notes",
    "## Conversations précédentes",
    "## Consigne",
  ].map((heading) => brief.indexOf(heading));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(brief).toContain("feature/TECH-24657");
  expect(brief).toContain("read_sibling_conversation");
  expect(brief).toContain("c1");
});

test("tronque les débriefs trop longs sans dépasser la borne", () => {
  const brief = composeTicketBrief({
    ...base,
    siblings: [{
      id: "c1",
      title: "t",
      summary: "s",
      debrief: "x".repeat(MAX_BRIEF_CHARS * 2),
    }],
  });
  expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS + 200);
  expect(brief).toContain("[tronqué]");
});

test("sans ClickUp ni conversations sœurs, les sections absentes ne sont pas écrites", () => {
  const brief = composeTicketBrief({
    ...base,
    clickup: null,
    siblings: [],
    notes: [],
  });
  expect(brief).not.toContain("## Notes");
  expect(brief).not.toContain("## Conversations précédentes");
});
