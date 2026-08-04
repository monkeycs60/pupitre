import { expect, test } from "bun:test";
import {
  appendDebriefQuestionPrompt,
  debriefQuestionPrompt,
} from "../../ui/src/debriefQuestion";

test("pré-remplit une question avec le débrief et une consigne de citation", () => {
  const prompt = debriefQuestionPrompt({
    kind: "debrief",
    id: "block-1",
    debriefId: "debrief-1",
    eventIdFrom: 12,
    eventIdTo: 34,
    contentMd: "## Décisions et pourquoi\nSQLite [événement #18].",
    createdAt: "2026-08-04T10:00:00.000Z",
  });

  expect(prompt).toContain("Ma question :\n")
  expect(prompt).toContain("SQLite [événement #18]")
  expect(prompt).toContain("cite les événements [événement #N]")
});

test("préserve un brouillon existant avant d'ajouter la question", () => {
  const block = {
    kind: "debrief" as const,
    id: "block-1",
    debriefId: "debrief-1",
    eventIdFrom: 12,
    eventIdTo: 34,
    contentMd: "## Décisions et pourquoi\nSQLite.",
    createdAt: "2026-08-04T10:00:00.000Z",
  };
  const prompt = appendDebriefQuestionPrompt("Mon brouillon important", block);

  expect(prompt).toStartWith("Mon brouillon important");
  expect(prompt).toContain("Question sur le débrief");
});
