import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { effectiveSubtaskConfig } from "../src/server";
import { ConversationStore } from "../src/stores/conversations";
import { PresetStore } from "../src/stores/presets";
import { ProjectStore } from "../src/stores/projects";

let convs: ConversationStore;
let presets: PresetStore;
let projectId: string;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-subagent-policy-")));
  projectId = new ProjectStore(db).create({ name: "p", path: "/tmp/subagent-policy" }).id;
  convs = new ConversationStore(db);
  presets = new PresetStore(db);
});

test("un preset sub-agent verrouille le provider, le modèle et l'effort du preset", () => {
  const locked = presets.create({
    name: "Terra pour les tâches",
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    speed: "standard",
    orchestrator: false,
  });
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "opus",
    subagentPresetId: locked.id,
    firstMessage: "délègue",
  });

  expect(effectiveSubtaskConfig(conversation, {
    provider: "claude",
    model: "haiku",
    effort: "low",
    speed: null,
  }, presets)).toEqual({
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    speed: "standard",
  });
});

test("un effort explicite remplace l'effort du preset sans changer le modèle", () => {
  const locked = presets.create({
    name: "Luna rapide",
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "fast",
    orchestrator: false,
  });
  const conversation = convs.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-sol",
    subagentPresetId: locked.id,
    subagentEffort: "medium",
    firstMessage: "délègue",
  });

  expect(effectiveSubtaskConfig(conversation, {
    provider: "claude",
    model: "opus",
    effort: "high",
    speed: null,
  }, presets)).toMatchObject({
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    speed: "fast",
  });
});

test("sans verrou, le modèle et la demande MCP restent libres", () => {
  const conversation = convs.create({
    projectId,
    provider: "claude",
    model: "sonnet",
    firstMessage: "délègue",
  });

  expect(effectiveSubtaskConfig(conversation, {
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "medium",
    speed: "fast",
  }, presets)).toEqual({
    provider: "codex",
    model: "gpt-5.6-terra",
    effort: "medium",
    speed: "fast",
  });
});
