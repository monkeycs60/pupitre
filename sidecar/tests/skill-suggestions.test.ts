import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../src/db";
import { QuotaTracker } from "../src/quotas";
import {
  lexicalSkillSuggestions,
  SkillSuggestionService,
} from "../src/skill-suggestions";
import { SkillInventory, type SkillSummary } from "../src/skills";
import { ProjectStore } from "../src/stores/projects";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function summary(
  id: string,
  name: string,
  description: string,
  triggers: string[] = [],
): SkillSummary {
  return {
    id,
    name,
    invocation: name,
    description,
    triggers,
    provider: "claude",
    provenance: "claude-global",
    path: `/skills/${name}/SKILL.md`,
    project_id: null,
    modified_at: "2026-08-05T10:00:00.000Z",
    indexed_at: "2026-08-05T10:00:00.000Z",
    favorite: false,
  };
}

test("le matcher lexical privilégie les triggers et écarte les correspondances faibles", () => {
  const result = lexicalSkillSuggestions([
    summary("support", "csm-support", "Répond aux demandes client.", ["ticket client"]),
    summary("mail", "ecrire-mail", "Rédige une réponse client."),
    summary("audit", "audit", "Inspecte le code."),
    summary("crm", "crm", "Classe un ticket client."),
  ], "Peux-tu répondre à ce ticket client ?");

  expect(result.suggestions).toHaveLength(2);
  expect(result.suggestions[0]).toMatchObject({
    id: "support",
    reason: "déclencheur « ticket client »",
  });
  expect(result.suggestions.map((skill) => skill.id)).not.toContain("audit");
  expect(result.suggestions.map((skill) => skill.id)).not.toContain("mail");
});

test("un mot de développement générique ne suffit pas, mais un trigger explicite reste valide", () => {
  const result = lexicalSkillSuggestions([
    summary("buddy", "cardputer-buddy", "Aide à pousser du code vers le matériel.", ["push"]),
    summary("release", "git-release", "Publie une version stable.", ["commit et push"]),
  ], "commit et push");

  expect(result.suggestions.map((skill) => skill.id)).toEqual(["release"]);
  expect(lexicalSkillSuggestions([
    summary("buddy", "cardputer-buddy", "Aide à pousser du code vers le matériel.", ["push"]),
  ], "push").suggestions).toEqual([]);
});

test("Luna ne départage qu'un cas ambigu demandé et le résultat est mis en cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pupitre-suggestions-"));
  const home = join(dir, "home");
  const projectPath = join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const db = openDb(join(dir, "data"));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const projects = new ProjectStore(db);
  const project = projects.create({ name: "Demo", path: projectPath });
  for (const name of ["alpha", "beta", "gamma", "delta"]) {
    const path = join(home, `.claude/skills/${name}/SKILL.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: Analyse un ticket support.\n---\n# ${name}\n`);
  }
  const inventory = new SkillInventory(db, projects, { homeDir: home });
  inventory.refresh();
  let resolverCalls = 0;
  const service = new SkillSuggestionService(
    inventory,
    projects,
    new QuotaTracker(db),
    async ({ candidates }) => {
      resolverCalls += 1;
      return [candidates[1]?.id ?? "", candidates[0]?.id ?? ""];
    },
  );

  const lexical = await service.suggest(project.id, "analyse ticket support", false);
  expect(lexical.ambiguous).toBe(true);
  expect(resolverCalls).toBe(0);
  const resolved = await service.suggest(project.id, "analyse ticket support", true);
  expect(resolved.resolvedByModel).toBe(true);
  expect(resolved.suggestions.map((skill) => skill.name)).toEqual(["beta", "alpha"]);
  await service.suggest(project.id, "analyse ticket support", true);
  expect(resolverCalls).toBe(1);
});
