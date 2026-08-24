import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ConversationStore } from "../src/stores/conversations";
import {
  DomainConflictError,
  DomainProtectedError,
  DomainStore,
  suggestionsFromLabels,
} from "../src/stores/domains";
import { ProjectStore } from "../src/stores/projects";

let domains: DomainStore;
let conversations: ConversationStore;
let projectId: string;
let otherProjectId: string;

beforeEach(() => {
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-domains-")));
  const projects = new ProjectStore(db);
  projectId = projects.create({ name: "mono", path: "/tmp/mono" }).id;
  otherProjectId = projects.create({ name: "autre", path: "/tmp/autre" }).id;
  conversations = new ConversationStore(db);
  domains = new DomainStore(db);
});

function conversation(project = projectId) {
  return conversations.create({
    projectId: project,
    provider: "claude",
    model: "m",
    firstMessage: "x",
  });
}

test("crée un domaine et refuse un doublon insensible à la casse", () => {
  const created = domains.create(projectId, { name: "  Match   AI ", kind: "métier", status: "actif" });
  expect(created).toEqual(expect.objectContaining({
    name: "Match AI",
    kind: "métier",
    status: "actif",
    project_id: projectId,
  }));
  expect(() => domains.create(projectId, { name: "match ai", kind: "métier", status: "proposé" }))
    .toThrow(DomainConflictError);
  expect(domains.create(otherProjectId, { name: "Match AI", kind: "métier", status: "actif" }).project_id)
    .toBe(otherProjectId);
});

test("proposeMany n'écrase jamais un domaine déjà actif", () => {
  const active = domains.create(projectId, { name: "API", kind: "technique", status: "actif" });
  const proposed = domains.proposeMany(projectId, [
    { name: "API", kind: "métier" },
    { name: "BackOffice", kind: "technique" },
  ]);
  expect(proposed.map((domain) => domain.name).sort()).toEqual(["API", "BackOffice"]);
  expect(domains.get(active.id)?.status).toBe("actif");
  expect(domains.get(active.id)?.kind).toBe("technique");
  expect(domains.listByProject(projectId).find((domain) => domain.name === "BackOffice")?.status).toBe("proposé");
});

test("une suggestion auto n'apparaît pas tant que le domaine n'est pas validé", () => {
  const conv = conversation();
  const applied = domains.applyDigestSuggestions(conv.id, projectId, [
    { name: "Match AI", kind: "métier" },
    { name: "API", kind: "technique" },
    { name: "Ignoré", kind: "technique" },
  ]);
  expect(applied).toHaveLength(2);
  expect(domains.forConversation(conv.id, { visibleOnly: true })).toEqual([]);
  expect(domains.forConversation(conv.id).map((domain) => domain.status).sort()).toEqual(["proposé", "proposé"]);

  const match = domains.findByName(projectId, "Match AI")!;
  domains.validate(match.id);
  expect(domains.forConversation(conv.id, { visibleOnly: true }).map((domain) => domain.name)).toEqual(["Match AI"]);
});

test("un domaine déjà actif s'associe automatiquement", () => {
  domains.create(projectId, { name: "API", kind: "technique", status: "actif" });
  const conv = conversation();
  domains.applyDigestSuggestions(conv.id, projectId, [{ name: "API", kind: "technique" }]);
  expect(domains.forConversation(conv.id, { visibleOnly: true })).toEqual([
    expect.objectContaining({ name: "API", origin: "auto" }),
  ]);
});

test("une conversation peut porter plusieurs domaines et un domaine plusieurs conversations", () => {
  const api = domains.create(projectId, { name: "API", kind: "technique", status: "actif" });
  const match = domains.create(projectId, { name: "Match AI", kind: "métier", status: "actif" });
  const first = conversation();
  const second = conversation();
  domains.associate(first.id, api.id, "manuel");
  domains.associate(first.id, match.id, "manuel");
  domains.associate(second.id, api.id, "auto");
  expect(domains.forConversation(first.id, { visibleOnly: true }).map((domain) => domain.name).sort())
    .toEqual(["API", "Match AI"]);
  expect(domains.conversationIdsFor(api.id).sort()).toEqual([first.id, second.id].sort());
});

test("le renommage conserve l'id et les associations", () => {
  const domain = domains.create(projectId, { name: "API", kind: "technique", status: "actif" });
  const conv = conversation();
  domains.associate(conv.id, domain.id, "manuel");
  const renamed = domains.rename(domain.id, { name: "Public API", kind: "technique" });
  expect(renamed.id).toBe(domain.id);
  expect(renamed.name).toBe("Public API");
  expect(domains.forConversation(conv.id, { visibleOnly: true })[0]?.id).toBe(domain.id);
});

test("la fusion reporte les associations vers la cible sans doublon", () => {
  const target = domains.create(projectId, { name: "Match AI", kind: "métier", status: "actif" });
  const source = domains.create(projectId, { name: "Matching", kind: "métier", status: "proposé" });
  const shared = conversation();
  const onlySource = conversation();
  domains.associate(shared.id, target.id, "manuel");
  domains.associate(shared.id, source.id, "auto");
  domains.associate(onlySource.id, source.id, "auto");
  domains.merge(source.id, target.id);
  expect(domains.get(source.id)).toBeNull();
  expect(domains.forConversation(shared.id).map((domain) => domain.id)).toEqual([target.id]);
  expect(domains.forConversation(shared.id)[0]?.origin).toBe("manuel");
  expect(domains.forConversation(onlySource.id).map((domain) => domain.id)).toEqual([target.id]);
  expect(domains.conversationIdsFor(target.id).sort()).toEqual([onlySource.id, shared.id].sort());
});

test("une proposition se supprime avec ses associations automatiques", () => {
  const domain = domains.create(projectId, { name: "API", kind: "technique", status: "proposé" });
  const conv = conversation();
  domains.associate(conv.id, domain.id, "auto");
  expect(domains.remove(domain.id)).toBe(true);
  expect(domains.get(domain.id)).toBeNull();
  expect(domains.forConversation(conv.id)).toEqual([]);
});

test("la suppression d'un domaine actif associé reste refusée", () => {
  const domain = domains.create(projectId, { name: "API", kind: "technique", status: "actif" });
  const conv = conversation();
  domains.associate(conv.id, domain.id, "manuel");
  expect(() => domains.remove(domain.id)).toThrow(DomainProtectedError);
  domains.dissociate(conv.id, domain.id);
  expect(domains.remove(domain.id)).toBe(true);
});

test("les labels ClickUp structurels ne deviennent pas des domaines", () => {
  expect(suggestionsFromLabels([
    "API",
    "BackOffice",
    "Feeds",
    "Marketplace",
    "Trend Radar",
    "Match AI",
    "Analytics",
    "match ai",
  ], ["Match AI", "Analytics"])).toEqual([
    { name: "Match AI", kind: "métier" },
    { name: "Analytics", kind: "technique" },
  ]);
});

test("les conversations sans domaine restent listables", () => {
  const conv = conversation();
  domains.applyDigestSuggestions(conv.id, projectId, [{ name: "Nouveau sujet", kind: "métier" }]);
  expect(domains.forConversation(conv.id, { visibleOnly: true })).toEqual([]);
  expect(domains.decorateConversations(conversations.listByProject(projectId))[0]).toEqual(
    expect.objectContaining({ id: conv.id, domains: [], proposed_domain_count: 1 }),
  );
});
