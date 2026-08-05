import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker } from "../src/quotas";
import { parseTestInventory, TesterRunner } from "../src/testing";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { ReviewStore } from "../src/stores/reviews";
import { TestingStore } from "../src/stores/testing";
import type { AppEvent, StoredEvent } from "../src/events";
import type { Subtask, SubtaskInput, SubtaskResult } from "../src/subtasks";
import { ConversationActivity } from "../src/conversation-activity";
import { MediaStore } from "../src/media";

let db: Database;
let projects: ProjectStore;
let conversations: ConversationStore;
let reviews: ReviewStore;
let conversationId: string;
let projectId: string;
let broadcasts: StoredEvent[];

class FakeSubtasks {
  resultText = '<test-result>{"verdict":"passed","summary":"12 tests passent."}</test-result>';
  lastInput: SubtaskInput | null = null;
  rejectsWait = false;
  writesScreenshot = false;
  beforeResult?: (id: string) => void;

  start(input: SubtaskInput): Subtask {
    this.lastInput = input;
    const now = new Date().toISOString();
    return {
      id: "test-subtask",
      conversation_id: input.conversationId,
      provider: input.provider,
      model: input.model,
      effort: input.effort ?? null,
      speed: input.speed ?? null,
      prompt: input.prompt,
      label: input.label ?? null,
      status: "running",
      created_at: now,
      updated_at: now,
    };
  }

  async waitResult(id: string): Promise<SubtaskResult> {
    if (this.rejectsWait) throw new Error("lecture subtask impossible");
    this.beforeResult?.(id);
    if (this.writesScreenshot) {
      const directory = this.lastInput?.prompt.match(
        /Enregistre chaque screenshot dans ce dossier[^:]*: (.+)$/m,
      )?.[1];
      if (!directory) throw new Error("dossier de captures absent du prompt");
      writeFileSync(join(directory, "parcours.png"), "fake-png");
    }
    const now = new Date().toISOString();
    return {
      status: "done",
      resultText: this.resultText,
      error: null,
      subtask: {
        id,
        conversation_id: conversationId,
        provider: "codex",
        model: "gpt-5.6-luna",
        effort: "low",
        speed: null,
        prompt: "test",
        label: "Test",
        status: "done",
        created_at: now,
        updated_at: now,
      },
    };
  }
}

beforeEach(() => {
  db = openDb(mkdtempSync(join(tmpdir(), "pupitre-testing-")));
  projects = new ProjectStore(db);
  conversations = new ConversationStore(db);
  reviews = new ReviewStore(db);
  projectId = projects.create({ name: "tests", path: tmpdir() }).id;
  conversationId = conversations.create({
    projectId,
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "low",
    firstMessage: "Ajoute une API critique",
  }).id;
  conversations.appendEvent(conversationId, {
    type: "text-final",
    text: "L'endpoint et ses tests unitaires sont implémentés.",
  });
  broadcasts = [];
});

function createTestingFlag(): string {
  const review = reviews.create({
    projectId,
    conversationId,
    gitRefBase: "HEAD^",
    gitRefHead: "HEAD",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  reviews.complete(review.id, [{
    file: "src/api.ts",
    line_start: 12,
    line_end: 18,
    severity: "orange",
    category: "absence de test sur code critique",
    message: "Ajoute un test du chemin d'erreur.",
  }]);
  return reviews.get(review.id)!.flags[0]!.id;
}

test("parse un inventaire structuré et filtre les ids Gardien inconnus", () => {
  const parsed = parseTestInventory(`\`\`\`json
  {"items":[{"title":"Endpoint API","description":"Vérifier le contrat", "methods":[
    {"kind":"unit","label":"Lancer bun test","instructions":"bun test tests/api.test.ts"}
  ],"guardian_flag_ids":["known","inventé"]}]}
  \`\`\``, new Set(["known"]));

  expect(parsed).toEqual([{
    title: "Endpoint API",
    description: "Vérifier le contrat",
    methods: [{ kind: "unit", label: "Lancer bun test", instructions: "bun test tests/api.test.ts" }],
    guardianFlagIds: ["known"],
  }]);
});

test("génère l'inventaire depuis la conversation et y injecte les alertes Gardien", async () => {
  const flagId = createTestingFlag();
  let prompt = "";
  const runner = new TesterRunner(
    new TestingStore(db),
    conversations,
    projects,
    reviews,
    new QuotaTracker(db),
    (_id, event) => broadcasts.push(event),
    {} as never,
    async (input) => {
      prompt = input.prompt;
      return JSON.stringify({ items: [{
        title: "Erreur API",
        description: "Couvrir le chemin critique",
        methods: [{ kind: "unit", label: "Test unitaire", instructions: "bun test" }],
        guardian_flag_ids: [flagId],
      }] });
    },
  );

  const inventory = await runner.inventory(conversationId);

  expect(prompt).toContain("L'endpoint et ses tests unitaires sont implémentés");
  expect(prompt).toContain(flagId);
  expect(inventory.scopes[0]).toMatchObject({
    title: "Erreur API",
    guardian_flag_ids: [flagId],
    status: "pending",
  });
  expect(broadcasts.at(-1)).toMatchObject({ type: "test-inventory-ref" });
});

test("exécute le scope en subtask, persiste les preuves et acquitte le flag testé", async () => {
  const flagId = createTestingFlag();
  const subtasks = new FakeSubtasks();
  subtasks.writesScreenshot = true;
  subtasks.beforeResult = (id) => {
    conversations.appendEvent(id, {
      type: "tool-end",
      toolId: "bun-test-a",
      output: `DÉBUT A\n${"a".repeat(45_000)}\nFIN DÉCISIVE A`,
      images: [],
    });
    conversations.appendEvent(id, {
      type: "tool-end",
      toolId: "bun-test-b",
      output: `DÉBUT B\n${"b".repeat(45_000)}\nFIN DÉCISIVE B`,
      images: [],
    });
  };
  const media = new MediaStore(mkdtempSync(join(tmpdir(), "pupitre-testing-media-")));
  const store = new TestingStore(db);
  const runner = new TesterRunner(
    store,
    conversations,
    projects,
    reviews,
    new QuotaTracker(db),
    (_id, event) => broadcasts.push(event),
    subtasks,
    async () => JSON.stringify({ items: [{
      title: "API critique",
      description: "Vérifier le chemin d'erreur",
      methods: [{ kind: "unit", label: "bun test", instructions: "bun test" }],
      guardian_flag_ids: [flagId],
    }] }),
    new ConversationActivity(),
    media,
  );
  const inventory = await runner.inventory(conversationId);

  const started = runner.startScope(inventory.scopes[0]!.id);
  await runner.wait(started.id);

  expect(subtasks.lastInput).toMatchObject({
    conversationId,
    label: "Test · API critique",
  });
  expect(store.getScope(started.id)).toMatchObject({
    status: "passed",
    evidence_md: expect.stringContaining("12 tests passent"),
    images: [expect.stringMatching(/\.png$/)],
  });
  expect(store.getScope(started.id)?.evidence_md).toContain("FIN DÉCISIVE A");
  expect(store.getScope(started.id)?.evidence_md).toContain("FIN DÉCISIVE B");
  expect(existsSync(media.absolutePath(store.getScope(started.id)!.images[0]!))).toBe(true);
  expect(reviews.getFlag(flagId)?.status).toBe("acked");
  expect(broadcasts.some((event) => event.type === "test-scope-result")).toBe(true);
});

test("un verdict en échec conserve le flag Gardien ouvert", async () => {
  const flagId = createTestingFlag();
  const subtasks = new FakeSubtasks();
  subtasks.resultText = '<test-result>{"verdict":"failed","summary":"1 test échoue."}</test-result>';
  const runner = new TesterRunner(
    new TestingStore(db), conversations, projects, reviews, new QuotaTracker(db),
    () => {}, subtasks,
    async () => JSON.stringify({ items: [{
      title: "API", description: "Test", methods: [
        { kind: "unit", label: "bun test", instructions: "bun test" },
      ], guardian_flag_ids: [flagId],
    }] }),
  );
  const inventory = await runner.inventory(conversationId);

  const started = runner.startScope(inventory.scopes[0]!.id);
  await runner.wait(started.id);

  expect(reviews.getFlag(flagId)?.status).toBe("open");
});

test("un redémarrage clôt un scope running avec un résultat inline", () => {
  const store = new TestingStore(db);
  const inventory = store.createWithReference({
    conversationId,
    eventIdFrom: 1,
    eventIdTo: 1,
    scopes: [{
      title: "API",
      description: "Test",
      methods: [{ kind: "unit", label: "bun test", instructions: "bun test" }],
      guardianFlagIds: [],
    }],
  }).inventory;
  const scope = store.reserveScope(inventory.scopes[0]!.id)!;
  store.attachSubtask(scope.id, "subtask-interrompue");

  const restarted = new TestingStore(db);

  expect(restarted.getScope(scope.id)).toMatchObject({
    status: "failed",
    error: "interrompu (sidecar redémarré)",
  });
  expect(conversations.listEvents(conversationId).at(-1)).toMatchObject({
    type: "test-scope-result",
    scopeId: scope.id,
    status: "failed",
  });
});

test("une erreur d'attente termine le scope au lieu de le laisser running", async () => {
  const subtasks = new FakeSubtasks();
  subtasks.rejectsWait = true;
  const runner = new TesterRunner(
    new TestingStore(db), conversations, projects, reviews, new QuotaTracker(db),
    () => {}, subtasks,
    async () => JSON.stringify({ items: [{
      title: "API", description: "Test", methods: [
        { kind: "unit", label: "bun test", instructions: "bun test" },
      ], guardian_flag_ids: [],
    }] }),
  );
  const inventory = await runner.inventory(conversationId);

  const started = runner.startScope(inventory.scopes[0]!.id);
  await runner.wait(started.id);

  expect(runner.getScope(started.id)).toMatchObject({
    status: "failed",
    error: "lecture subtask impossible",
  });
});

test("refuse de lancer un scope pendant une autre activité de conversation", async () => {
  const activity = new ConversationActivity();
  const runner = new TesterRunner(
    new TestingStore(db), conversations, projects, reviews, new QuotaTracker(db),
    () => {}, new FakeSubtasks(),
    async () => JSON.stringify({ items: [{
      title: "API", description: "Test", methods: [
        { kind: "unit", label: "bun test", instructions: "bun test" },
      ], guardian_flag_ids: [],
    }] }),
    activity,
  );
  const inventory = await runner.inventory(conversationId);
  const release = activity.acquire(conversationId, "turn");

  expect(() => runner.startScope(inventory.scopes[0]!.id))
    .toThrow("une opération est déjà en cours");
  expect(runner.getScope(inventory.scopes[0]!.id)?.status).toBe("pending");
  release();
});
