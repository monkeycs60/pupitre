import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { TicketStore } from "../src/stores/tickets";
import { TodoStore } from "../src/stores/todos";
import { ChantierService, chantierDecision } from "../src/chantiers";
const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "chantiers-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir);
  cleanup.push(() => db.close());
  const projects = new ProjectStore(db),
    conversations = new ConversationStore(db),
    tickets = new TicketStore(db);
  const project = projects.create({ name: "Test", path: dir });
  const service = new ChantierService(
    db,
    projects,
    conversations,
    tickets,
    async () => ({
      chantierId: null,
      new: { title: "Moteur Rust", description: "Migration" },
      confidence: 0.8,
    }),
  );
  const conv = () =>
    conversations.create({
      projectId: project.id,
      provider: "claude",
      model: "test",
      firstMessage: "Migrer le moteur",
    });
  return { db, project, service, conv, tickets, conversations };
}
test("fermeture, réouverture, verrouillage et priorité au ticket externe", () => {
  const { db, project, service, conv, tickets, conversations } = fixture();
  const a = service.create(project.id, "Moteur Rust"),
    b = service.create(project.id, "Interface web");
  const c = conv();
  service.assign(c.id, a.id, true);
  expect(service.assign(c.id, b.id)).toBe(false);
  expect(conversations.get(c.id)?.ticket_id).toBe(a.id);
  db.query("UPDATE conversations SET updated_at='2020-01-01' WHERE id=?").run(
    c.id,
  );
  expect(service.closeIdle()).toBe(1);
  service.assign(c.id, a.id, true);
  expect(tickets.get(a.id)?.archived_at).toBeNull();
  const external = tickets.upsert(project.id, {
    key: "TECH-12",
    source: "clickup",
    title: "Externe",
    status: "",
    externalUrl: null,
  });
  const other = conv();
  tickets.linkConversation(other.id, external.id);
  expect(service.assign(other.id, a.id)).toBe(false);
  db.query("UPDATE tickets SET last_seen_at='2020-01-01' WHERE id=?").run(a.id);
  tickets.archiveStale(project.id);
  expect(tickets.get(a.id)?.archived_at).toBeNull();
});
test("fusion conserve conversations, notes, consignes et backlog", () => {
  const { db, project, service, conv, tickets, conversations } = fixture();
  const a = service.create(project.id, "Moteur Rust"),
    b = service.create(project.id, "Serveur Rust");
  const c = conv();
  service.assign(c.id, a.id, true);
  tickets.setInstruction(a.id, "Tester");
  const todos = new TodoStore(db);
  const todo = todos.create(project.id, {
    message: "Finir",
    provider: "claude",
    model: "test",
    ticketId: a.id,
    status: "backlog",
  });
  service.merge(a.id, b.id);
  expect(tickets.get(a.id)).toBeNull();
  expect(conversations.get(c.id)?.ticket_id).toBe(b.id);
  expect(todos.get(todo.id)?.ticket_id).toBe(b.id);
  expect(tickets.get(b.id)?.instruction).toBe("Tester");
  expect(() => service.merge(b.id, b.id)).toThrow("invalide");
});
test("valide les décisions du modèle et refuse les confiances hors limites", () => {
  expect(
    chantierDecision({ chantierId: null, new: null, confidence: 2 }),
  ).toBeNull();
  expect(
    chantierDecision({ chantierId: "abc", new: null, confidence: 0.5 })
      ?.confidence,
  ).toBe(0.5);
});
test("sur le tronc deux conversations sont nécessaires et le scan ne répète pas le modèle", async () => {
  const { project, service, conv, conversations } = fixture();
  const a = conv(),
    b = conv();
  conversations.appendEvent(a.id, {
    type: "user-message",
    text: "Moteur Rust",
    images: [],
  });
  conversations.appendEvent(b.id, {
    type: "user-message",
    text: "Moteur Rust",
    images: [],
  });
  expect(await service.classify(a.id)).toBe(false);
  expect(service.list(project.id)).toHaveLength(0);
  expect(await service.classify(a.id)).toBe(false);
  expect(await service.classify(b.id)).toBe(true);
  expect(service.list(project.id)).toHaveLength(1);
  expect(conversations.get(a.id)?.ticket_id).toBe(
    conversations.get(b.id)?.ticket_id,
  );
});

test("un message rouvre un chantier verrouillé et une fusion ne recycle pas ses numéros", () => {
  const { project, service, conv, conversations, tickets } = fixture();
  const first = service.create(project.id, "Premier chantier");
  const second = service.create(project.id, "Second chantier");
  const c = conv();
  service.assign(c.id, first.id, true);
  service.edit(first.id, { closed: true });
  conversations.appendEvent(c.id, {
    type: "user-message",
    text: "Reprendre",
    images: [],
  });
  expect(tickets.get(first.id)?.archived_at).toBeNull();
  expect(conversations.get(c.id)?.ticket_locked).toBe(1);
  service.merge(second.id, first.id);
  expect(service.create(project.id, "Troisième chantier").key).toBe("CH-3");
});
test("la vue d’ensemble compte les conversations et annonce la fermeture", () => {
  const { db, project, service, conv } = fixture();
  const a = service.create(project.id, "Moteur Rust");
  const c1 = conv(),
    c2 = conv();
  service.assign(c1.id, a.id, true);
  service.assign(c2.id, a.id, true);
  db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(
    "2030-01-01T00:00:00.000Z",
    c1.id,
  );
  db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(
    "2030-01-03T00:00:00.000Z",
    c2.id,
  );
  db.query("INSERT OR REPLACE INTO settings VALUES ('chantierIdleDays','7')").run();
  const [item] = service.overview(
    project.id,
    Date.parse("2030-01-04T00:00:00.000Z"),
  );
  expect(item!.conversation_count).toBe(2);
  expect(item!.last_activity_at).toBe("2030-01-03T00:00:00.000Z");
  expect(item!.closes_at).toBe("2030-01-10T00:00:00.000Z");
  service.edit(a.id, { closed: true });
  expect(service.overview(project.id)[0]!.closes_at).toBeNull();
});
test("renomme une seule fois les chantiers générés et épargne les noms édités à la main", async () => {
  const { db, project, tickets, conversations } = fixture();
  const prompts: string[] = [];
  const service = new ChantierService(
    db,
    new ProjectStore(db),
    conversations,
    tickets,
    async (prompt) => {
      prompts.push(prompt);
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return {
        titles: [
          ...ids.map((id) => ({ id, title: "Alertes Telegram des annonces." })),
          { id: "inconnu", title: "Chantier fantôme ajouté" },
        ],
      };
    },
  );
  const generic = service.create(project.id, "Améliorations UI et interactions", "", "llm");
  const manual = service.create(project.id, "Nom choisi");
  service.edit(manual.id, { title: "Nom choisi à la main" });
  expect(await service.retitle(project.id)).toBe(1);
  expect(tickets.get(generic.id)?.title).toBe("Alertes Telegram des annonces");
  expect(tickets.get(manual.id)?.title).toBe("Nom choisi à la main");
  expect(prompts[0]).toContain("la précision passe avant la brièveté");
  expect(prompts[0]).not.toContain(manual.id);
  expect(await service.retitle(project.id)).toBe(0);
  expect(prompts).toHaveLength(1);
});
test("propose un nom pour un seul chantier sans l'enregistrer", async () => {
  const { db, project, tickets, conversations } = fixture();
  const prompts: string[] = [];
  const service = new ChantierService(db, new ProjectStore(db), conversations, tickets, async () => null, async (prompt) => {
    prompts.push(prompt);
    const id = prompt.match(/"id":"([^"]+)"/)![1];
    return { titles: [{ id, title: "Installation Pupitre sur Mac" }] };
  });
  const item = service.create(project.id, "Setup et configuration", "", "llm");
  const response = await service.handle(
    new Request(`http://x/api/projects/${project.id}/chantiers/${item.id}`, { method: "PUT", body: JSON.stringify({ suggestTitle: true }) }),
    `/api/projects/${project.id}/chantiers/${item.id}`,
  );
  expect(await response!.json()).toEqual({ title: "Installation Pupitre sur Mac" });
  expect(tickets.get(item.id)?.title).toBe("Setup et configuration");
  expect(prompts[0]).toContain("Setup et configuration");
});
test("propose un nouveau nom quand le sujet dérive, puis l'applique ou l'oublie sur validation", async () => {
  const { db, project, tickets, conversations } = fixture();
  let answer: unknown = { drifted: false };
  let calls = 0;
  const service = new ChantierService(db, new ProjectStore(db), conversations, tickets, async () => null, async (prompt) => {
    calls++;
    const id = prompt.match(/"id":"([^"]+)"/)![1];
    return typeof answer === "function" ? (answer as (id: string) => unknown)(id) : answer;
  });
  const item = service.create(project.id, "Setup et configuration", "", "llm");
  const add = () => service.assign(conversations.create({ projectId: project.id, provider: "claude", model: "test", firstMessage: "x" }).id, item.id, true);
  const put = (body: unknown) => service.handle(
    new Request(`http://x/api/projects/${project.id}/chantiers/${item.id}`, { method: "PUT", body: JSON.stringify(body) }),
    `/api/projects/${project.id}/chantiers/${item.id}`,
  );
  add();
  expect(await service.reviewTitleDrift(item.id)).toBe(false);
  add(); add();
  expect(await service.reviewTitleDrift(item.id)).toBe(false);
  expect(calls).toBe(0);
  add();
  expect(await service.reviewTitleDrift(item.id)).toBe(false);
  expect(calls).toBe(1);
  answer = (id: string) => ({ drifted: true, titles: [{ id, title: "Installation Pupitre sur Mac" }] });
  add(); add(); add();
  expect(await service.reviewTitleDrift(item.id)).toBe(true);
  expect(conversations.listByProject(project.id)[0]?.ticket_title_proposal).toBe("Installation Pupitre sur Mac");
  add(); add(); add();
  expect(await service.reviewTitleDrift(item.id)).toBe(false);
  expect(calls).toBe(2);
  await put({ titleProposal: "accept" });
  expect(tickets.get(item.id)?.title).toBe("Installation Pupitre sur Mac");
  expect(tickets.get(item.id)?.payload.titleProposal).toBeNull();
  answer = (id: string) => ({ drifted: true, titles: [{ id, title: "Autre sujet du chantier" }] });
  expect(await service.reviewTitleDrift(item.id)).toBe(false);
  add(); add(); add();
  expect(await service.reviewTitleDrift(item.id)).toBe(true);
  await put({ titleProposal: "dismiss" });
  expect(tickets.get(item.id)?.title).toBe("Installation Pupitre sur Mac");
  expect(conversations.listByProject(project.id)[0]?.ticket_title_proposal).toBeNull();
});
