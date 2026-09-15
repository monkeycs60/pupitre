import { expect, test } from "bun:test";
import { buildCreateConversationInput } from "../../ui/src/conversationDraft";

test("le brouillon de conversation transmet explicitement le choix orchestrateur", () => {
  expect(buildCreateConversationInput({
    projectId: "project-1",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: "standard",
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
    branch: null,
    ticketId: null,
    message: "travaille seul",
    images: [],
    attachments: [],
  });
});

test("le brouillon transmet la branche et son dépôt, et rien quand il n'y en a pas", () => {
  const base = {
    projectId: "project-1",
    provider: "claude" as const,
    model: "sonnet",
    effort: "high",
    speed: "standard" as const,
    message: "ouvre une branche",
    images: [],
    attachments: [],
  };

  expect(buildCreateConversationInput({
    ...base,
    branch: "ticket-42",
    repositoryPath: "/project/apps/api",
  })).toMatchObject({ branch: "ticket-42", repositoryPath: "/project/apps/api" });
  // Un champ vide ou absent vaut « travaille dans le dépôt principal ».
  expect(buildCreateConversationInput({ ...base, branch: "  " }).branch).toBeNull();
  expect(buildCreateConversationInput(base).branch).toBeNull();
  expect(buildCreateConversationInput(base)).not.toHaveProperty("repositoryPath");
});

test("le brouillon transmet ticketId et nettoie la branche", () => {
  const input = buildCreateConversationInput({
    projectId: "project-1",
    provider: "claude",
    model: "sonnet",
    effort: "high",
    speed: "standard",
    branch: " feature/TECH-1 ",
    ticketId: "ticket-1",
    message: "ouvre le ticket",
    images: [],
    attachments: [],
  });

  expect(input.branch).toBe("feature/TECH-1");
  expect(input.ticketId).toBe("ticket-1");
});
