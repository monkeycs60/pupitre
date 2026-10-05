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

test("renommer un chantier ne relance pas le classement des conversations en attente", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chantiers-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir);
  cleanup.push(() => db.close());
  const projects = new ProjectStore(db),
    conversations = new ConversationStore(db),
    tickets = new TicketStore(db);
  const project = projects.create({ name: "Test", path: dir });
  let calls = 0;
  const service = new ChantierService(db, projects, conversations, tickets, async () => {
    calls++;
    return { chantierId: null, new: null, confidence: 0.2 };
  });
  const existing = service.create(project.id, "Moteur Rust");
  const pending = conversations.create({ projectId: project.id, provider: "claude", model: "test", firstMessage: "Refaire la doc" });
  conversations.appendEvent(pending.id, { type: "user-message", text: "Refaire la doc", images: [] });

  await service.classify(pending.id);
  expect(calls).toBe(1);
  db.query("UPDATE tickets SET title='Moteur Rust v2' WHERE id=?").run(existing.id);
  await service.classify(pending.id);
  expect(calls).toBe(1);
  service.create(project.id, "Documentation");
  await service.classify(pending.id);
  expect(calls).toBe(2);
});

test("une conversation inclassable va dans Divers puis rejoint un vrai chantier quand il apparaît", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chantiers-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir);
  cleanup.push(() => db.close());
  const projects = new ProjectStore(db),
    conversations = new ConversationStore(db),
    tickets = new TicketStore(db);
  const project = projects.create({ name: "Test", path: dir });
  let target: string | null = null;
  const prompts: string[] = [];
  const service = new ChantierService(db, projects, conversations, tickets, async (prompt) => {
    prompts.push(prompt);
    return target
      ? { chantierId: target, new: null, confidence: 0.9 }
      : { chantierId: null, new: null, confidence: 0.1 };
  });
  const conversation = conversations.create({ projectId: project.id, provider: "claude", model: "test", firstMessage: "Petite question" });
  conversations.appendEvent(conversation.id, { type: "user-message", text: "Petite question", images: [] });

  expect(await service.classify(conversation.id)).toBe(true);
  const misc = tickets.get(conversations.get(conversation.id)!.ticket_id!)!;
  expect(misc).toEqual(expect.objectContaining({ title: "Divers" }));
  expect(misc.payload).toEqual(expect.objectContaining({ origin: "divers", titleSource: "manual" }));

  const real = service.create(project.id, "Facturation");
  target = real.id;
  expect(await service.classify(conversation.id)).toBe(true);
  expect(conversations.get(conversation.id)!.ticket_id).toBe(real.id);
  expect(prompts.at(-1)).not.toContain(misc.id);
  expect(service.list(project.id).filter((item) => item.title === "Divers")).toHaveLength(1);
});

function pendingFixture(generate: (prompt: string) => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "chantiers-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(dir);
  cleanup.push(() => db.close());
  const projects = new ProjectStore(db),
    conversations = new ConversationStore(db),
    tickets = new TicketStore(db);
  const project = projects.create({ name: "Test", path: dir });
  const service = new ChantierService(db, projects, conversations, tickets, generate);
  const conv = (text: string) => {
    const created = conversations.create({ projectId: project.id, provider: "claude", model: "test", firstMessage: text });
    conversations.appendEvent(created.id, { type: "user-message", text, images: [] });
    return created;
  };
  return { db, project, service, conv, conversations, tickets };
}

test("le modèle voit les thèmes en attente et une conversation proche crée le chantier avec eux", async () => {
  const prompts: string[] = [];
  let title = "Audit Match AI et trous de mesure";
  const f = pendingFixture(async (prompt) => {
    prompts.push(prompt);
    return { chantierId: null, new: { title, description: "" }, confidence: 0.9 };
  });
  const first = f.conv("Auditer la mesure Match AI");
  expect(await f.service.classify(first.id)).toBe(false);
  const second = f.conv("Profils Match AI incomplets");
  expect(await f.service.classify(second.id)).toBe(true);
  expect(prompts[1]).toContain("pendingThemes");
  expect(prompts[1]).toContain("Audit Match AI et trous de mesure");
  expect(f.conversations.get(first.id)!.ticket_id).toBe(f.conversations.get(second.id)!.ticket_id);
  title = "Autre sujet";
});

test("une conversation seule sur son sujet depuis 7 jours rejoint Divers", async () => {
  let n = 0;
  const f = pendingFixture(async () => ({ chantierId: null, new: { title: `Sujet isolé ${++n}`, description: "" }, confidence: 0.9 }));
  const old = f.conv("Ancienne tâche");
  const recent = f.conv("Tâche récente");
  await f.service.classify(old.id);
  await f.service.classify(recent.id);
  f.db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(new Date(Date.now() - 8 * 86400000).toISOString(), old.id);

  expect(f.service.parkStale(f.project.id)).toBe(1);
  expect(f.tickets.get(f.conversations.get(old.id)!.ticket_id!)!.title).toBe("Divers");
  expect(f.conversations.get(recent.id)!.ticket_id).toBeNull();
});

test("le regroupement unique crée les chantiers partagés et ne repasse pas", async () => {
  let ids: string[] = [];
  let calls = 0;
  const f = pendingFixture(async (prompt) => {
    if (!prompt.startsWith("Regroupe")) return { chantierId: null, new: { title: `Seul ${Math.random()}`, description: "" }, confidence: 0.9 };
    calls++;
    return { groups: [
      { title: "Stories Instagram", description: "Scraping", conversationIds: [ids[0], ids[1], "inconnue"] },
      { title: "Groupe trop petit", conversationIds: [ids[2]] },
    ] };
  });
  const convs = [f.conv("Extraction stories Instagram"), f.conv("API stories Instagram tierce"), f.conv("Reset mot de passe preprod")];
  ids = convs.map((item) => item.id);
  for (const item of convs) await f.service.classify(item.id);

  expect(await f.service.regroup(f.project.id)).toBe(1);
  const instagram = f.conversations.get(ids[0]!)!.ticket_id;
  expect(f.tickets.get(instagram!)!.title).toBe("Stories Instagram");
  expect(f.conversations.get(ids[1]!)!.ticket_id).toBe(instagram);
  expect(f.conversations.get(ids[2]!)!.ticket_id).toBeNull();
  expect(await f.service.regroup(f.project.id)).toBe(0);
  expect(calls).toBe(1);
});
