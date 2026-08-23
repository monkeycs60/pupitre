import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { buildDigestPrompt, parseDigestPayload, shouldRefreshDigest } from "../src/conversation-digest";

let conversations: ConversationStore;
let projectId: string;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-digest-")));
  conversations = new ConversationStore(db);
  projectId = new ProjectStore(db).create({ name: "p", path: "/tmp" }).id;
});

function newConversation() {
  return conversations.create({
    projectId,
    provider: "claude",
    model: "claude-opus-5",
    firstMessage: "Corrige le rendu des tableaux Markdown dans le chat",
  });
}

test("génère un digest au premier tour puis par paliers", () => {
  expect(shouldRefreshDigest(1, 0)).toBe(true);
  expect(shouldRefreshDigest(2, 1)).toBe(false);
  expect(shouldRefreshDigest(5, 1)).toBe(true);
  // Au-delà de 12 tours, le palier s'élargit : le titre bouge peu, le coût reste bas.
  expect(shouldRefreshDigest(16, 13)).toBe(false);
  expect(shouldRefreshDigest(25, 13)).toBe(true);
  expect(shouldRefreshDigest(0, 0)).toBe(false);
});

test("le digest remplace titre et résumé heuristiques", () => {
  const conv = newConversation();
  expect(conv.title_locked).toBe(false);
  const updated = conversations.updateDigest(
    conv.id,
    { title: "Fix des tableaux Markdown", summary: "Les tableaux GFM ne sont pas rendus." },
    3,
  );
  expect(updated?.title).toBe("Fix des tableaux Markdown");
  expect(updated?.summary).toBe("Les tableaux GFM ne sont pas rendus.");
  expect(updated?.digest_turn).toBe(3);
});

test("un renommage manuel fige le titre contre la régénération", () => {
  const conv = newConversation();
  expect(conversations.rename(conv.id, "Mon titre")?.title_locked).toBe(true);
  conversations.updateDigest(conv.id, { title: "Titre auto", summary: "Résumé auto" }, 4);
  expect(conversations.get(conv.id)?.title).toBe("Mon titre");
});

test("compte les tours et extrait la matière du digest", () => {
  const conv = newConversation();
  expect(conversations.turnCount(conv.id)).toBe(0);
  conversations.appendEvent(conv.id, {
    type: "user-message",
    text: "Corrige le rendu des tableaux Markdown dans le chat",
    images: [],
  });
  conversations.appendEvent(conv.id, { type: "text-final", text: "Il manque remark-gfm." });
  conversations.appendEvent(conv.id, { type: "usage", inputTokens: 10, outputTokens: 5 });
  expect(conversations.turnCount(conv.id)).toBe(1);
  const source = conversations.digestSource(conv.id);
  expect(source.first).toContain("Utilisateur : Corrige le rendu");
  expect(source.latest.at(-1)).toBe("Agent : Il manque remark-gfm.");
});

test("le digest accepte 0 à 2 domaines et ignore le reste", () => {
  expect(parseDigestPayload({
    title: "Fix des tableaux Markdown",
    summary: "Les tableaux GFM ne sont pas rendus.",
  })).toEqual({
    title: "Fix des tableaux Markdown",
    summary: "Les tableaux GFM ne sont pas rendus.",
    domains: [],
  });
  expect(parseDigestPayload({
    title: "Matching",
    summary: "On vectorise les profils.",
    domains: [
      { name: "Match AI", kind: "métier" },
      { name: "API", kind: "technique" },
      { name: "Trop", kind: "technique" },
      { name: "", kind: "métier" },
      { kind: "technique" },
    ],
  })?.domains).toEqual([
    { name: "Match AI", kind: "métier" },
    { name: "API", kind: "technique" },
  ]);
  expect(parseDigestPayload({
    title: "Auth",
    summary: "Login cassé.",
    domains: [{ name: "Auth", kind: "inconnu" }],
  })?.domains).toEqual([{ name: "Auth", kind: "technique" }]);
  expect(parseDigestPayload({ title: "", summary: "x" })).toBeNull();
});

test("le prompt du digest liste le catalogue existant sans tour supplémentaire", () => {
  const prompt = buildDigestPrompt({
    first: "Corrige le matching",
    latest: ["Agent : on vectorise."],
    domainCatalog: [
      { name: "Match AI", kind: "métier", status: "actif" },
      { name: "Wishlists", kind: "métier", status: "proposé" },
    ],
  });
  expect(prompt).toContain('"domains"');
  expect(prompt).toContain("Match AI (métier, actif)");
  expect(prompt).toContain("Wishlists (métier, proposé)");
  expect(prompt).toContain("1 ou 2 domaines");
});
