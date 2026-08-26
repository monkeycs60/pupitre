import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangelogConflictError, ChangelogService, parseProposal } from "../src/changelog";
import { openDb } from "../src/db";
import { GitProjectService } from "../src/git";
import { ChangelogStore } from "../src/stores/changelog";
import { ConversationStore } from "../src/stores/conversations";
import { DomainStore } from "../src/stores/domains";
import { ProjectStore } from "../src/stores/projects";

function setup(generator: import("../src/debriefs").DebriefGenerator = async (input) => input.prompt.includes("SKILL_MD_ACTUEL")
  ? "## État actuel\n\nLe domaine reflète les changements validés.\n\n## Changements récents\n\n- Mise à jour cataloguée."
  : "[]") {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-project-"));
  Bun.spawnSync(["git", "init", "-q", root]);
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-changelog-db-")));
  const projects = new ProjectStore(db);
  const conversations = new ConversationStore(db);
  const domains = new DomainStore(db);
  const project = projects.create({ name: "Test", path: root });
  const conversation = conversations.create({ projectId: project.id, provider: "codex", model: "gpt-test", firstMessage: "Travail" });
  const domain = domains.create(project.id, { name: "Tableau de bord", kind: "métier", status: "actif" });
  domains.associate(conversation.id, domain.id, "manuel");
  const store = new ChangelogStore(db);
  const service = new ChangelogService(store, conversations, projects, domains,
    new GitProjectService(db, projects), generator);
  return { db, root, project, conversation, domain, store, service };
}

test("propose avec Luna high et laisse les changements ambigus décochés", async () => {
  let generation: { provider: string; model: string; effort?: string; speed?: string } | null = null;
  const context = setup(async (input) => {
    generation = input;
    return JSON.stringify([
      { domainId: context.domain.id, groupKey: "ui", nature: "modification", title: "En-tête clarifié", description: "Les domaines sont visibles dans l’en-tête.", impact: "Le contexte reste lisible.", evidence: ["commit abc"], ambiguous: false },
      { domainId: context.domain.id, groupKey: "css", nature: "correction", title: "Espacement incertain", description: "Un fichier CSS préexistant a changé.", impact: "Attribution à confirmer.", evidence: ["ui.css"], ambiguous: true },
    ]);
  });
  const review = await context.service.propose(context.conversation.id, {
    id: "summary-1", conversation_id: context.conversation.id, event_id_from: 1,
    event_id_to: 4, content_md: "## Implémenté\n- Domaines visibles.", created_at: new Date().toISOString(),
  });
  expect(generation).toEqual(expect.objectContaining({ provider: "codex", model: "gpt-5.6-luna", effort: "high", speed: "fast" }));
  expect(review.changes.map((change) => change.selected)).toEqual([true, false]);
  expect(await context.service.propose(context.conversation.id, {
    id: "summary-1", conversation_id: context.conversation.id, event_id_from: 1,
    event_id_to: 4, content_md: "ignoré", created_at: review.createdAt,
  })).toEqual(review);
  context.db.close();
});

test("ne fournit au générateur que les commits liés et cités par le résumé", async () => {
  let prompt = "";
  const context = setup(async (input) => {
    prompt = input.prompt;
    return "[]";
  });
  writeFileSync(join(context.root, "feature.txt"), "session\n");
  Bun.spawnSync(["git", "-C", context.root, "add", "feature.txt"]);
  Bun.spawnSync(["git", "-C", context.root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "feat: changement de la session"]);
  const sessionSha = Bun.spawnSync(["git", "-C", context.root, "rev-parse", "HEAD"]).stdout.toString().trim();
  writeFileSync(join(context.root, "old.txt"), "ancien\n");
  Bun.spawnSync(["git", "-C", context.root, "add", "old.txt"]);
  Bun.spawnSync(["git", "-C", context.root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "feat: ancien changement sans rapport"]);
  const unrelatedSha = Bun.spawnSync(["git", "-C", context.root, "rev-parse", "HEAD"]).stdout.toString().trim();
  writeFileSync(join(context.root, "dirty.txt"), "sale\n");
  const git = new GitProjectService(context.db, new ProjectStore(context.db));
  git.recordCommitLinks(context.project.id, context.conversation.id, [sessionSha, unrelatedSha]);

  await context.service.propose(context.conversation.id, {
    id: "summary-sources", conversation_id: context.conversation.id, event_id_from: 1,
    event_id_to: 4, content_md: `## Implémenté\n- Commit \`${sessionSha.slice(0, 7)}\` créé.`, created_at: new Date().toISOString(),
  });

  expect(prompt).toContain(sessionSha);
  expect(prompt).not.toContain(unrelatedSha);
  expect(prompt).not.toContain("dirty.txt");
  expect(prompt).toContain("Une capacité transversale reçoit un seul domaine principal");
  context.db.close();
});

test("ne conserve qu'un domaine principal pour une capacité transversale", () => {
  const domains = [{ id: "contacts", name: "Contacts" }, { id: "notes", name: "Notes & souvenirs" }];
  const changes = parseProposal(JSON.stringify([
    { domainId: "contacts", groupKey: "undated-events", nature: "modification", title: "Les événements sans date deviennent visibles.", description: "Ils apparaissent dans la fiche contact.", impact: "Aucun événement n'est perdu.", evidence: ["commit abc"], ambiguous: false },
    { domainId: "notes", groupKey: "undated-events", nature: "modification", title: "Les événements sans date deviennent visibles.", description: "Ils apparaissent dans la timeline.", impact: "Aucun événement n'est perdu.", evidence: ["commit abc"], ambiguous: false },
  ]), domains);

  expect(changes).toHaveLength(1);
  expect(changes[0]?.domainId).toBe("contacts");
});

test("retrouve la dernière validation non publiée d'une conversation", () => {
  const context = setup();
  const first = context.store.create({ conversationId: context.conversation.id, summaryId: "summary-1", eventIdFrom: 1, eventIdTo: 2, changes: [] });
  const second = context.store.create({ conversationId: context.conversation.id, summaryId: "summary-2", eventIdFrom: 3, eventIdTo: 4, changes: [] });
  context.store.publish(second.id, []);
  expect(context.service.latestProposed(context.conversation.id)?.id).toBe(first.id);
  context.db.close();
});

test("publie immédiatement un catalogue et enrichit le skill sans doublon", async () => {
  const context = setup();
  const [change] = parseProposal(JSON.stringify([{ domainId: context.domain.id, groupKey: "domaines", nature: "ajout", title: "Domaines visibles", description: "Les domaines actifs apparaissent dans l’en-tête.", impact: "Le contexte produit est immédiatement visible.", evidence: ["commit f7641f4"], ambiguous: false }]), [{ id: context.domain.id, name: context.domain.name }]);
  const review = context.store.create({ conversationId: context.conversation.id, summaryId: "summary-1", eventIdFrom: 1, eventIdTo: 2, changes: [change!] });

  const published = await context.service.publish(review.id, [change!]);
  const changelogPath = join(context.root, ".claude/skills/tableau-de-bord/CHANGELOG.md");
  const skillPath = join(context.root, ".claude/skills/tableau-de-bord/SKILL.md");
  expect(published.files).toContain(changelogPath);
  expect(readFileSync(changelogPath, "utf8")).toContain("Domaines visibles");
  expect(readFileSync(skillPath, "utf8")).toContain("## État actuel");
  expect((await context.service.publish(review.id, [change!])).files).toEqual([]);
  expect(readFileSync(changelogPath, "utf8").match(/pupitre-change:/g)).toHaveLength(1);
  context.db.close();
});

test("refuse d’écraser un skill modifié humainement", async () => {
  const context = setup();
  const makeReview = (summaryId: string, title: string) => {
    const [change] = parseProposal(JSON.stringify([{ domainId: context.domain.id, nature: "ajout", title, description: "Description durable.", impact: "Impact durable.", evidence: [], ambiguous: false }]), [{ id: context.domain.id, name: context.domain.name }]);
    return { change: change!, review: context.store.create({ conversationId: context.conversation.id, summaryId, eventIdFrom: 1, eventIdTo: 2, changes: [change!] }) };
  };
  const first = makeReview("summary-1", "Premier changement");
  await context.service.publish(first.review.id, [first.change]);
  const skillPath = join(context.root, ".claude/skills/tableau-de-bord/SKILL.md");
  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\nInstruction humaine.\n`);
  const second = makeReview("summary-2", "Second changement");
  await expect(context.service.publish(second.review.id, [second.change])).rejects.toThrow(ChangelogConflictError);
  expect(readFileSync(skillPath, "utf8")).toContain("Instruction humaine");
  context.db.close();
});
