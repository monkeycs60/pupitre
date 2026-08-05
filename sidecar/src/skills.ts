import type { Database } from "bun:sqlite";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectStore } from "./stores/projects";

export type SkillProvider = "claude" | "codex";
export type SkillProvenance =
  | "claude-global"
  | "claude-plugin"
  | "claude-project"
  | "codex-prompt"
  | "agents-global"
  | "agents-project";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  provider: SkillProvider;
  provenance: SkillProvenance;
  path: string;
  project_id: string | null;
  modified_at: string;
  indexed_at: string;
  favorite: boolean;
}

export interface SkillDetail extends SkillSummary {
  content_md: string;
}

interface ScannedSkill {
  name: string;
  description: string;
  triggers: string[];
  provider: SkillProvider;
  provenance: SkillProvenance;
  path: string;
  projectId: string | null;
  content: string;
  modifiedAt: string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  triggers_json: string;
  provider: SkillProvider;
  provenance: SkillProvenance;
  path: string;
  project_id: string | null;
  modified_at: string;
  indexed_at: string;
  favorite: number;
}

export interface SkillInventoryOptions {
  homeDir?: string;
  watchDebounceMs?: number;
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_INJECTED_SKILLS = 3;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "references", "reference", "scripts", "assets", "rules"]);

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---", 4);
  if (end === -1) return {};
  const fields: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value) fields[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return fields;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseTriggers(frontmatter: Record<string, string>, description: string, name: string): string[] {
  const explicit = frontmatter.triggers
    ? frontmatter.triggers.replace(/^\[|\]$/g, "").split(",").map((value) => value.replace(/^\s*['"]|['"]\s*$/g, ""))
    : [];
  const quoted = [...description.matchAll(/["“]([^"”]{2,80})["”]/g)]
    .map((match) => match[1] ?? "");
  const nameParts = name.split(/[-_:]+/).filter((part) => part.length > 2);
  return unique([...explicit, ...quoted, ...nameParts]).slice(0, 24);
}

function titleFromContent(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

function descriptionFromContent(content: string): string {
  const withoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\s*/, "");
  return withoutFrontmatter
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"))
    ?.slice(0, 600) ?? "";
}

function safeDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function findNamedFiles(root: string, filename: string, maxDepth: number): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const candidate = join(current.path, filename);
    if (existsSync(candidate)) found.push(candidate);
    if (current.depth >= maxDepth) continue;
    for (const child of safeDirectories(current.path)) {
      pending.push({ path: child, depth: current.depth + 1 });
    }
  }
  return found;
}

function findMarkdownFiles(root: string, maxDepth: number): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    try {
      for (const entry of readdirSync(current.path, { withFileTypes: true })) {
        const path = join(current.path, entry.name);
        if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
        if (
          entry.isDirectory()
          && current.depth < maxDepth
          && !SKIPPED_DIRECTORIES.has(entry.name)
        ) {
          pending.push({ path, depth: current.depth + 1 });
        }
      }
    } catch {
      // Une source optionnelle ou un plugin peut disparaître pendant le scan.
    }
  }
  return found;
}

function readSkill(
  path: string,
  provider: SkillProvider,
  provenance: SkillProvenance,
  projectId: string | null,
): ScannedSkill | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const content = readFileSync(path, "utf8");
    const frontmatter = parseFrontmatter(content);
    const fallbackName = basename(path, ".md") === "SKILL" ? basename(dirname(path)) : basename(path, ".md");
    const name = frontmatter.name || (provenance === "codex-prompt"
      ? fallbackName
      : titleFromContent(content, fallbackName));
    const description = (frontmatter.description || descriptionFromContent(content)).slice(0, 1_000);
    return {
      name,
      description,
      triggers: parseTriggers(frontmatter, description, name),
      provider,
      provenance,
      path: resolve(path),
      projectId,
      content,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function rowToSummary(row: SkillRow): SkillSummary {
  let triggers: string[] = [];
  try {
    const parsed = JSON.parse(row.triggers_json);
    if (Array.isArray(parsed)) triggers = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // Une ancienne ligne malformée reste visible, simplement sans triggers.
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggers,
    provider: row.provider,
    provenance: row.provenance,
    path: row.path,
    project_id: row.project_id,
    modified_at: row.modified_at,
    indexed_at: row.indexed_at,
    favorite: row.favorite === 1,
  };
}

export class SkillInventory {
  private readonly homeDir: string;
  private readonly debounceMs: number;
  private watchers: FSWatcher[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    private readonly db: Database,
    private readonly projects: ProjectStore,
    options: SkillInventoryOptions = {},
  ) {
    this.homeDir = options.homeDir ?? homedir();
    this.debounceMs = options.watchDebounceMs ?? 250;
  }

  refresh(): number {
    const scanned = this.scan();
    const indexedAt = new Date().toISOString();
    const paths = new Set(scanned.map((skill) => skill.path));
    const existing = this.db.query("SELECT id, path FROM skills").all() as Array<{ id: string; path: string }>;
    const upsert = this.db.query(`
      INSERT INTO skills (
        id, name, description, triggers_json, provider, provenance, path,
        project_id, content_md, modified_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        triggers_json = excluded.triggers_json,
        provider = excluded.provider,
        provenance = excluded.provenance,
        project_id = excluded.project_id,
        content_md = excluded.content_md,
        modified_at = excluded.modified_at,
        indexed_at = excluded.indexed_at
    `);
    const remove = this.db.query("DELETE FROM skills WHERE path = ?");
    this.db.transaction(() => {
      for (const skill of scanned) {
        const previous = existing.find((item) => item.path === skill.path);
        upsert.run(
          previous?.id ?? crypto.randomUUID(),
          skill.name,
          skill.description,
          JSON.stringify(skill.triggers),
          skill.provider,
          skill.provenance,
          skill.path,
          skill.projectId,
          skill.content,
          skill.modifiedAt,
          indexedAt,
        );
      }
      for (const row of existing) {
        if (!paths.has(row.path)) remove.run(row.path);
      }
    })();
    if (this.started) this.resetWatchers();
    return scanned.length;
  }

  start(): void {
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  list(filters: {
    query?: string;
    provider?: SkillProvider;
    projectId?: string;
    favoriteProjectId?: string;
  } = {}): SkillSummary[] {
    const clauses: string[] = [];
    const parameters: Array<string> = [];
    if (filters.provider) {
      clauses.push("s.provider = ?");
      parameters.push(filters.provider);
    }
    if (filters.projectId) {
      clauses.push("(s.project_id IS NULL OR s.project_id = ?)");
      parameters.push(filters.projectId);
    }
    if (filters.query?.trim()) {
      const query = `%${filters.query.trim().toLowerCase()}%`;
      clauses.push("(lower(s.name) LIKE ? OR lower(s.description) LIKE ? OR lower(s.triggers_json) LIKE ?)");
      parameters.push(query, query, query);
    }
    const favoriteProject = filters.favoriteProjectId ?? filters.projectId ?? "";
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.query(`
      SELECT s.id, s.name, s.description, s.triggers_json, s.provider,
        s.provenance, s.path, s.project_id, s.modified_at, s.indexed_at,
        CASE WHEN f.skill_id IS NULL THEN 0 ELSE 1 END AS favorite
      FROM skills s
      LEFT JOIN skill_favorites f ON f.skill_id = s.id AND f.project_id = ?
      ${where}
      ORDER BY favorite DESC, s.name COLLATE NOCASE, s.path
    `).all(favoriteProject, ...parameters) as SkillRow[];
    return rows.map(rowToSummary);
  }

  get(id: string, projectId?: string): SkillDetail | null {
    const row = this.db.query(`
      SELECT s.id, s.name, s.description, s.triggers_json, s.provider,
        s.provenance, s.path, s.project_id, s.modified_at, s.indexed_at,
        s.content_md,
        CASE WHEN f.skill_id IS NULL THEN 0 ELSE 1 END AS favorite
      FROM skills s
      LEFT JOIN skill_favorites f ON f.skill_id = s.id AND f.project_id = ?
      WHERE s.id = ?
    `).get(projectId ?? "", id) as (SkillRow & { content_md: string }) | null;
    return row ? { ...rowToSummary(row), content_md: row.content_md } : null;
  }

  setFavorite(projectId: string, skillId: string, favorite: boolean): boolean {
    if (!this.projects.get(projectId) || !this.get(skillId)) return false;
    if (favorite) {
      this.db.query(`
        INSERT INTO skill_favorites (project_id, skill_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(project_id, skill_id) DO NOTHING
      `).run(projectId, skillId, new Date().toISOString());
    } else {
      this.db.query("DELETE FROM skill_favorites WHERE project_id = ? AND skill_id = ?")
        .run(projectId, skillId);
    }
    return true;
  }

  /**
   * Résout la syntaxe Pupitre `$nom-du-skill` dans les sources disponibles pour
   * le projet. Seul le fichier indexé est injecté : références, scripts et
   * assets restent volontairement hors du pont cross-provider v1.
   */
  augmentPrompt(prompt: string, projectId: string): string {
    const requestedNames = unique(
      [...prompt.matchAll(/\$([\p{L}\p{N}][\p{L}\p{N}:_-]{1,80})/gu)]
        .map((match) => match[1] ?? ""),
    ).slice(0, MAX_INJECTED_SKILLS);
    if (requestedNames.length === 0) return prompt;

    const available = this.list({ projectId });
    const resolved = requestedNames.flatMap((requestedName) => {
      const matching = available.filter(
        (skill) => skill.name.toLocaleLowerCase() === requestedName.toLocaleLowerCase(),
      );
      const selected = matching.find((skill) => skill.project_id === projectId)
        ?? matching.find((skill) => skill.favorite)
        ?? matching[0];
      if (!selected) return [];
      const detail = this.get(selected.id, projectId);
      return detail ? [detail] : [];
    });
    if (resolved.length === 0) return prompt;

    const contexts = resolved.map((skill) => [
      `--- SKILL ${skill.name} (${skill.provenance}) ---`,
      skill.content_md,
      `--- FIN SKILL ${skill.name} ---`,
    ].join("\n"));
    return [
      "[Skills demandés explicitement via Pupitre]",
      "Applique les instructions des SKILL.md ci-dessous à la demande utilisateur.",
      "Le pont v1 ne joint volontairement ni scripts, ni références, ni assets.",
      ...contexts,
      "[Demande utilisateur]",
      prompt,
    ].join("\n\n");
  }

  private scan(): ScannedSkill[] {
    const skills: ScannedSkill[] = [];
    const add = (path: string, provider: SkillProvider, provenance: SkillProvenance, projectId: string | null) => {
      const skill = readSkill(path, provider, provenance, projectId);
      if (skill) skills.push(skill);
    };
    for (const path of findNamedFiles(join(this.homeDir, ".claude/skills"), "SKILL.md", 2)) {
      add(path, "claude", "claude-global", null);
    }
    for (const path of findNamedFiles(join(this.homeDir, ".claude/plugins"), "SKILL.md", 8)) {
      add(path, "claude", "claude-plugin", null);
    }
    for (const path of findMarkdownFiles(join(this.homeDir, ".codex/prompts"), 2)) {
      add(path, "codex", "codex-prompt", null);
    }
    const globalAgents = join(this.homeDir, ".codex/AGENTS.md");
    if (existsSync(globalAgents)) add(globalAgents, "codex", "agents-global", null);
    for (const project of this.projects.list()) {
      for (const path of findNamedFiles(join(project.path, ".claude/skills"), "SKILL.md", 2)) {
        add(path, "claude", "claude-project", project.id);
      }
      const agents = join(project.path, "AGENTS.md");
      if (existsSync(agents)) add(agents, "codex", "agents-project", project.id);
    }
    const byPath = new Map(skills.map((skill) => [skill.path, skill]));
    return [...byPath.values()];
  }

  private scheduleRefresh = (): void => {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, this.debounceMs);
  };

  private resetWatchers(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    const roots = new Set<string>();
    const addRootAndChildren = (root: string, childDepth = 1) => {
      if (!existsSync(root)) return;
      roots.add(root);
      let current = [root];
      for (let depth = 0; depth < childDepth; depth += 1) {
        current = current.flatMap((path) => safeDirectories(path));
        for (const path of current) roots.add(path);
      }
    };
    addRootAndChildren(join(this.homeDir, ".claude/skills"), 1);
    addRootAndChildren(join(this.homeDir, ".claude/plugins"), 1);
    addRootAndChildren(join(this.homeDir, ".claude/plugins/marketplaces"), 2);
    addRootAndChildren(join(this.homeDir, ".codex/prompts"), 2);
    addRootAndChildren(join(this.homeDir, ".codex"), 0);
    const indexedPaths = this.db.query("SELECT path FROM skills").all() as Array<{ path: string }>;
    for (const skill of indexedPaths) {
      roots.add(dirname(skill.path));
      roots.add(dirname(dirname(skill.path)));
    }
    for (const project of this.projects.list()) {
      addRootAndChildren(project.path, 0);
      addRootAndChildren(join(project.path, ".claude/skills"), 1);
    }
    for (const root of roots) {
      try {
        this.watchers.push(watch(root, this.scheduleRefresh));
      } catch {
        // Un dossier optionnel peut disparaître entre existsSync et fs.watch.
      }
    }
  }
}
