import type { AppEvent } from "./events";
import type { QuotaTracker } from "./quotas";
import { runCodexAppServerTurn } from "./adapters/codex-app-server";
import type { SkillInventory, SkillSummary } from "./skills";
import type { ProjectStore } from "./stores/projects";

export interface SkillSuggestion extends SkillSummary {
  score: number;
  reason: string;
}

export interface SkillSuggestionResult {
  suggestions: SkillSuggestion[];
  ambiguous: boolean;
  resolvedByModel: boolean;
}

export interface AmbiguousSuggestionInput {
  text: string;
  cwd: string;
  candidates: SkillSuggestion[];
}

export type AmbiguousSuggestionResolver = (
  input: AmbiguousSuggestionInput,
) => Promise<string[]>;

const STOP_WORDS = new Set([
  "avec", "dans", "des", "elle", "faire", "pour", "plus", "que", "qui",
  "sur", "une", "utilise", "using", "user", "when", "this", "the", "and",
  "from", "skill", "code", "projet", "project",
]);
const CACHE_LIMIT = 100;

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

function words(value: string): string[] {
  return [...new Set(normalized(value).match(/[a-z0-9]{3,}/g) ?? [])]
    .filter((word) => !STOP_WORDS.has(word));
}

function overlapScore(inputWords: string[], candidateWords: string[], weight: number): number {
  const candidates = new Set(candidateWords);
  return inputWords.reduce(
    (score, word) => score + (candidates.has(word) ? weight : 0),
    0,
  );
}

function lexicalSuggestion(text: string, skill: SkillSummary): SkillSuggestion | null {
  const inputWords = words(text);
  if (inputWords.length === 0) return null;
  const normalizedText = normalized(text);
  const nameWords = words(skill.name.replace(/[-_:]/g, " "));
  const triggerWords = words(skill.triggers.join(" "));
  const descriptionWords = words(skill.description);
  const matchingTriggers = skill.triggers.filter((trigger) => {
    const candidate = normalized(trigger);
    return candidate.length >= 3 && normalizedText.includes(candidate);
  });
  const matchedWords = inputWords.filter((word) => (
    nameWords.includes(word) || triggerWords.includes(word) || descriptionWords.includes(word)
  ));
  const score = overlapScore(inputWords, nameWords, 5)
    + overlapScore(inputWords, triggerWords, 3)
    + overlapScore(inputWords, descriptionWords, 1)
    + matchingTriggers.length * 7
    + (skill.favorite ? 1 : 0);
  if (score <= 0) return null;
  const reason = matchingTriggers[0]
    ? `déclencheur « ${matchingTriggers[0]} »`
    : matchedWords.length > 0
      ? `correspond à ${matchedWords.slice(0, 3).join(", ")}`
      : "favori du projet";
  return { ...skill, score, reason };
}

export function lexicalSkillSuggestions(
  skills: SkillSummary[],
  text: string,
): SkillSuggestionResult {
  const ranked = skills
    .flatMap((skill) => {
      const suggestion = lexicalSuggestion(text, skill);
      return suggestion ? [suggestion] : [];
    })
    .sort((left, right) => right.score - left.score
      || Number(right.favorite) - Number(left.favorite)
      || left.name.localeCompare(right.name));
  const first = ranked[0]?.score ?? 0;
  const second = ranked[1]?.score ?? 0;
  const ambiguous = ranked.length >= 4 && first < 15 && first - second <= 2;
  return {
    suggestions: ranked.slice(0, 3),
    ambiguous,
    resolvedByModel: false,
  };
}

function parseSelectedIds(output: string): string[] {
  const unfenced = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const array = unfenced.match(/\[[\s\S]*\]/)?.[0] ?? unfenced;
  try {
    const parsed = JSON.parse(array);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

async function resolveWithLuna(
  input: AmbiguousSuggestionInput,
  quotas: QuotaTracker,
): Promise<string[]> {
  const output: string[] = [];
  let error: string | null = null;
  const candidates = input.candidates.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
  }));
  const emit = (event: AppEvent) => {
    quotas.ingest(event);
    if (event.type === "text-final") output.push(event.text);
    if (event.type === "status" && event.state === "error") {
      error = event.error ?? "résolution ambiguë impossible";
    }
  };
  await runCodexAppServerTurn({
    cwd: input.cwd,
    model: "gpt-5.6-luna",
    effort: "low",
    speed: "fast",
    prompt: [
      "Choisis au maximum 3 skills utiles pour la demande.",
      "Réponds uniquement par un tableau JSON d'identifiants, du plus utile au moins utile.",
      `Demande: ${input.text}`,
      `Candidats: ${JSON.stringify(candidates)}`,
    ].join("\n"),
    cliSessionId: null,
    permissionMode: "acceptEdits",
    sandboxMode: "read-only",
    images: [],
  }, emit);
  if (error) throw new Error(error);
  return parseSelectedIds(output.join("\n"));
}

export class SkillSuggestionService {
  private readonly cache = new Map<string, SkillSuggestionResult>();
  private readonly resolver: AmbiguousSuggestionResolver;

  constructor(
    private readonly inventory: SkillInventory,
    private readonly projects: ProjectStore,
    quotas: QuotaTracker,
    resolver?: AmbiguousSuggestionResolver,
  ) {
    this.resolver = resolver ?? ((input) => resolveWithLuna(input, quotas));
  }

  async suggest(
    projectId: string,
    text: string,
    resolveAmbiguous: boolean,
  ): Promise<SkillSuggestionResult> {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("projet inconnu");
    const trimmed = text.trim();
    if (!trimmed) return { suggestions: [], ambiguous: false, resolvedByModel: false };
    const lexical = lexicalSkillSuggestions(
      this.inventory.list({ projectId, favoriteProjectId: projectId }),
      trimmed,
    );
    if (!resolveAmbiguous || !lexical.ambiguous) return lexical;
    const cacheKey = `${projectId}\u0000${normalized(trimmed)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    try {
      const candidates = this.inventory.list({ projectId, favoriteProjectId: projectId })
        .flatMap((skill) => {
          const suggestion = lexicalSuggestion(trimmed, skill);
          return suggestion ? [suggestion] : [];
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, 8);
      const selectedIds = await this.resolver({
        text: trimmed,
        cwd: project.path,
        candidates,
      });
      const selected = selectedIds.flatMap((id) => {
        const suggestion = candidates.find((candidate) => candidate.id === id);
        return suggestion ? [suggestion] : [];
      }).slice(0, 3);
      const result = selected.length > 0
        ? { suggestions: selected, ambiguous: false, resolvedByModel: true }
        : lexical;
      this.cache.set(cacheKey, result);
      if (this.cache.size > CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value;
        if (typeof oldest === "string") this.cache.delete(oldest);
      }
      return result;
    } catch {
      return lexical;
    }
  }
}
