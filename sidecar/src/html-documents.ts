import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { AppEvent, StoredEvent } from "./events";
import type { ConversationStore } from "./stores/conversations";
import type { ProjectStore } from "./stores/projects";

const DEFAULT_HTML_MAX_BYTES = 2 * 1024 * 1024;
// Aligné sur la limite d'une pièce jointe : tout PDF accepté peut ainsi être
// réinjecté dans une nouvelle conversation sans second échec de taille.
const DEFAULT_PDF_MAX_BYTES = 10 * 1024 * 1024;
const VIEW_TOKEN_TTL_MS = 60_000;

export type DocumentKind = "html" | "pdf";
export type HtmlDocumentState = "available" | "retained" | "expired" | "deleted";

interface HtmlDocumentRow {
  id: string;
  conversation_id: string;
  title: string;
  summary: string | null;
  relative_path: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  expires_at: string | null;
  retained_at: string | null;
  expired_at: string | null;
  deleted_at: string | null;
  kind: DocumentKind;
  mime_type: string;
  original_name: string;
  conversation_title?: string;
  project_id?: string;
  project_name?: string;
  search_snippet?: string | null;
  search_body?: string | null;
  search_query?: string | null;
}

export interface HtmlDocumentSnapshot {
  id: string;
  conversationId: string;
  conversationTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  summary: string | null;
  kind: DocumentKind;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string | null;
  retainedAt: string | null;
  expiredAt: string | null;
  deletedAt: string | null;
  state: HtmlDocumentState;
  searchSnippet: string | null;
  matchCount: number;
}

export interface PublishHtmlDocumentInput {
  path: string;
  title: string;
  summary?: string | null;
  deleteSource?: boolean;
}

export interface ListDocumentsInput {
  projectId?: string;
  query?: string;
  kind?: DocumentKind;
  state?: "active" | "retained" | "available";
}

export type HtmlDocumentErrorCode =
  | "conversation-not-found" | "document-not-found" | "source-outside-allowed-roots"
  | "source-not-found" | "source-invalid" | "source-empty" | "source-too-large"
  | "source-not-html" | "source-not-pdf" | "document-unavailable" | "view-token-invalid";

export class HtmlDocumentError extends Error {
  constructor(readonly code: HtmlDocumentErrorCode, message: string) {
    super(message);
    this.name = "HtmlDocumentError";
  }
}

interface ViewToken { documentId: string; expiresAt: number }
type BroadcastFn = (conversationId: string, event: StoredEvent) => void;

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isInside(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function temporaryRoots(): string[] {
  const candidates = [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])];
  return [...new Set(candidates.flatMap((candidate) => {
    try { return [realpathSync(candidate)]; } catch { return []; }
  }))];
}

function stateOf(row: HtmlDocumentRow, nowMs: number): HtmlDocumentState {
  if (row.deleted_at !== null) return "deleted";
  if (row.expired_at !== null) return "expired";
  if (row.retained_at !== null || row.expires_at === null) return "retained";
  return Date.parse(row.expires_at) <= nowMs ? "expired" : "available";
}

function snapshot(row: HtmlDocumentRow, nowMs: number): HtmlDocumentSnapshot {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title ?? null,
    projectId: row.project_id ?? null,
    projectName: row.project_name ?? null,
    title: row.title,
    summary: row.summary,
    kind: row.kind ?? "html",
    mimeType: row.mime_type ?? "text/html",
    originalName: row.original_name ?? (row.kind === "pdf" ? "document.pdf" : "index.html"),
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    retainedAt: row.retained_at,
    expiredAt: row.expired_at,
    deletedAt: row.deleted_at,
    state: stateOf(row, nowMs),
    searchSnippet: row.search_snippet ?? null,
    matchCount: row.search_body ? countMatches(row.search_body, row.search_query ?? "") : 0,
  };
}

function plainTextFromHtml(content: string): string {
  const withoutNoise = content
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return withoutNoise
    .replace(/&#(x?[0-9a-f]+);/gi, (_match, value: string) => {
      const codePoint = value[0]?.toLowerCase() === "x"
        ? Number.parseInt(value.slice(1), 16)
        : Number.parseInt(value, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => ({
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    })[entity.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function plainTextFromPdf(bytes: Uint8Array): Promise<string> {
  // pdfjs initialise ses primitives graphiques au chargement, même pour une extraction
  // de texte ; Bun compilé n'expose pas DOMMatrix et ne doit pas empêcher le sidecar de démarrer.
  if (!("DOMMatrix" in globalThis)) {
    Object.assign(globalThis, { DOMMatrix: class DOMMatrix {} });
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: bytes, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
    }
    return pages.join("\n").replace(/[ \t]+/g, " ").trim();
  } finally {
    await task.destroy();
  }
}

function ftsQuery(value: string): string {
  return value.normalize("NFKC").split(/\s+/).filter(Boolean).slice(0, 12)
    .map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function countMatches(body: string, query: string): number {
  const tokens = query.toLocaleLowerCase("fr-FR").split(/\s+/).filter((token) => token.length > 1);
  if (tokens.length === 0) return 0;
  const normalized = body.toLocaleLowerCase("fr-FR");
  return tokens.reduce((count, token) => {
    let cursor = 0;
    let matches = 0;
    while ((cursor = normalized.indexOf(token, cursor)) >= 0) {
      matches += 1;
      cursor += token.length;
    }
    return count + matches;
  }, 0);
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

export class HtmlDocumentService {
  private readonly directory: string;
  private readonly viewTokens = new Map<string, ViewToken>();
  private readonly indexReady: Promise<void>;

  constructor(
    private readonly db: Database,
    dataDirectory: string,
    private readonly conversations: ConversationStore,
    private readonly projects: ProjectStore,
    private readonly broadcast: BroadcastFn,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.directory = join(dataDirectory, "documents");
    mkdirSync(this.directory, { recursive: true });
    const legacyDirectory = join(dataDirectory, "html-documents");
    if (existsSync(legacyDirectory)) {
      const rows = this.db.query("SELECT id FROM documents").all() as Array<{ id: string }>;
      for (const { id } of rows) {
        const source = join(legacyDirectory, id);
        const destination = join(this.directory, id);
        if (existsSync(source) && !existsSync(destination)) renameSync(source, destination);
      }
      try { rmSync(legacyDirectory, { recursive: false }); } catch { /* dossier non vide : conservation prudente */ }
    }
    this.indexReady = this.reindexMissing();
  }

  async publish(conversationId: string, input: PublishHtmlDocumentInput): Promise<HtmlDocumentSnapshot> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new HtmlDocumentError("conversation-not-found", "conversation inconnue");
    const project = this.projects.get(conversation.project_id);
    if (!project) throw new HtmlDocumentError("conversation-not-found", "projet de la conversation inconnu");

    const sourcePath = this.validatedSourcePath(input.path, project.path);
    let info: ReturnType<typeof statSync>;
    try { info = statSync(sourcePath); } catch {
      throw new HtmlDocumentError("source-not-found", "document introuvable");
    }
    if (!info.isFile()) throw new HtmlDocumentError("source-invalid", "le chemin ne désigne pas un fichier");
    if (info.size === 0) throw new HtmlDocumentError("source-empty", "document vide");

    const extension = extname(sourcePath).toLowerCase();
    const kind: DocumentKind = extension === ".pdf" ? "pdf" : "html";
    if (![".html", ".htm", ".pdf"].includes(extension)) {
      throw new HtmlDocumentError("source-invalid", "extension attendue : .html, .htm ou .pdf");
    }
    const maxBytes = kind === "pdf"
      ? numberFromEnv("PUPITRE_PDF_DOCUMENT_MAX_BYTES", DEFAULT_PDF_MAX_BYTES)
      : numberFromEnv("PUPITRE_HTML_DOCUMENT_MAX_BYTES", DEFAULT_HTML_MAX_BYTES);
    if (info.size > maxBytes) {
      throw new HtmlDocumentError("source-too-large", `document trop volumineux (${info.size} octets, maximum ${maxBytes})`);
    }

    const bytes = readFileSync(sourcePath);
    if (kind === "html") {
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
        throw new HtmlDocumentError("source-not-html", "le document HTML doit être encodé en UTF-8");
      }
      if (content.includes("\0") || !/<(?:!doctype\s+html|html|head|body)\b/i.test(content)) {
        throw new HtmlDocumentError("source-not-html", "contenu HTML autonome attendu");
      }
    } else if (bytes.subarray(0, 5).toString() !== "%PDF-") {
      throw new HtmlDocumentError("source-not-pdf", "fichier PDF valide attendu");
    }

    const title = input.title.trim().slice(0, 160) || basename(sourcePath);
    const summary = input.summary?.trim().slice(0, 500) || null;
    const id = crypto.randomUUID();
    const storedName = kind === "pdf" ? "document.pdf" : "index.html";
    const relativePath = join(id, storedName);
    const documentDirectory = join(this.directory, id);
    const temporaryPath = join(documentDirectory, `${storedName}.pending`);
    const destinationPath = join(this.directory, relativePath);
    const createdAt = this.now();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mimeType = kind === "pdf" ? "application/pdf" : "text/html";

    let storedEvent: StoredEvent | null = null;
    mkdirSync(documentDirectory, { recursive: false });
    try {
      writeFileSync(temporaryPath, bytes, { flag: "wx" });
      renameSync(temporaryPath, destinationPath);
      this.db.query(`
        INSERT INTO documents
          (id, conversation_id, project_id, conversation_title, project_name,
           title, summary, relative_path, size_bytes, sha256, created_at,
           expires_at, retained_at, kind, mime_type, original_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(id, conversationId, project.id, conversation.title, project.name,
        title, summary, relativePath, info.size, sha256, createdAt.toISOString(),
        createdAt.toISOString(), kind, mimeType, basename(sourcePath));

      const shared = {
        documentId: id, title, ...(summary === null ? {} : { summary }),
        originalName: basename(sourcePath), sizeBytes: info.size,
        createdAt: createdAt.toISOString(), expiresAt: null,
      };
      const event: AppEvent = kind === "html"
        ? { type: "html-document-ref", ...shared, kind: "html", mimeType: "text/html" }
        : { type: "document-ref", ...shared, kind: "pdf", mimeType: "application/pdf" };
      const eventId = this.conversations.appendEvent(conversationId, event);
      storedEvent = { ...event, id: eventId };
    } catch (error) {
      this.db.query("DELETE FROM documents WHERE id = ?").run(id);
      rmSync(documentDirectory, { recursive: true, force: true });
      throw error;
    }
    try { this.broadcast(conversationId, storedEvent!); } catch (error) {
      console.error("Diffusion du document impossible", error);
    }
    if (input.deleteSource && temporaryRoots().some((root) => isInside(root, sourcePath)) && !isInside(project.path, sourcePath)) {
      try { unlinkSync(sourcePath); } catch (error) { console.error("Suppression de la source temporaire impossible", error); }
    }
    try {
      await this.indexDocument(id, kind, bytes);
    } catch (error) {
      console.error(`Indexation du document ${id} impossible`, error);
    }
    return this.get(id)!;
  }

  async list(input: ListDocumentsInput = {}): Promise<HtmlDocumentSnapshot[]> {
    await this.indexReady;
    const clauses = ["d.deleted_at IS NULL", "d.expired_at IS NULL"];
    const values: string[] = [];
    if (input.projectId) { clauses.push("d.project_id = ?"); values.push(input.projectId); }
    if (input.kind) { clauses.push("d.kind = ?"); values.push(input.kind); }
    if (input.state === "retained") clauses.push("d.retained_at IS NOT NULL");
    if (input.state === "available") clauses.push("d.retained_at IS NULL AND d.expires_at > ?"), values.push(this.now().toISOString());
    let searchJoin = "";
    let searchSelect = "NULL AS search_snippet, NULL AS search_body, NULL AS search_query";
    if (input.query?.trim()) {
      searchJoin = "JOIN documents_fts ON documents_fts.document_id = d.id";
      clauses.push("documents_fts MATCH ?");
      values.push(ftsQuery(input.query));
      searchSelect = "snippet(documents_fts, 5, '<mark>', '</mark>', ' … ', 24) AS search_snippet, documents_fts.body AS search_body, ? AS search_query";
      values.unshift(input.query.trim());
    }
    const rows = this.db.query(`
      SELECT d.*, ${searchSelect}
      FROM documents d
      ${searchJoin}
      WHERE ${clauses.join(" AND ")}
      ORDER BY d.created_at DESC
      LIMIT 250
    `).all(...values) as HtmlDocumentRow[];
    return rows.map((row) => snapshot(row, this.now().getTime()));
  }

  get(id: string): HtmlDocumentSnapshot | null {
    const row = this.row(id);
    if (!row) return null;
    if (stateOf(row, this.now().getTime()) === "expired" && row.expired_at === null) {
      this.expireRow(row, this.now().toISOString());
      return snapshot(this.row(id)!, this.now().getTime());
    }
    return snapshot(row, this.now().getTime());
  }

  retain(id: string): HtmlDocumentSnapshot {
    const current = this.requireAvailable(id);
    if (current.state === "retained") return current;
    this.db.query(`UPDATE documents SET retained_at = ?, expires_at = NULL
      WHERE id = ? AND expired_at IS NULL AND deleted_at IS NULL`).run(this.now().toISOString(), id);
    return this.get(id)!;
  }

  delete(id: string): HtmlDocumentSnapshot {
    const row = this.row(id);
    if (!row) throw new HtmlDocumentError("document-not-found", "document inconnu");
    if (row.deleted_at === null) {
      this.db.query("UPDATE documents SET deleted_at = ? WHERE id = ?").run(this.now().toISOString(), id);
      this.db.query("DELETE FROM documents_fts WHERE document_id = ?").run(id);
      this.removeContent(row);
      this.revokeTokens(id);
    }
    return this.get(id)!;
  }

  deleteByConversation(conversationId: string): number {
    // Les documents appartiennent désormais à la bibliothèque, pas au cycle
    // de vie du fil source. Méthode conservée pour les anciens appelants.
    void conversationId;
    return 0;
  }

  issueViewToken(id: string): { token: string; expiresAt: string } {
    this.requireAvailable(id);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = this.now().getTime() + VIEW_TOKEN_TTL_MS;
    this.viewTokens.set(token, { documentId: id, expiresAt });
    this.pruneTokens();
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  content(id: string, token: string): { path: string; mimeType: string; originalName: string; kind: DocumentKind } {
    const grant = this.viewTokens.get(token);
    if (!grant || grant.documentId !== id || grant.expiresAt <= this.now().getTime()) {
      this.viewTokens.delete(token);
      throw new HtmlDocumentError("view-token-invalid", "jeton d’aperçu invalide ou expiré");
    }
    const current = this.requireAvailable(id);
    const row = this.row(current.id)!;
    return { path: join(this.directory, row.relative_path), mimeType: current.mimeType, originalName: current.originalName, kind: current.kind };
  }

  contentPath(id: string, token: string): string { return this.content(id, token).path; }

  sweepExpired(): number {
    const now = this.now().toISOString();
    const rows = this.db.query(`SELECT * FROM documents WHERE expires_at IS NOT NULL AND expires_at <= ?
      AND retained_at IS NULL AND expired_at IS NULL AND deleted_at IS NULL`).all(now) as HtmlDocumentRow[];
    for (const row of rows) this.expireRow(row, now);
    this.pruneTokens();
    return rows.length;
  }

  thumbnail(id: string): { path: string; mimeType: string } {
    const current = this.requireAvailable(id);
    const row = this.row(id)!;
    const documentDirectory = join(this.directory, id);
    const pngPath = join(documentDirectory, "thumbnail.png");
    const svgPath = join(documentDirectory, "thumbnail.svg");
    if (existsSync(pngPath)) return { path: pngPath, mimeType: "image/png" };
    if (existsSync(svgPath)) return { path: svgPath, mimeType: "image/svg+xml" };

    if (current.kind === "pdf") {
      const pdftoppm = [
        process.env.PUPITRE_PDFTOPPM_BIN,
        "/usr/bin/pdftoppm",
        "/usr/local/bin/pdftoppm",
      ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
      if (pdftoppm) {
        const pendingPrefix = join(documentDirectory, "thumbnail.pending");
        const pendingPath = `${pendingPrefix}.png`;
        const result = spawnSync(pdftoppm, [
          "-png", "-f", "1", "-singlefile", "-scale-to-x", "640", "-scale-to-y", "-1",
          join(this.directory, row.relative_path), pendingPrefix,
        ], { timeout: 15_000, stdio: "ignore" });
        if (result.status === 0 && existsSync(pendingPath) && statSync(pendingPath).size > 0) {
          renameSync(pendingPath, pngPath);
          return { path: pngPath, mimeType: "image/png" };
        }
        rmSync(pendingPath, { force: true });
      }
    }

    const chrome = [
      process.env.PUPITRE_CHROME_BIN,
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    if (chrome && current.kind === "html") {
      const pendingPath = join(documentDirectory, "thumbnail.pending.png");
      const profilePath = join(documentDirectory, ".thumbnail-profile");
      const result = spawnSync(chrome, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--host-resolver-rules=MAP * 0.0.0.0",
        `--user-data-dir=${profilePath}`,
        "--window-size=640,400",
        "--virtual-time-budget=1800",
        `--screenshot=${pendingPath}`,
        pathToFileURL(join(this.directory, row.relative_path)).href,
      ], { timeout: 15_000, stdio: "ignore" });
      rmSync(profilePath, { recursive: true, force: true });
      if (result.status === 0 && existsSync(pendingPath) && statSync(pendingPath).size > 0) {
        renameSync(pendingPath, pngPath);
        return { path: pngPath, mimeType: "image/png" };
      }
      rmSync(pendingPath, { force: true });
    }

    const label = current.kind.toUpperCase();
    const title = xmlEscape(current.title.slice(0, 64));
    const project = xmlEscape((current.projectName ?? "Pupitre").slice(0, 48));
    writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
      <rect width="640" height="400" fill="#1c1e23"/>
      <rect x="0" y="0" width="7" height="400" fill="${current.kind === "pdf" ? "#e87979" : "#8b7cff"}"/>
      <text x="46" y="64" fill="#b5b2bd" font-family="sans-serif" font-size="18" font-weight="700">${label}</text>
      <text x="46" y="146" fill="#fbf9fd" font-family="sans-serif" font-size="30" font-weight="700">${title}</text>
      <text x="46" y="350" fill="#898691" font-family="sans-serif" font-size="17">${project}</text>
    </svg>`);
    return { path: svgPath, mimeType: "image/svg+xml" };
  }

  exportTo(id: string, targetPath: string): { path: string; sizeBytes: number } {
    const current = this.requireAvailable(id);
    if (!isAbsolute(targetPath.trim())) {
      throw new HtmlDocumentError("source-invalid", "un chemin de destination absolu est requis");
    }
    const parent = dirname(resolve(targetPath));
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new HtmlDocumentError("source-invalid", "le dossier de destination n’existe pas");
    }
    const row = this.row(id)!;
    const destination = resolve(targetPath);
    copyFileSync(join(this.directory, row.relative_path), destination);
    return { path: destination, sizeBytes: current.sizeBytes };
  }

  private async reindexMissing(): Promise<void> {
    const rows = this.db.query(`
      SELECT d.* FROM documents d
      LEFT JOIN documents_fts f ON f.document_id = d.id
      WHERE d.deleted_at IS NULL AND d.expired_at IS NULL AND f.document_id IS NULL
    `).all() as HtmlDocumentRow[];
    for (const row of rows) {
      const path = join(this.directory, row.relative_path);
      if (!existsSync(path)) continue;
      try {
        await this.indexDocument(row.id, row.kind, readFileSync(path));
      } catch (error) {
        console.error(`Indexation du document ${row.id} impossible`, error);
      }
    }
  }

  private async indexDocument(id: string, kind: DocumentKind, bytes: Uint8Array): Promise<void> {
    const row = this.row(id);
    if (!row) return;
    const body = kind === "html"
      ? plainTextFromHtml(new TextDecoder().decode(bytes))
      : await plainTextFromPdf(new Uint8Array(bytes));
    const transaction = this.db.transaction(() => {
      this.db.query("DELETE FROM documents_fts WHERE document_id = ?").run(id);
      this.db.query(`INSERT INTO documents_fts
        (document_id, title, summary, project_name, conversation_title, body)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, row.title, row.summary ?? "", row.project_name ?? "", row.conversation_title ?? "", body);
    });
    transaction();
  }

  private validatedSourcePath(value: string, projectPath: string): string {
    const requested = value.trim();
    if (!requested || !isAbsolute(requested)) throw new HtmlDocumentError("source-invalid", "un chemin absolu est requis");
    let sourcePath: string;
    try { sourcePath = realpathSync(requested); } catch { throw new HtmlDocumentError("source-not-found", "document introuvable"); }
    const allowedRoots = temporaryRoots();
    try { allowedRoots.push(realpathSync(projectPath)); } catch { /* projet déjà validé par le store */ }
    if (!allowedRoots.some((root) => isInside(root, sourcePath))) {
      throw new HtmlDocumentError("source-outside-allowed-roots", "le document doit se trouver dans le projet ou le répertoire temporaire");
    }
    return sourcePath;
  }

  private requireAvailable(id: string): HtmlDocumentSnapshot {
    const current = this.get(id);
    if (!current) throw new HtmlDocumentError("document-not-found", "document inconnu");
    if (current.state === "expired" || current.state === "deleted") throw new HtmlDocumentError("document-unavailable", "document expiré ou supprimé");
    return current;
  }

  private row(id: string): HtmlDocumentRow | null {
    return this.db.query("SELECT * FROM documents WHERE id = ?").get(id) as HtmlDocumentRow | null;
  }

  private expireRow(row: HtmlDocumentRow, expiredAt: string): void {
    this.db.query(`UPDATE documents SET expired_at = ? WHERE id = ? AND retained_at IS NULL
      AND expired_at IS NULL AND deleted_at IS NULL`).run(expiredAt, row.id);
    this.removeContent(row);
    this.revokeTokens(row.id);
  }

  private removeContent(row: HtmlDocumentRow): void {
    const documentDirectory = join(this.directory, row.id);
    if (isInside(this.directory, documentDirectory)) rmSync(documentDirectory, { recursive: true, force: true });
  }

  private revokeTokens(documentId: string): void {
    for (const [token, grant] of this.viewTokens) if (grant.documentId === documentId) this.viewTokens.delete(token);
  }

  private pruneTokens(): void {
    const now = this.now().getTime();
    for (const [token, grant] of this.viewTokens) if (grant.expiresAt <= now) this.viewTokens.delete(token);
  }
}

export type DocumentSnapshot = HtmlDocumentSnapshot;
export type DocumentState = HtmlDocumentState;
export type PublishDocumentInput = PublishHtmlDocumentInput;
export { HtmlDocumentService as DocumentService, HtmlDocumentError as DocumentError };
