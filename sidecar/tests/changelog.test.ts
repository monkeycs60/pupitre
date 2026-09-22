import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANGELOG_BACKFILL_CONCURRENCY,
  CHANGELOG_BACKFILL_VERSION,
  CHANGELOG_BATCH_SIZE,
  CHANGELOG_ENRICHMENT_ATTEMPTS,
  CHANGELOG_LINE_STATS_BATCH,
  CHANGELOG_REFRESH_INTERVAL_MS,
  ChangelogService,
  parseCommitLineStats,
  parseEnrichments,
  discoverGitRepositories,
  readCommitLineStats,
  readGitHistory,
  readMergeShas,
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
  lineStats?: ConstructorParameters<typeof ChangelogService>[8];
  mergeShas?: ConstructorParameters<typeof ChangelogService>[9];
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
    options.lineStats ?? (async (_cwd, shas) => shas.map((sha) => ({ sha, added: 3, removed: 1 }))),
    options.mergeShas ?? (async () => []),
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
    model: "gpt-6-luna",
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

test("parse un lot de commits en lignes ajoutées et supprimées, binaires ignorés", () => {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const merge = "c".repeat(40);
  const raw = [
    `\x01${first}\n\n3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n-\t-\tlogo.png\n`,
    `\x01${merge}\n\n`,
    `\x01${second}\n\n0\t7\tREADME.md\n`,
  ].join("");
  expect(parseCommitLineStats(raw)).toEqual([
    { sha: first, added: 13, removed: 1 },
    { sha: second, added: 0, removed: 7 },
  ]);
});

test("remplit les lignes +/− des commits importés par dépôt, par lots bornés", async () => {
  const reads: Array<{ cwd: string; count: number }> = [];
  const context = setup({
    commits: commits(CHANGELOG_LINE_STATS_BATCH + 5),
    lineStats: async (cwd, shas) => {
      reads.push({ cwd, count: shas.length });
      return shas.map((sha) => ({ sha, added: Number(sha.slice(-2)), removed: 2 }));
    },
  });

  const first = await context.service.refreshNow(context.project.id);
  const filled = first.entries.filter((entry) => entry.lines_added !== null);
  expect(filled).toHaveLength(CHANGELOG_LINE_STATS_BATCH);
  expect(reads.every((read) => read.cwd === context.root && read.count <= 100)).toBe(true);
  expect(reads.reduce((sum, read) => sum + read.count, 0)).toBe(CHANGELOG_LINE_STATS_BATCH);
  const sample = filled.find((entry) => entry.commit_sha.endsWith("12"));
  expect(sample).toEqual(expect.objectContaining({ lines_added: 12, lines_removed: 2 }));

  const second = await context.service.refreshNow(context.project.id);
  expect(second.entries.every((entry) => entry.lines_added !== null)).toBe(true);
  expect(reads.reduce((sum, read) => sum + read.count, 0)).toBe(CHANGELOG_LINE_STATS_BATCH + 5);
  context.db.close();
});

test("un commit sans numstat (fusion) est compté 0/0 et n'est plus redemandé", async () => {
  let calls = 0;
  const context = setup({
    commits: commits(2),
    lineStats: async (_cwd, shas) => {
      calls += 1;
      return shas.slice(0, 1).map((sha) => ({ sha, added: 4, removed: 4 }));
    },
  });
  await context.service.refreshNow(context.project.id);
  await context.service.refreshNow(context.project.id);
  expect(calls).toBe(1);
  const entries = context.store.list(context.project.id);
  expect(entries.map((entry) => [entry.lines_added, entry.lines_removed]).sort()).toEqual([[0, 0], [4, 4]]);
  context.db.close();
});

test("lit les lignes +/− réelles d'un dépôt Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-numstat-"));
  const git = (...args: string[]) => Bun.spawnSync([
    "git", "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args,
  ]);
  git("init", "-q");
  writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-qm", "feat: a");
  writeFileSync(join(root, "a.txt"), "one\nthree\nfour\nfive\n");
  git("add", ".");
  git("commit", "-qm", "feat: b");
  const history = await readGitHistory(root, { repositoryPath: "." });
  const stats = await readCommitLineStats(root, history.map((entry) => entry.sha));
  const bySubject = new Map(history.map((entry) => [entry.subject, entry.sha]));
  expect(stats).toContainEqual({ sha: bySubject.get("feat: a")!, added: 3, removed: 0 });
  expect(stats).toContainEqual({ sha: bySubject.get("feat: b")!, added: 2, removed: 1 });
});

test("une fusion garde ses +/− mais sort des totaux de lignes", async () => {
  const merge = "c".repeat(40);
  const regular = "d".repeat(40);
  const context = setup({
    commits: [
      { repositoryPath: ".", sha: regular, branch: "main", subject: "feat: réel", committedAt: "2026-08-24T10:00:00+02:00" },
      { repositoryPath: ".", sha: merge, branch: "feature/x", subject: "Merge origin/develop", committedAt: "2026-08-24T15:00:00+02:00" },
    ],
    mergeShas: async () => [merge],
  });
  await context.service.refreshNow(context.project.id);
  const entries = context.store.list(context.project.id);
  expect(entries.find((entry) => entry.commit_sha === merge)).toEqual(expect.objectContaining({
    is_merge: 1, lines_added: 3, lines_removed: 1,
  }));
  expect(entries.find((entry) => entry.commit_sha === regular)).toEqual(expect.objectContaining({
    is_merge: 0, lines_added: 3, lines_removed: 1,
  }));
  expect(context.store.totals(context.project.id)).toEqual({ commits: 2, linesAdded: 3, linesRemoved: 1 });
  expect(context.store.dailyTotals("2026-08-24", "2026-08-24")).toEqual([
    { day: "2026-08-24", projectId: context.project.id, commits: 2, linesAdded: 3, linesRemoved: 1 },
  ]);
  context.db.close();
});

test("repère les commits de fusion d'un dépôt Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-merge-"));
  const git = (...args: string[]) => Bun.spawnSync([
    "git", "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args,
  ]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "feat: base");
  git("checkout", "-qb", "feature");
  writeFileSync(join(root, "b.txt"), "feature\n");
  git("add", ".");
  git("commit", "-qm", "feat: feature");
  git("checkout", "-q", "main");
  writeFileSync(join(root, "c.txt"), "main\n");
  git("add", ".");
  git("commit", "-qm", "feat: main");
  git("merge", "--no-ff", "-m", "Merge branch 'feature'", "feature");
  const merges = await readMergeShas(root);
  expect(merges).toHaveLength(1);
  const history = await readGitHistory(root, { repositoryPath: "." });
  expect(history.some((entry) => entry.sha === merges[0] && entry.subject.startsWith("Merge "))).toBe(true);
});
