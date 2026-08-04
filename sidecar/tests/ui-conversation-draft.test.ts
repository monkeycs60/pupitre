import { expect, test } from "bun:test";
import { buildCreateConversationInput } from "../../ui/src/conversationDraft";

test("le brouillon de conversation transmet explicitement le choix orchestrateur", () => {
  expect(buildCreateConversationInput({
    projectId: "project-1",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: "standard",
    orchestrator: false,
    message: "travaille seul",
    images: [],
  })).toEqual({
    projectId: "project-1",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: undefined,
    orchestrator: false,
    message: "travaille seul",
    images: [],
  });
});
