import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import { runCodexTurn } from "./adapters/codex";
import type { AppEvent } from "./events";
import type { QuotaTracker } from "./quotas";
import { skillInvocation, type SkillDetail, type SkillInventory } from "./skills";
import type { ProjectStore } from "./stores/projects";
import { projectCwd } from "./workspace";

export type SkillInstallScope = "project" | "global";

export interface SkillCompositionInput {
  projectId: string;
  description: string;
  scope: SkillInstallScope;
}

interface SkillGenerationRequest {
  cwd: string;
  prompt: string;
}

export type SkillGenerator = (input: SkillGenerationRequest) => Promise<string>;

export interface SkillComposerOptions {
  homeDir?: string;
  generator?: SkillGenerator;
}

interface GeneratedSkill {
  name: string;
  description: string;
  content: string;
}

export class SkillAlreadyExistsError extends Error {}

function parseGeneratedSkill(output: string): GeneratedSkill {
  const unfenced = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const object = unfenced.match(/\{[\s\S]*\}/)?.[0] ?? unfenced;
  let parsed: unknown;
  try {
    parsed = JSON.parse(object);
  } catch {
    throw new Error("le composer de skill n'a pas rendu de JSON valide");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sortie du composer de skill invalide");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.name !== "string"
    || typeof candidate.description !== "string"
    || typeof candidate.content !== "string"
    || candidate.name.trim() === ""
    || candidate.description.trim() === ""
    || candidate.content.trim() === ""
  ) {
    throw new Error("le skill généré doit contenir name, description et content");
  }
  return {
    name: candidate.name.trim(),
    description: candidate.description.trim(),
    content: candidate.content.trim(),
  };
}

function normalizedSkillMarkdown(skill: GeneratedSkill, slug: string): string {
  const body = skill.content.replace(/^---\s*\n[\s\S]*?\n---\s*/, "").trim();
  const description = skill.description.replace(/\s+/g, " ");
  return [
    "---",
    `name: ${slug}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function generateWithCodex(
  input: SkillGenerationRequest,
  quotas: QuotaTracker,
): Promise<string> {
  const finals: string[] = [];
  const deltas: string[] = [];
  let providerError: string | null = null;
  const emit = (event: AppEvent) => {
    quotas.ingest(event);
    if (event.type === "text-final") finals.push(event.text);
    if (event.type === "text-delta") deltas.push(event.text);
    if (event.type === "status" && event.state === "error") {
      providerError = event.error ?? "échec du composer de skill";
    }
  };
  const options = {
    cwd: input.cwd,
    model: "gpt-5.6-sol",
    effort: "high",
    prompt: input.prompt,
    cliSessionId: null,
    permissionMode: "plan",
    sandboxMode: "read-only" as const,
    images: [],
  };
  if (process.env.PUPITRE_CODEX_MODE === "exec") await runCodexTurn(options, emit);
  else await runCodexAppServerTurn(options, emit);
  if (providerError !== null) throw new Error(providerError);
  const output = finals.at(-1)?.trim() || deltas.join("").trim();
  if (!output) throw new Error("sortie vide du composer de skill");
  return output;
}

export class SkillComposer {
  private readonly homeDir: string;
  private readonly generator: SkillGenerator;

  constructor(
    private readonly inventory: SkillInventory,
    private readonly projects: ProjectStore,
    quotas: QuotaTracker,
    options: SkillComposerOptions = {},
  ) {
    this.homeDir = options.homeDir ?? homedir();
    this.generator = options.generator ?? ((input) => generateWithCodex(input, quotas));
  }

  async compose(input: SkillCompositionInput): Promise<SkillDetail> {
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("projet inconnu");
    const description = input.description.trim();
    if (!description) throw new Error("description du besoin vide");
    const creator = this.inventory.findByInvocation("skill-creator", project.id);
    const creatorContext = creator
      ? [
          "Respecte aussi les instructions de ce skill-creator indexé :",
          "--- SKILL-CREATOR ---",
          creator.content_md,
          "--- FIN SKILL-CREATOR ---",
        ].join("\n")
      : "Aucun skill-creator n'est indexé : applique le contrat de format ci-dessous.";
    const output = await this.generator({
      cwd: projectCwd(project),
      prompt: [
        "Rédige un skill agentique réutilisable pour le besoin suivant.",
        creatorContext,
        `Besoin: ${description}`,
        "N'exécute rien et ne crée aucun fichier toi-même.",
        "Réponds uniquement par un objet JSON avec :",
        '- "name": nom court en kebab-case',
        '- "description": quand et pourquoi déclencher le skill',
        '- "content": corps markdown complet du SKILL.md (frontmatter accepté)',
      ].join("\n\n"),
    });
    const generated = parseGeneratedSkill(output);
    const slug = skillInvocation(generated.name);
    const root = input.scope === "project"
      ? join(project.path, ".claude/skills")
      : join(this.homeDir, ".claude/skills");
    const skillDir = resolve(root, slug);
    const target = join(skillDir, "SKILL.md");
    if (existsSync(target)) throw new SkillAlreadyExistsError(`le skill ${slug} existe déjà`);
    mkdirSync(skillDir, { recursive: true });
    try {
      writeFileSync(target, normalizedSkillMarkdown(generated, slug), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (existsSync(target)) throw new SkillAlreadyExistsError(`le skill ${slug} existe déjà`);
      throw error;
    }
    this.inventory.refresh();
    const indexed = this.inventory.list({ projectId: project.id, favoriteProjectId: project.id })
      .find((skill) => skill.path === target);
    if (!indexed) throw new Error("skill écrit mais non indexé");
    const detail = this.inventory.get(indexed.id, project.id);
    if (!detail) throw new Error("skill écrit mais détail indisponible");
    return detail;
  }
}
