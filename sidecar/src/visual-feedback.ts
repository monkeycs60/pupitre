import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { GitProjectService } from "./git";
import type { MediaStore } from "./media";
import type { ConversationRunner } from "./runner";
import type { Conversation, ConversationStore } from "./stores/conversations";
import type { PresetStore } from "./stores/presets";
import type { Project, ProjectStore } from "./stores/projects";
import type { SettingsStore } from "./stores/settings";

const SAFE_BRANCH = /^[a-zA-Z0-9._/-]{1,160}$/;
const MAX_ANNOTATIONS = 30;
const MAX_HTML = 12 * 1024;
const ALLOWED_STYLES = new Set([
  "display", "position", "width", "height", "marginTop", "marginRight",
  "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "color", "backgroundColor", "fontFamily", "fontSize",
  "fontWeight", "lineHeight", "textAlign", "border", "borderRadius", "gap",
  "alignItems", "justifyContent", "gridTemplateColumns", "flexDirection",
  "overflow", "zIndex", "opacity", "visibility",
]);

export interface VisualFeedbackAnnotation {
  number: number;
  instruction: string;
  point: { x: number; y: number; elementX: number; elementY: number };
  selectors: string[];
  html: string;
  styles: Record<string, string>;
  cropDataUrl?: string;
  viewportDataUrl?: string;
}

export interface VisualFeedbackSubmission {
  version: 1;
  submissionId: string;
  projectId: string;
  branch: string;
  conversationId?: string;
  generalInstruction?: string;
  page: {
    url: string;
    title: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
  };
  annotations: VisualFeedbackAnnotation[];
}

export type VisualFeedbackResolution =
  | { status: "resolved"; project: Pick<Project, "id" | "name"> }
  | { status: "ambiguous"; projects: Array<Pick<Project, "id" | "name">> }
  | { status: "unresolved"; projects: Array<Pick<Project, "id" | "name">> };

function publicProject(project: Project): Pick<Project, "id" | "name"> {
  return { id: project.id, name: project.name };
}

export function listeningProcessCwd(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const result = Bun.spawnSync(["ss", "-ltnp", `sport = :${port}`]);
  if (result.exitCode !== 0) return null;
  const pid = /pid=(\d+)/u.exec(result.stdout.toString())?.[1];
  if (!pid) return null;
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

function requiredText(value: unknown, label: string, max = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} invalide`);
  }
  return value.trim();
}

function redactHtml(html: string): string {
  return html
    .replace(/\svalue=(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/(<(?:textarea|select)\b[^>]*>)[\s\S]*?(<\/(?:textarea|select)>)/giu, "$1$2")
    .replace(/(<[^>]+\bcontenteditable=(?:"true"|'true'|true)[^>]*>)[\s\S]*?(<\/[^>]+>)/giu, "$1$2")
    .slice(0, MAX_HTML);
}

export function sanitizeVisualFeedbackSubmission(input: VisualFeedbackSubmission): VisualFeedbackSubmission {
  if (input.version !== 1) throw new Error("version invalide");
  const branch = requiredText(input.branch, "branche", 160);
  if (!SAFE_BRANCH.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("branche invalide");
  }
  if (!Array.isArray(input.annotations) || input.annotations.length < 1 || input.annotations.length > MAX_ANNOTATIONS) {
    throw new Error("annotations invalides");
  }
  const url = new URL(requiredText(input.page?.url, "URL", 2_048));
  if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"))) {
    throw new Error("URL non locale");
  }
  const annotations = input.annotations.map((annotation, index) => ({
    number: Number.isInteger(annotation.number) && annotation.number > 0 ? annotation.number : index + 1,
    instruction: requiredText(annotation.instruction, "instruction", 4_000),
    point: {
      x: Number(annotation.point?.x) || 0,
      y: Number(annotation.point?.y) || 0,
      elementX: Number(annotation.point?.elementX) || 0,
      elementY: Number(annotation.point?.elementY) || 0,
    },
    selectors: Array.isArray(annotation.selectors)
      ? annotation.selectors.filter((item): item is string => typeof item === "string" && item.length <= 500).slice(0, 5)
      : [],
    html: redactHtml(typeof annotation.html === "string" ? annotation.html : ""),
    styles: Object.fromEntries(Object.entries(annotation.styles ?? {})
      .filter(([key, value]) => ALLOWED_STYLES.has(key) && typeof value === "string" && value.length <= 500)),
    ...(typeof annotation.cropDataUrl === "string" ? { cropDataUrl: annotation.cropDataUrl } : {}),
    ...(typeof annotation.viewportDataUrl === "string" ? { viewportDataUrl: annotation.viewportDataUrl } : {}),
  }));
  return {
    ...input,
    submissionId: requiredText(input.submissionId, "identifiant", 200),
    projectId: requiredText(input.projectId, "projet", 200),
    branch,
    page: {
      url: url.toString(),
      title: typeof input.page.title === "string" ? input.page.title.slice(0, 500) : "",
      viewport: {
        width: Math.max(1, Math.min(10_000, Number(input.page.viewport?.width) || 1)),
        height: Math.max(1, Math.min(10_000, Number(input.page.viewport?.height) || 1)),
        devicePixelRatio: Math.max(0.1, Math.min(10, Number(input.page.viewport?.devicePixelRatio) || 1)),
      },
    },
    annotations,
  };
}

export function visualFeedbackPrompt(input: VisualFeedbackSubmission): string {
  const header = [
    "Corrige les retours visuels suivants dans l'interface indiquée.",
    "Vérifie le résultat dans Chrome avant de conclure.",
    `URL : ${input.page.url}`,
    `Viewport : ${input.page.viewport.width}×${input.page.viewport.height} @${input.page.viewport.devicePixelRatio}`,
    ...(input.generalInstruction?.trim() ? [`Consigne générale : ${input.generalInstruction.trim()}`] : []),
  ];
  const sections = [...input.annotations].sort((a, b) => a.number - b.number).map((annotation) => [
    `## Annotation ${annotation.number}`,
    annotation.instruction,
    `Point : (${annotation.point.x}, ${annotation.point.y}) dans le viewport`,
    `Sélecteurs : ${annotation.selectors.join(" | ") || "non disponible"}`,
    `HTML observé :\n\`\`\`html\n${annotation.html}\n\`\`\``,
    `Styles observés :\n\`\`\`json\n${JSON.stringify(annotation.styles, null, 2)}\n\`\`\``,
  ].join("\n\n"));
  return [...header, ...sections].join("\n\n");
}

export const VISUAL_FEEDBACK_TOKEN_KEY = "visual-feedback-token-hash";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createVisualFeedbackToken(settings: SettingsStore): string {
  const token = randomBytes(24).toString("base64url");
  settings.set(VISUAL_FEEDBACK_TOKEN_KEY, tokenHash(token));
  return token;
}

export function verifyVisualFeedbackToken(settings: SettingsStore, token: string): boolean {
  const stored = settings.get<string>(VISUAL_FEEDBACK_TOKEN_KEY);
  if (!stored || !token) return false;
  const actual = Buffer.from(tokenHash(token));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function decodeImage(dataUrl: string | undefined): Uint8Array | null {
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
  if (!match) throw new Error("capture invalide");
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("capture trop volumineuse");
  return bytes;
}

export class VisualFeedbackService {
  constructor(
    private db: Database,
    private projects: ProjectStore,
    private conversations: ConversationStore,
    private presets: PresetStore,
    private git: GitProjectService,
    private media: MediaStore,
    private runner: ConversationRunner,
  ) {}

  resolveOrigin(input: { origin: string; pathname: string; cwd?: string | null }): VisualFeedbackResolution {
    const associated = (this.db.query(
      "SELECT project_id, path_prefix FROM visual_feedback_origins WHERE origin = ?",
    ).all(input.origin) as Array<{ project_id: string; path_prefix: string }>)
      .filter((item) => {
        const prefix = item.path_prefix === "/" ? "/" : item.path_prefix.replace(/\/+$/u, "");
        return prefix === "/" || input.pathname === prefix || input.pathname.startsWith(`${prefix}/`);
      })
      .sort((left, right) => right.path_prefix.length - left.path_prefix.length)[0] ?? null;
    if (associated) {
      const project = this.projects.get(associated.project_id);
      if (project) return { status: "resolved", project: publicProject(project) };
    }
    const cwd = input.cwd ? realpathSync(input.cwd) : null;
    const candidates = cwd ? this.projects.list().filter((project) => {
      try { return inside(realpathSync(project.path), cwd); } catch { return false; }
    }) : [];
    if (candidates.length === 1) return { status: "resolved", project: publicProject(candidates[0]!) };
    return candidates.length > 1
      ? { status: "ambiguous", projects: candidates.map(publicProject) }
      : { status: "unresolved", projects: this.projects.list().map(publicProject) };
  }

  associateOrigin(origin: string, pathPrefix: string, projectId: string): void {
    if (!this.projects.get(projectId)) throw new Error("projet inconnu");
    this.db.query(`INSERT INTO visual_feedback_origins (origin, path_prefix, project_id)
      VALUES (?, ?, ?) ON CONFLICT(origin, path_prefix) DO UPDATE SET project_id = excluded.project_id`)
      .run(origin, pathPrefix || "/", projectId);
  }

  destinations(projectId: string): { branches: string[]; conversations: Conversation[]; currentBranch: string | null } {
    if (!this.projects.get(projectId)) throw new Error("projet inconnu");
    const snapshot = this.git.snapshot(projectId);
    return {
      branches: snapshot.branches.map((branch) => branch.name),
      currentBranch: snapshot.currentBranch,
      conversations: this.conversations.listByProject(projectId),
    };
  }

  async submit(raw: VisualFeedbackSubmission): Promise<{ conversationId: string; projectId: string }> {
    const input = sanitizeVisualFeedbackSubmission(raw);
    const existing = this.db.query("SELECT conversation_id, project_id FROM visual_feedback_submissions WHERE submission_id = ?")
      .get(input.submissionId) as { conversation_id: string; project_id: string } | null;
    if (existing) return { conversationId: existing.conversation_id, projectId: existing.project_id };
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("projet inconnu");
    const snapshot = this.git.snapshot(project.id);
    const worktreePath = snapshot.currentBranch === input.branch
      ? null
      : this.git.createWorktree(project.id, { branch: input.branch }).path;
    let conversation = input.conversationId ? this.conversations.get(input.conversationId) : null;
    if (conversation && (conversation.project_id !== project.id
      || conversation.created_on_branch !== input.branch
      || conversation.worktree_path !== worktreePath)) {
      throw new Error("conversation incompatible");
    }
    const prompt = visualFeedbackPrompt(input);
    if (!conversation) {
      conversation = this.conversations.listByProject(project.id).find((item) =>
        item.created_on_branch === input.branch && item.worktree_path === worktreePath) ?? null;
    }
    if (!conversation) {
      const preset = this.presets.get(project.default_preset_id ?? "builtin-eco") ?? this.presets.get("builtin-eco")!;
      conversation = this.conversations.create({
        projectId: project.id,
        provider: preset.provider,
        model: preset.model,
        presetId: preset.id,
        effort: preset.effort,
        speed: preset.speed,
        permissionMode: preset.permission_mode,
        orchestrator: preset.orchestrator,
        subagentPresetId: preset.subagent_preset_id,
        subagentEffort: preset.subagent_effort,
        worktreePath,
        createdOnBranch: input.branch,
        firstMessage: prompt,
      });
    }
    if (this.runner.activity.isBusy(conversation.id)) throw new Error("conversation occupée");
    const imageNames: string[] = [];
    for (const annotation of input.annotations) {
      for (const [kind, dataUrl] of [["zone", annotation.cropDataUrl], ["viewport", annotation.viewportDataUrl]] as const) {
        const bytes = decodeImage(dataUrl);
        if (bytes) imageNames.push(this.media.importBytes(bytes, `${kind}-${annotation.number}.png`));
      }
    }
    this.db.query("INSERT INTO visual_feedback_submissions (submission_id, project_id, conversation_id, created_at) VALUES (?, ?, ?, ?)")
      .run(input.submissionId, project.id, conversation.id, new Date().toISOString());
    void this.runner.runTurn(conversation.id, prompt, imageNames).catch((error) => console.error("Échec retour visuel", error));
    return { conversationId: conversation.id, projectId: project.id };
  }
}
