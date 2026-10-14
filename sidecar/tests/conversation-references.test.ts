import { describe, expect, test } from "bun:test";
import {
  searchConversationReferences,
  withConversationMentions,
} from "../src/conversation-references";
import type { ConversationReference } from "../src/stores/conversations";

const references: ConversationReference[] = [
  { id: "c-2", project_id: "p-a", project_name: "affilae-mono", title: "Refonte du checkout v2", updated_at: "2026-10-14" },
  { id: "c-1", project_id: "p-a", project_name: "affilae-mono", title: "Refonte du checkout", updated_at: "2026-10-13" },
  { id: "c-3", project_id: "p-p", project_name: "pupitre", title: "Jauge de contexte", updated_at: "2026-10-12" },
];

describe("searchConversationReferences", () => {
  test("place le titre exact avant les titres qui le contiennent, sans tenir compte des accents", () => {
    expect(searchConversationReferences(references, "refonte du checkout").map((item) => item.id))
      .toEqual(["c-1", "c-2"]);
    expect(searchConversationReferences(references, "JAUGE").map((item) => item.id)).toEqual(["c-3"]);
  });

  test("rend les plus récentes quand la requête est vide", () => {
    expect(searchConversationReferences(references, " ", 2).map((item) => item.id)).toEqual(["c-2", "c-1"]);
  });
});

describe("withConversationMentions", () => {
  test("ajoute l'id et le projet de chaque conversation citée", () => {
    const prompt = withConversationMentions("Reprends @[Refonte du checkout] et @[Jauge de contexte].", () => references);
    expect(prompt).toContain("[Conversations Pupitre citées]");
    expect(prompt).toContain("« Refonte du checkout » (projet affilae-mono) : conversation_id `c-1`");
    expect(prompt).toContain("conversation_id `c-3`");
    expect(prompt).toContain("read_conversation");
  });

  test("signale un titre introuvable sans inventer d'id", () => {
    expect(withConversationMentions("Voir @[Inconnue]", () => references))
      .toContain("« Inconnue » : aucune conversation de ce titre");
  });

  test("laisse intact un message sans mention et ne charge pas les conversations", () => {
    let loaded = false;
    expect(withConversationMentions("Tableau [a] @browser", () => { loaded = true; return references })).toBe("Tableau [a] @browser");
    expect(loaded).toBe(false);
  });
});
