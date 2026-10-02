import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { defaultTicketKeysOfCommits } from "../src/integrations/refresher";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectStore } from "../src/stores/projects";
import { TRUNK_TICKETS_MIGRATION_KEY } from "../src/stores/settings";
import { TicketStore } from "../src/stores/tickets";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

function repositoryWithRemote(trunk: string): string {
  const root = mkdtempSync(join(tmpdir(), "pupitre-trunk-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "-b", trunk, remote);
  git(root, "clone", remote, work);
  git(work, "checkout", "-b", trunk);
  return work;
}

test("un commit poussé sur le tronc ne donne aucun ticket, même via origin/master ou une branche tirée après", () => {
  const work = repositoryWithRemote("master");
  const onTrunk = commit(work, "a.txt");
  git(work, "push", "-u", "origin", "master");
  git(work, "remote", "set-head", "origin", "master");
  git(work, "branch", "moteur-rust");
  git(work, "push", "origin", "moteur-rust");

  expect(defaultTicketKeysOfCommits(work, [onTrunk], null)).toEqual([]);
});

test("le tronc nommé par origin/HEAD compte comme branche de base", () => {
  const work = repositoryWithRemote("trunk");
  const onTrunk = commit(work, "a.txt");
  git(work, "push", "-u", "origin", "trunk");
  git(work, "remote", "set-head", "origin", "trunk");

  expect(defaultTicketKeysOfCommits(work, [onTrunk], null)).toEqual([]);
});

test("une branche de travail poussée donne une seule clé, sans préfixe distant", () => {
  const work = repositoryWithRemote("main");
  commit(work, "a.txt");
  git(work, "push", "-u", "origin", "main");
  git(work, "checkout", "-b", "chantier-rust");
  const onBranch = commit(work, "b.txt");
  git(work, "push", "-u", "origin", "chantier-rust");

  expect(defaultTicketKeysOfCommits(work, [onBranch], null)).toEqual(["chantier-rust"]);
});

test("avec un motif, une branche ticket fusionnée dans develop garde sa clé", () => {
  const work = repositoryWithRemote("develop");
  commit(work, "a.txt");
  git(work, "checkout", "-b", "feature/TECH-12");
  const onTicket = commit(work, "b.txt");
  git(work, "checkout", "develop");
  git(work, "merge", "--ff-only", "feature/TECH-12");
  git(work, "push", "origin", "develop", "feature/TECH-12");

  expect(defaultTicketKeysOfCommits(work, [onTicket], /^feature\/(TECH-\d+)/u)).toEqual(["TECH-12"]);
});

test("la migration détache les conversations des faux tickets du tronc", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-trunk-migration-"));
  const db = openDb(dir);
  const project = new ProjectStore(db).create({ name: "Helion", path: dir });
  const conversations = new ConversationStore(db);
  const tickets = new TicketStore(db);
  const trunk = tickets.upsert(project.id, { key: "origin/master", source: "git", title: "origin/master", status: "", externalUrl: null });
  tickets.upsertRef(trunk.id, { kind: "branch", ref: "origin/master", payload: { local: true } });
  const real = tickets.upsert(project.id, { key: "moteur-rust", source: "git", title: "moteur-rust", status: "", externalUrl: null });
  const onTrunk = conversations.create({ projectId: project.id, provider: "claude", model: "m", firstMessage: "x" });
  const onBranch = conversations.create({ projectId: project.id, provider: "claude", model: "m", firstMessage: "y" });
  tickets.linkConversation(onTrunk.id, trunk.id);
  tickets.linkConversation(onBranch.id, real.id);
  db.query("DELETE FROM settings WHERE key = ?").run(TRUNK_TICKETS_MIGRATION_KEY);
  db.close();

  const migrated = openDb(dir);
  const migratedTickets = new TicketStore(migrated);
  expect(migratedTickets.findByKey(project.id, "origin/master")).toBeNull();
  expect(migratedTickets.findByKey(project.id, "moteur-rust")).not.toBeNull();
  expect(new ConversationStore(migrated).get(onTrunk.id)?.ticket_id).toBeNull();
  expect(new ConversationStore(migrated).get(onBranch.id)?.ticket_id).toBe(real.id);
  expect(migrated.query("SELECT COUNT(*) AS n FROM ticket_refs WHERE ticket_id = ?").get(trunk.id)).toEqual({ n: 0 });
});
