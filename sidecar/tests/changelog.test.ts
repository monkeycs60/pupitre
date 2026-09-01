import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANGELOG_BACKFILL_CONCURRENCY,
  CHANGELOG_BACKFILL_VERSION,
  CHANGELOG_BATCH_SIZE,
  CHANGELOG_ENRICHMENT_ATTEMPTS,
  CHANGELOG_REFRESH_INTERVAL_MS,
  ChangelogService,
  parseEnrichments,
  discoverGitRepositories,
  readGitHistory,
} from "../src/changelog";
import { openDb } from "../src/db";
import { ChangelogStore, type GitChangelogCommit } from "../src/stores/changelog";
import { DomainStore } from "../src/stores/domains";
import { ProjectStore } from "../src/stores/projects";

function setup(options: {
  commits?: GitChangelogCommit[];
  generator?: import("../src/debriefs").DebriefGenerator;
  history?: ConstructorParameters<typeof ChangelogService>[4];
  repositories?: ConstructorParameters<typeof ChangelogService>[6];
  email?: ConstructorParameters<typeof ChangelogService>[7];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-project-"));
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-changelog-db-")));
  const projects = new ProjectStore(db);
  const domains = new DomainStore(db);
  const project = projects.create({ name: "Test", path: root });
  const domain = domains.create(project.id, { name: "Contacts", kind: "métier", status: "actif" });
  const commits = options.commits ?? [];
  const generator = options.generator ?? (async (input) => {
    const batch = JSON.parse(input.prompt.split("COMMITS: ")[1]!) as Array<{
      repositoryPath: string;
      sha: string;
    }>;
    return JSON.stringify(batch.map(({ repositoryPath, sha }) => ({
      repositoryPath,
      sha,
      domainId: domain.id,
      productMessage: `Résultat produit pour ${sha}.`,
    })));
  });
  const now = new Date("2026-08-27T10:00:00.000Z");
  const store = new ChangelogStore(db);
  const service = new ChangelogService(
    store,
    projects,
    domains,
    generator,
    options.history ?? (async () => commits),
    () => new Date(now),
    options.repositories ?? (async () => [{ path: root, relativePath: "." }]),
    options.email ?? (async () => "test@example.com"),
  );
  return { db, root, project, projects, domain, store, service, now };
}

function commits(count: number): GitChangelogCommit[] {
  return Array.from({ length: count }, (_, index) => ({
    repositoryPath: ".",
    sha: String(index + 1).padStart(40, "0"),
    branch: index % 2 === 0 ? "main" : "feature/contacts",
    subject: `feat: changement ${index + 1}`,
    committedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  }));
}

test("importe et enrichit tout le backfill par lots de dix avec Luna medium standard", async () => {
  const generations: import("../src/debriefs").DebriefGenerationInput[] = [];
  const history = commits(12);
  const context = setup({
    commits: history,
    generator: async (input) => {
      generations.push(input);
      const batch = JSON.parse(input.prompt.split("COMMITS: ")[1]!) as Array<{ sha: string }>;
      return JSON.stringify(batch.map(({ sha }) => ({
        repositoryPath: ".",
        sha,
        domainId: context.domain.id,
        productMessage: `Les contacts bénéficient du changement ${sha.slice(-2)}.`,
      })));
    },
  });

  const payload = await context.service.refreshNow(context.project.id);

  expect(payload.entries).toHaveLength(12);
  expect(payload.entries.every((entry) => entry.enrichment_status === "enriched")).toBe(true);
  expect(generations).toHaveLength(2);
  expect(generations[0]).toEqual(expect.objectContaining({
    cwd: context.root,
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    speed: "standard",
  }));
  expect(payload.state.backfill_version).toBe(CHANGELOG_BACKFILL_VERSION);
  expect(payload.state.next_refresh_at).toBe(
    new Date(context.now.getTime() + CHANGELOG_REFRESH_INTERVAL_MS).toISOString(),
  );
  context.db.close();
});

test("le passage suivant ne demande que les dix derniers commits sans dupliquer l'import", async () => {
  const reads: Array<{ since?: string; limit?: number }> = [];
  const history = commits(12);
  const context = setup({
    history: async (_cwd, options) => {
      reads.push(options);
      return history.slice(0, options.limit ?? history.length);
    },
  });

  await context.service.refreshNow(context.project.id);
  const second = await context.service.refreshNow(context.project.id);

  expect(second.entries).toHaveLength(12);
  expect(second.entries.every((entry) => entry.enrichment_status === "enriched")).toBe(true);
  expect(reads).toEqual([
    expect.objectContaining({ since: "2026-01-01T00:00:00Z", limit: undefined }),
    expect.objectContaining({ since: undefined, limit: CHANGELOG_BATCH_SIZE }),
  ]);
  context.db.close();
});

test("un projet multi-dépôt filtre l'auteur et déduplique les mêmes SHA", async () => {
  const seen: Array<{ cwd: string; authorEmails?: string[] }> = [];
  const shared = "a".repeat(40);
  const context = setup({
    repositories: async (root) => [
      { path: root, relativePath: "." },
      { path: join(root, "apps/reactor"), relativePath: "apps/reactor" },
    ],
    email: async () => "clement.serizay@affilae.com",
    history: async (cwd, options) => {
      seen.push({ cwd, authorEmails: options.authorEmails });
      return [{
        repositoryPath: options.repositoryPath,
        sha: shared,
        branch: "main",
        subject: `feat: ${options.repositoryPath}`,
        committedAt: "2026-08-27T10:00:00Z",
      }];
    },
  });

  const payload = await context.service.refreshNow(context.project.id);

  expect(payload.entries).toHaveLength(1);
  expect(payload.entries[0]?.repository_path).toBe(".");
  expect(seen).toHaveLength(2);
  expect(seen.every((call) => call.authorEmails?.includes("clement.serizay@affilae.com"))).toBe(true);
  context.db.close();
});

test("les backfills simultanés utilisent au plus huit générations Luna au total", async () => {
  let active = 0;
  let maximum = 0;
  const context = setup({
    commits: commits(CHANGELOG_BATCH_SIZE * CHANGELOG_BACKFILL_CONCURRENCY + 1),
    generator: async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const batch = JSON.parse(input.prompt.split("COMMITS: ")[1]!) as Array<{
        repositoryPath: string;
        sha: string;
      }>;
      return JSON.stringify(batch.map(({ repositoryPath, sha }) => ({
        repositoryPath,
        sha,
        domainId: null,
        productMessage: `Résultat ${sha}.`,
      })));
    },
  });
  const secondProject = context.projects.create({
    name: "Second",
    path: mkdtempSync(join(tmpdir(), "pupitre-changelog-second-")),
  });

  const [payload, secondPayload] = await Promise.all([
    context.service.refreshNow(context.project.id),
    context.service.refreshNow(secondProject.id),
  ]);

  expect(maximum).toBe(CHANGELOG_BACKFILL_CONCURRENCY);
  expect(payload.entries.every((entry) => entry.enrichment_status === "enriched")).toBe(true);
  expect(secondPayload.entries.every((entry) => entry.enrichment_status === "enriched")).toBe(true);
  context.db.close();
});

test("une réponse invalide conserve le catalogue brut pour une reprise ultérieure", async () => {
  let attempts = 0;
  const context = setup({
    commits: commits(2),
    generator: async () => {
      attempts += 1;
      return "[]";
    },
  });

  const payload = await context.service.refreshNow(context.project.id);

  expect(payload.entries).toHaveLength(2);
  expect(payload.entries.every((entry) => entry.enrichment_status === "pending")).toBe(true);
  expect(payload.state.status).toBe("error");
  expect(payload.state.error).toContain("incomplet");
  expect(attempts).toBe(CHANGELOG_ENRICHMENT_ATTEMPTS);
  context.db.close();
});

test("associe les réponses par position sans dépendre des identifiants répétés par Luna", () => {
  expect(parseEnrichments(
    '[{"repositoryPath":"mauvais","sha":"court","domainId":"inconnu","productMessage":"Une amélioration visible."}]',
    [{ repositoryPath: ".", sha: "abc" }],
    [],
  )).toEqual([{ repositoryPath: ".", sha: "abc", domainId: null, productMessage: "Une amélioration visible." }]);
  expect(() => parseEnrichments(
    '[{"domainId":null,"productMessage":""}]',
    [{ repositoryPath: ".", sha: "abc" }],
    [],
  )).toThrow("incohérente");
});

test("retente automatiquement un lot Luna structurellement invalide", async () => {
  let attempts = 0;
  const context = setup({
    commits: commits(1),
    generator: async () => {
      attempts += 1;
      if (attempts === 1) return "[]";
      return '[{"domainId":null,"productMessage":"Le second essai aboutit."}]';
    },
  });

  const payload = await context.service.refreshNow(context.project.id);

  expect(attempts).toBe(2);
  expect(payload.state.status).toBe("idle");
  expect(payload.entries[0]?.product_message).toBe("Le second essai aboutit.");
  context.db.close();
});

test("lit les commits Git depuis le 1er janvier avec leur branche et leur sujet original", async () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-git-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root]);
  const commit = (name: string, date: string) => {
    writeFileSync(join(root, `${name}.txt`), name);
    Bun.spawnSync(["git", "-C", root, "add", "."]);
    Bun.spawnSync([
      "git", "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "-qm", `feat: ${name}`,
    ], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  commit("ancien", "2025-12-31T10:00:00Z");
  commit("nouveau", "2026-01-02T10:00:00Z");

  const history = await readGitHistory(root, {
    repositoryPath: ".",
    since: "2026-01-01T00:00:00Z",
  });

  expect(history).toHaveLength(1);
  expect(history[0]).toEqual(expect.objectContaining({
    repositoryPath: ".", branch: "main", subject: "feat: nouveau",
  }));
});

test("conserve le message Git complet pour les détecteurs de cycle de vie", async () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-message-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "change.txt"), "change");
  Bun.spawnSync(["git", "-C", root, "add", "."]);
  Bun.spawnSync([
    "git", "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-qm", "fix: bouton", "-m", "Résout [PB-7K3M9Q] dans le corps.",
  ]);

  const history = await readGitHistory(root, { repositoryPath: ".", limit: 1 });

  expect(history[0]?.subject).toBe("fix: bouton");
  expect(history[0]?.message).toContain("Résout [PB-7K3M9Q] dans le corps.");
});

test("découvre la racine et les dépôts Git imbriqués sans parcourir node_modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-repositories-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "apps", "reactor", ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules", "ignored", ".git"), { recursive: true });

  const repositories = await discoverGitRepositories(root);

  expect(repositories.map((repository) => repository.relativePath)).toEqual([".", "apps/reactor"]);
});

test("filtre l'historique Git par email d'auteur", async () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-author-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root]);
  const commit = (name: string, email: string) => {
    writeFileSync(join(root, `${name}.txt`), name);
    Bun.spawnSync(["git", "-C", root, "add", "."]);
    Bun.spawnSync([
      "git", "-C", root, "-c", `user.name=${name}`, "-c", `user.email=${email}`,
      "commit", "-qm", `feat: ${name}`,
    ]);
  };
  commit("Clement", "clement.serizay@affilae.com");
  commit("Collegue", "collegue@affilae.com");

  const history = await readGitHistory(root, {
    repositoryPath: ".",
    authorEmails: ["clement.serizay@affilae.com"],
  });

  expect(history.map((entry) => entry.subject)).toEqual(["feat: Clement"]);
});

test("migre le catalogue historique vers une clé projet plus SHA", () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-changelog-migration-"));
  let db = openDb(dir);
  const project = new ProjectStore(db).create({ name: "Migration", path: dir });
  new ChangelogStore(db).import(project.id, commits(1), "2026-08-27T10:00:00Z");
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX idx_project_changelog_entries_date;
    DROP INDEX idx_project_changelog_entries_pending;
    ALTER TABLE project_changelog_entries RENAME TO project_changelog_entries_new;
    CREATE TABLE project_changelog_entries (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL,
      branch TEXT NOT NULL,
      subject TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      domain_id TEXT NULL REFERENCES domains(id) ON DELETE SET NULL,
      product_message TEXT NULL,
      enrichment_status TEXT NOT NULL DEFAULT 'pending',
      imported_at TEXT NOT NULL,
      enriched_at TEXT NULL,
      PRIMARY KEY (project_id, commit_sha)
    );
    INSERT INTO project_changelog_entries
      SELECT project_id, commit_sha, branch, subject, committed_at, domain_id,
             product_message, enrichment_status, imported_at, enriched_at
      FROM project_changelog_entries_new;
    DROP TABLE project_changelog_entries_new;
  `);
  db.close();

  db = openDb(dir);
  const entry = new ChangelogStore(db).list(project.id)[0];
  const primaryKey = (db.query("PRAGMA table_info(project_changelog_entries)").all() as Array<{
    name: string;
    pk: number;
  }>).filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  expect(entry?.repository_path).toBe(".");
  expect(primaryKey).toEqual(["project_id", "commit_sha"]);
  expect(new ChangelogStore(db).state(project.id).backfill_version).toBe(0);
  db.close();
});
