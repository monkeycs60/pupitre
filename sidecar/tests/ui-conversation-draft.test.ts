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
    subagentPresetId: null,
    subagentEffort: null,
    message: "travaille seul",
    images: [],
    attachments: [],
  })).toEqual({
    projectId: "project-1",
    presetId: null,
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: undefined,
    permissionMode: null,
    orchestrator: false,
    subagentPresetId: null,
    subagentEffort: null,
    message: "travaille seul",
    images: [],
    attachments: [],
  });
});
