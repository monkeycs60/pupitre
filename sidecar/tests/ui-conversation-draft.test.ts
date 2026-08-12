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
    branch: null,
    message: "travaille seul",
    images: [],
    attachments: [],
  });
});

test("le brouillon transmet la branche choisie, et rien quand il n'y en a pas", () => {
  const base = {
    projectId: "project-1",
    provider: "claude" as const,
    model: "sonnet",
    effort: "high",
    speed: "standard" as const,
    orchestrator: true,
    subagentPresetId: null,
    subagentEffort: null,
    message: "ouvre une branche",
    images: [],
    attachments: [],
  };

  expect(buildCreateConversationInput({ ...base, branch: "ticket-42" }).branch)
    .toBe("ticket-42");
  // Un champ vide ou absent vaut « travaille dans le dépôt principal ».
  expect(buildCreateConversationInput({ ...base, branch: "  " }).branch).toBeNull();
  expect(buildCreateConversationInput(base).branch).toBeNull();
});
