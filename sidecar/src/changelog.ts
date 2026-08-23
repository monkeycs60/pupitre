import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DebriefGenerator, SessionSummary } from "./debriefs";
import type { GitProjectService } from "./git";
import type { ConversationStore } from "./stores/conversations";
import type { DomainStore } from "./stores/domains";
import type { ProjectStore } from "./stores/projects";
import {
  ChangelogStore,
  type ChangeNature,
  type ChangeProposal,
  type ChangelogReview,
} from "./stores/changelog";
import { conversationCwd } from "./workspace";

const VALID_NATURES = new Set<ChangeNature>(["ajout", "modification", "correction", "retrait"]);
const MANAGED_START = "<!-- pupitre:domain-memory:start -->";
const MANAGED_END = "<!-- pupitre:domain-memory:end -->";

export class ChangelogConflictError extends Error {}
export class SkillRootAmbiguousError extends Error {}

export interface PublishedChangelog {
  review: ChangelogReview;
  files: string[];
}

export class ChangelogService {
  constructor(
    private store: ChangelogStore,
    private conversations: ConversationStore,
    private projects: ProjectStore,
    private domains: DomainStore,
    private git: GitProjectService,
    private generator: DebriefGenerator,
  ) {}

  async propose(conversationId: string, summary: SessionSummary): Promise<ChangelogReview> {
    const existing = this.store.getBySummary(summary.id);
    if (existing) return existing;
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("conversation inconnue");
    const project = this.projects.get(conversation.project_id);
    if (!project) throw new Error("projet inconnu");
    const domains = this.domains.forConversation(conversationId, { visibleOnly: true });
    if (domains.length === 0) {
      return this.store.create({ conversationId, summaryId: summary.id,
        eventIdFrom: summary.event_id_from, eventIdTo: summary.event_id_to, changes: [] });
    }
    const snapshot = this.git.snapshot(project.id, conversation.worktree_path);
    const raw = await this.generator({
      cwd: conversationCwd(project, conversation),
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "high",
      prompt: proposalPrompt(summary.content_md, domains, snapshot),
    });
    const parsed = parseProposal(raw, domains.map((domain) => ({ id: domain.id, name: domain.name })));
    return this.store.create({ conversationId, summaryId: summary.id,
      eventIdFrom: summary.event_id_from, eventIdTo: summary.event_id_to, changes: parsed });
  }

  async publish(reviewId: string, changes: ChangeProposal[]): Promise<PublishedChangelog> {
    const review = this.store.get(reviewId);
    if (!review) throw new Error("validation changelog inconnue");
    if (review.status === "publié") return { review, files: [] };
    const conversation = this.conversations.get(review.conversationId)!;
    const project = this.projects.get(conversation.project_id)!;
    const workspace = conversationCwd(project, conversation);
    const selected = changes.filter((change) => change.selected).map(validateChange);
    const byDomain = new Map<string, ChangeProposal[]>();
    for (const change of selected) {
      const domain = this.domains.get(change.domainId);
      if (!domain || domain.project_id !== project.id || domain.status !== "actif") {
        throw new Error("domaine actif invalide");
      }
      byDomain.set(change.domainId, [...(byDomain.get(change.domainId) ?? []), change]);
    }
    const writes: Array<{ path: string; content: string; domainId: string; root: string; skill: boolean }> = [];
    for (const [domainId, domainChanges] of byDomain) {
      const domain = this.domains.get(domainId)!;
      const root = detectSkillRoot(workspace, domain.name, this.store.publication(domainId)?.skill_root);
      const directory = join(root, slug(domain.name));
      const changelogPath = join(directory, "CHANGELOG.md");
      const skillPath = join(directory, "SKILL.md");
      const changelog = existsSync(changelogPath)
        ? readFileSync(changelogPath, "utf8")
        : `# Catalogue — ${domain.name}\n`;
      const additions = domainChanges.filter((change) => !changelog.includes(`pupitre-change:${change.id}`));
      const nextChangelog = additions.length === 0 ? changelog : `${changelog.trimEnd()}\n\n${additions.map(changeMarkdown).join("\n\n")}\n`;
      const currentSkill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : initialSkill(domain.name);
      const previous = this.store.publication(domainId);
      if (previous?.skill_sha256 && sha(currentSkill) !== previous.skill_sha256) {
        throw new ChangelogConflictError(`le skill « ${domain.name} » a été modifié depuis la dernière publication`);
      }
      const managedBody = (await this.generator({
        cwd: conversationCwd(project, conversation),
        provider: "codex",
        model: "gpt-5.6-luna",
        effort: "high",
        prompt: skillPrompt(domain.name, currentSkill, nextChangelog),
      })).trim();
      if (!managedBody || managedBody.length > 12_000 || managedBody.includes(MANAGED_START) || managedBody.includes(MANAGED_END)) {
        throw new Error(`synthèse du skill « ${domain.name} » invalide`);
      }
      const nextSkill = updateManagedSkill(currentSkill, managedBody);
      writes.push({ path: changelogPath, content: nextChangelog, domainId, root, skill: false });
      writes.push({ path: skillPath, content: nextSkill, domainId, root, skill: true });
    }
    for (const write of writes) {
      mkdirSync(dirname(write.path), { recursive: true });
      writeFileSync(write.path, write.content, "utf8");
      if (write.skill) this.store.savePublication(write.domainId, rootConvention(write.root), sha(write.content));
    }
    this.store.publish(reviewId, selected);
    return { review: this.store.get(reviewId)!, files: writes.map((write) => write.path) };
  }

  list(projectId: string, domainId?: string): Array<Record<string, unknown>> {
    return this.store.listByProject(projectId, domainId);
  }
}

function proposalPrompt(summary: string, domains: Array<{ id: string; name: string }>, snapshot: ReturnType<GitProjectService["snapshot"]>): string {
  return [
    "Tu catalogues en français les modifications réellement réalisées pendant une séquence de développement.",
    "Décompose un ticket en plusieurs entrées si plusieurs capacités ou changements durables ont été livrés.",
    "Inclus les changements fonctionnels, métier, UI, UX, design, accessibilité, API, données, architecture, opérations et capacités d'agents.",
    "Exclus les intentions, plans, tentatives abandonnées et micro-ajustements sans effet durable.",
    "Les fichiers sales non prouvés par le résumé sont ambigus. Une entrée ambiguë doit avoir selected=false.",
    "Retourne uniquement un tableau JSON. Chaque objet contient domainId, nature, title, description, impact, evidence, ambiguous.",
    "nature vaut ajout, modification, correction ou retrait. evidence est un tableau de chaînes courtes.",
    "Une modification transversale est répétée pour chaque domaine concerné avec le même groupKey et une formulation adaptée.",
    "Retourne [] si rien de notable n'est réalisé.",
    `DOMAINES: ${JSON.stringify(domains)}`,
    `RÉSUMÉ VALIDÉ PAR LA SESSION:\n${summary}`,
    `GIT HEAD: ${snapshot.head ?? "aucun"}`,
    `COMMITS RÉCENTS: ${JSON.stringify(snapshot.commits.slice(0, 12).map(({ sha, subject, conversations }) => ({ sha, subject, conversations })))}`,
    `FICHIERS MODIFIÉS: ${JSON.stringify(snapshot.dirtyFiles)}`,
  ].join("\n\n");
}

export function parseProposal(raw: string, domains: Array<{ id: string; name: string }>): ChangeProposal[] {
  const match = raw.trim().match(/\[[\s\S]*\]/);
  if (!match) throw new Error("propositions changelog invalides : tableau JSON absent");
  const values = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(values) || values.length > 20) throw new Error("propositions changelog invalides");
  const names = new Map(domains.map((domain) => [domain.id, domain.name]));
  const groups = new Map<string, string>();
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("proposition invalide");
    const item = value as Record<string, unknown>;
    const domainId = String(item.domainId ?? "");
    const domainName = names.get(domainId);
    const nature = item.nature as ChangeNature;
    if (!domainName || !VALID_NATURES.has(nature)) throw new Error("domaine ou nature invalide");
    const groupKey = String(item.groupKey ?? `${domainId}-${index}`);
    const groupId = groups.get(groupKey) ?? crypto.randomUUID();
    groups.set(groupKey, groupId);
    const ambiguous = item.ambiguous === true;
    return validateChange({
      id: crypto.randomUUID(), groupId, domainId, domainName, nature,
      title: String(item.title ?? "").trim(),
      description: String(item.description ?? "").trim(),
      impact: String(item.impact ?? "").trim(),
      evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 12) : [],
      ambiguous, selected: !ambiguous,
    });
  });
}

function validateChange(change: ChangeProposal): ChangeProposal {
  if (!change.title || !change.description || !change.impact) throw new Error("entrée changelog incomplète");
  if (!VALID_NATURES.has(change.nature)) throw new Error("nature changelog invalide");
  return { ...change, title: change.title.slice(0, 160), description: change.description.slice(0, 1200), impact: change.impact.slice(0, 600) };
}

function detectSkillRoot(projectPath: string, domainName: string, saved?: string): string {
  if (saved === ".claude/skills" || saved === ".agents/skills") return join(projectPath, saved);
  const roots = [join(projectPath, ".claude/skills"), join(projectPath, ".agents/skills")];
  const existingDomain = roots.filter((root) => existsSync(join(root, slug(domainName), "SKILL.md")));
  if (existingDomain.length === 1) return existingDomain[0]!;
  if (existingDomain.length > 1) throw new SkillRootAmbiguousError("plusieurs skills canoniques existent pour ce domaine");
  const existingRoots = roots.filter(existsSync);
  if (existingRoots.length === 1) return existingRoots[0]!;
  if (existingRoots.length > 1) throw new SkillRootAmbiguousError("plusieurs racines de skills existent dans le projet");
  return roots[0]!;
}

function rootConvention(root: string): string {
  return root.endsWith(".agents/skills") ? ".agents/skills" : ".claude/skills";
}

function slug(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "domaine";
}

function changeMarkdown(change: ChangeProposal): string {
  return [`## ${new Date().toISOString().slice(0, 10)} — ${change.title}`,
    `<!-- pupitre-change:${change.id} group:${change.groupId} -->`,
    `**Nature :** ${change.nature}`, "", change.description, "", `**Impact :** ${change.impact}`,
    ...(change.evidence.length ? ["", "**Preuves :**", ...change.evidence.map((item) => `- ${item}`)] : []),
  ].join("\n");
}

function initialSkill(name: string): string {
  return `---\nname: ${slug(name)}\ndescription: Connaissance vivante du domaine ${name}.\n---\n\n# ${name}\n`;
}

function updateManagedSkill(skill: string, body: string): string {
  const managed = [MANAGED_START, body.trim(), "", `Catalogue détaillé : [CHANGELOG.md](./${basename("CHANGELOG.md")}).`, MANAGED_END].join("\n");
  const pattern = new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}`);
  if (pattern.test(skill)) return `${skill.replace(pattern, managed).trimEnd()}\n`;
  return `${skill.trimEnd()}\n\n${managed}\n`;
}

function skillPrompt(domainName: string, currentSkill: string, changelog: string): string {
  return [
    `Tu mets à jour la mémoire opérationnelle du domaine « ${domainName} » à partir de modifications réalisées et validées.`,
    "Retourne uniquement la section Markdown gérée, sans frontmatter, sans balises HTML et sans fence.",
    "Synthétise l'état actuel, la direction observable, les capacités récentes et les liens avec architecture, skills, MCP ou outils uniquement lorsqu'ils sont établis par les sources.",
    "N'invente aucune intention. Ne recopie pas exhaustivement le catalogue. Reste sous 1200 mots.",
    "Utilise les titres utiles parmi : ## État actuel, ## Direction observable, ## Repères techniques, ## Outils et domaines connexes, ## Changements récents.",
    `SKILL_MD_ACTUEL:\n${currentSkill}`,
    `CATALOGUE_VALIDÉ:\n${changelog}`,
  ].join("\n\n");
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
