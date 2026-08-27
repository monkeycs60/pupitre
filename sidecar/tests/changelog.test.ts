import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANGELOG_BATCH_SIZE,
  CHANGELOG_REFRESH_INTERVAL_MS,
  ChangelogService,
  parseEnrichments,
  readGitHistory,
} from "../src/changelog";
import { openDb } from "../src/db";
import { ChangelogStore, type GitChangelogCommit } from "../src/stores/changelog";
import { DomainStore } from "../src/stores/domains";
import { ProjectStore } from "../src/stores/projects";

function setup(options: {
  commits?: GitChangelogCommit[];
  generator?: import("../src/debriefs").DebriefGenerator;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pupitre-changelog-project-"));
  const db = openDb(mkdtempSync(join(tmpdir(), "pupitre-changelog-db-")));
  const projects = new ProjectStore(db);
  const domains = new DomainStore(db);
  const project = projects.create({ name: "Test", path: root });
  const domain = domains.create(project.id, { name: "Contacts", kind: "métier", status: "actif" });
  const commits = options.commits ?? [];
  const generator = options.generator ?? (async (input) => {
    const batch = JSON.parse(input.prompt.split("COMMITS: ")[1]!) as Array<{ sha: string }>;
    return JSON.stringify(batch.map(({ sha }) => ({
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
    async () => commits,
    () => new Date(now),
  );
  return { db, root, project, domain, store, service, now };
}

function commits(count: number): GitChangelogCommit[] {
  return Array.from({ length: count }, (_, index) => ({
    sha: String(index + 1).padStart(40, "0"),
    branch: index % 2 === 0 ? "main" : "feature/contacts",
    subject: `feat: changement ${index + 1}`,
    committedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
  }));
}

test("importe tout l'historique mais enrichit au plus dix commits avec Luna medium standard", async () => {
  let generation: import("../src/debriefs").DebriefGenerationInput | null = null;
  const history = commits(12);
  const context = setup({
    commits: history,
    generator: async (input) => {
      generation = input;
      const batch = JSON.parse(input.prompt.split("COMMITS: ")[1]!) as Array<{ sha: string }>;
      return JSON.stringify(batch.map(({ sha }) => ({
        sha,
        domainId: context.domain.id,
        productMessage: `Les contacts bénéficient du changement ${sha.slice(-2)}.`,
      })));
    },
  });

  const payload = await context.service.refreshNow(context.project.id);

  expect(payload.entries).toHaveLength(12);
  expect(payload.entries.filter((entry) => entry.enrichment_status === "enriched")).toHaveLength(CHANGELOG_BATCH_SIZE);
  expect(payload.entries.filter((entry) => entry.enrichment_status === "pending")).toHaveLength(2);
  expect(generation).toEqual(expect.objectContaining({
    cwd: context.root,
    provider: "codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    speed: "standard",
  }));
  expect(payload.state.next_refresh_at).toBe(
    new Date(context.now.getTime() + CHANGELOG_REFRESH_INTERVAL_MS).toISOString(),
  );
  context.db.close();
});

test("reprend les commits en attente au passage suivant sans dupliquer l'import", async () => {
  const context = setup({ commits: commits(12) });

  await context.service.refreshNow(context.project.id);
  const second = await context.service.refreshNow(context.project.id);

  expect(second.entries).toHaveLength(12);
  expect(second.entries.every((entry) => entry.enrichment_status === "enriched")).toBe(true);
  context.db.close();
});

test("une réponse invalide conserve le catalogue brut pour une reprise ultérieure", async () => {
  const context = setup({ commits: commits(2), generator: async () => "[]" });

  const payload = await context.service.refreshNow(context.project.id);

  expect(payload.entries).toHaveLength(2);
  expect(payload.entries.every((entry) => entry.enrichment_status === "pending")).toBe(true);
  expect(payload.state.status).toBe("error");
  expect(payload.state.error).toContain("incomplet");
  context.db.close();
});

test("valide strictement les SHA, domaines et phrases du lot", () => {
  expect(parseEnrichments(
    '[{"sha":"abc","domainId":null,"productMessage":"Une amélioration visible."}]',
    ["abc"],
    [],
  )).toEqual([{ sha: "abc", domainId: null, productMessage: "Une amélioration visible." }]);
  expect(() => parseEnrichments(
    '[{"sha":"autre","domainId":null,"productMessage":"Texte"}]',
    ["abc"],
    [],
  )).toThrow("incohérente");
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

  const history = await readGitHistory(root, "2026-01-01T00:00:00Z");

  expect(history).toHaveLength(1);
  expect(history[0]).toEqual(expect.objectContaining({ branch: "main", subject: "feat: nouveau" }));
});
