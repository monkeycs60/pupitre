import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { SearchIndex } from "../src/search";
import {
  EMBEDDING_DIMENSIONS,
  SemanticSearch,
  SemanticSearchUnavailable,
  conversationChunks,
  semanticDatabaseUrl,
} from "../src/semantic-search";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";

const TEST_DATABASE_URL = semanticDatabaseUrl("dev", { PUPITRE_SEMANTIC_DB_URL: process.env.PUPITRE_SEMANTIC_TEST_DB_URL ?? "postgres://postgres:pupitre@127.0.0.1:5435/pupitre_test_suite" });

async function pgvectorReachable(): Promise<boolean> {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/postgres";
  const sql = new SQL({ url: url.toString(), connectionTimeout: 2 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => {});
  }
}

const pgvector = await pgvectorReachable();

test("chaque morceau rappelle le titre et l'en-tête reste dans le premier", () => {
  const chunks = conversationChunks({
    title: "Migration pgvector",
    summary: "Brancher la recherche IA",
    ticket: "TECH-1 Recherche",
    branch: "feat/rag",
    messages: [
      { role: "user", text: "Ajoute une recherche IA sur les conversations" },
      { role: "agent", text: "x".repeat(5_000) },
    ],
    debriefs: ["Débrief final"],
  });
  expect(chunks[0]).toStartWith("Conversation : Migration pgvector\nRésumé : Brancher la recherche IA\nTicket : TECH-1 Recherche\nBranche : feat/rag");
  expect(chunks[0]).toContain("Utilisateur : Ajoute une recherche IA");
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk).toStartWith("Conversation : Migration pgvector");
    expect(chunk.length).toBeLessThanOrEqual(2_400 + "Conversation : Migration pgvector\n\n".length);
  }
  expect(chunks.at(-1)).toContain("Débrief : Débrief final");
});

test("l'URL pgvector sépare les bases stable et dev, et cède à la variable d'environnement", () => {
  expect(semanticDatabaseUrl("stable", {})).toEndWith(":5435/pupitre");
  expect(semanticDatabaseUrl("dev", {})).toEndWith(":5435/pupitre_dev");
  expect(semanticDatabaseUrl("dev", { PUPITRE_SEMANTIC_DB_URL: "postgres://x/y" })).toBe("postgres://x/y");
});

test("sans clé OpenAI la recherche IA se déclare indisponible", async () => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-semantic-")));
  const search = new SemanticSearch(db, new ConversationStore(db), () => ({ openai: null, cerebras: null }), TEST_DATABASE_URL);
  await expect(search.search("n'importe quoi", "projet")).rejects.toBeInstanceOf(SemanticSearchUnavailable);
});

/** Un axe par thème : la proximité des vecteurs dit le thème partagé, pas le hasard. */
function themeVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.001);
  const lower = text.toLowerCase();
  if (lower.includes("ornithorynque")) vector[0] = 1;
  if (lower.includes("facture")) vector[1] = 1;
  if (lower.includes("pipeline")) vector[2] = 1;
  return vector;
}

const searches: SemanticSearch[] = [];
afterAll(async () => {
  for (const search of searches) await search.close();
  if (!pgvector) return;
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = "/postgres";
  const admin = new SQL(url.toString());
  await admin.unsafe(`DROP DATABASE IF EXISTS "${new URL(TEST_DATABASE_URL).pathname.slice(1)}" WITH (FORCE)`);
  await admin.close();
});

test.skipIf(!pgvector)("indexe, retrouve par le sens, réindexe ce qui change et oublie la corbeille", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-semantic-"));
  const db = openDb(dir);
  new SearchIndex(db);
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const project = projects.create({ name: "RAG", path: dir });
  const animals = conversations.create({ projectId: project.id, provider: "claude", model: "opus", firstMessage: "Parle-moi de l'ornithorynque" });
  conversations.appendEvent(animals.id, { type: "text-final", text: "L'ornithorynque pond des œufs." });
  const billing = conversations.create({ projectId: project.id, provider: "claude", model: "opus", firstMessage: "Corrige la facture de juin" });
  conversations.appendEvent(billing.id, { type: "text-final", text: "La facture est corrigée." });

  const embedded: string[] = [];
  const reranks: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    if (url.includes("openai")) {
      embedded.push(...body.input);
      return Response.json({ data: body.input.map((text: string, index: number) => ({ index, embedding: themeVector(text) })) });
    }
    reranks.push(body.messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ results: [{ id: "c1", match: "forte", reason: "Elle parle de l'animal." }, { id: "c9", match: "forte", reason: "inventé" }] }) } }] });
  }) as typeof fetch;
  const search = new SemanticSearch(db, conversations, () => ({ openai: "sk-test", cerebras: "csk-test" }), TEST_DATABASE_URL, fakeFetch);
  searches.push(search);

  const first = await search.search("cet animal australien, l'ornithorynque", project.id);
  expect(first.reranked).toBe(true);
  expect(first.results.map((hit) => [hit.conversation.id, hit.reason])).toEqual([[animals.id, "Elle parle de l'animal."]]);
  expect(reranks[0]).toContain("Titre : Parle-moi de l'ornithorynque");
  const indexedTexts = embedded.length;

  expect(await search.sync(project.id)).toBe(0);
  conversations.appendEvent(billing.id, { type: "user-message", text: "Et le pipeline ?", images: [] });
  expect(await search.sync(project.id)).toBe(1);
  expect(embedded.length).toBeGreaterThan(indexedTexts);

  conversations.setDeleted(animals.id, true);
  await search.sync(project.id);
  const afterTrash = await search.search("ornithorynque", project.id);
  expect(afterTrash.results.map((hit) => hit.conversation.id)).not.toContain(animals.id);

  await search.close();
  await expect(search.search("ornithorynque", project.id)).rejects.toThrow(`Base pgvector injoignable sur ${new URL(TEST_DATABASE_URL).host}`);
});
