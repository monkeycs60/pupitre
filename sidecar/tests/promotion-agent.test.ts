import { expect, test } from "bun:test";
import type { StoredEvent } from "../src/events";
import {
  PROMOTION_SUCCESS_MARKER,
  PromotionAgentConflictError,
  PromotionAgentService,
  promotionAgentPrompt,
} from "../src/promotion-agent";
import type { Conversation } from "../src/stores/conversations";
import type { Project } from "../src/stores/projects";

function harness() {
  let conversation: Conversation | null = null;
  let events: StoredEvent[] = [];
  let running = false;
  let runInput: string | null = null;
  const service = new PromotionAgentService(
    "/tmp/pupitre",
    { list: () => [{ id: "p1", path: "/tmp/pupitre" } as Project] },
    {
      create: (input) => {
        conversation = {
          id: "c1",
          project_id: input.projectId,
          model: input.model,
          effort: input.effort,
          permission_mode: input.permissionMode,
          orchestrator: input.orchestrator,
          worktree_path: input.worktreePath,
          origin_type: input.originType,
          origin_key: input.originKey,
          created_at: "2026-09-04T12:00:00.000Z",
          updated_at: "2026-09-04T12:00:00.000Z",
        } as Conversation;
        return conversation;
      },
      latestByOrigin: () => conversation,
      listEvents: () => events,
    },
    {
      isRunning: () => running,
      runTurn: async (_id, message) => {
        runInput = message;
        running = true;
      },
    },
  );
  return {
    service,
    get conversation() { return conversation; },
    get runInput() { return runInput; },
    setEvents(next: StoredEvent[]) { events = next; },
    setRunning(next: boolean) { running = next; },
  };
}

test("crée une conversation Luna high autonome dans le dépôt principal", () => {
  const state = harness();
  const mission = state.service.start();

  expect(mission.state).toBe("running");
  expect(state.conversation?.model).toBe("gpt-5.6-luna");
  expect(state.conversation?.effort).toBe("high");
  expect(state.conversation?.permission_mode).toBe("bypassPermissions");
  expect(state.conversation?.worktree_path).toBeNull();
  expect(state.runInput).toContain("Committe automatiquement toutes les modifications");
  expect(promotionAgentPrompt()).toContain(PROMOTION_SUCCESS_MARKER);
});

test("attend l'utilisateur après un tour sans preuve terminale", () => {
  const state = harness();
  state.service.start();
  state.setRunning(false);
  state.setEvents([
    { id: 1, type: "text-final", text: "J'ai besoin d'une décision produit." },
    { id: 2, type: "status", state: "done" },
  ] as StoredEvent[]);
  expect(state.service.snapshot()?.state).toBe("waiting_user");
  expect(() => state.service.start()).toThrow(PromotionAgentConflictError);
});

test("ne réussit qu'avec le marqueur de vérification", () => {
  const state = harness();
  state.service.start();
  state.setRunning(false);
  state.setEvents([
    { id: 1, type: "text-final", text: `Stable vérifiée.\n${PROMOTION_SUCCESS_MARKER}` },
    { id: 2, type: "status", state: "done" },
  ] as StoredEvent[]);
  expect(state.service.snapshot()?.state).toBe("succeeded");
});
