import { expect, test } from "bun:test";
import { resumeCommand } from "../../ui/src/resumeCommand";
import type { Conversation } from "../../ui/src/types";

function conversation(provider: "claude" | "codex", sessionId: string | null): Conversation {
  return {
    id: "conversation", project_id: "project", title: "Reprise", provider,
    model: "model", effort: null, speed: null, orchestrator: true,
    continued_from: null, routine_id: null, cli_session_id: sessionId,
    pinned: false, created_at: "", updated_at: "",
  };
}

test("génère la commande de reprise propre à chaque CLI", () => {
  expect(resumeCommand(conversation("claude", "session-123")))
    .toBe("claude --resume 'session-123'");
  expect(resumeCommand(conversation("codex", "thread-456")))
    .toBe("codex resume 'thread-456'");
  expect(resumeCommand(conversation("codex", null))).toBeNull();
});
