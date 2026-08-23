import type { Database } from "bun:sqlite";
import type { Conversation } from "./conversations";

export type DomainKind = "métier" | "technique";
export type DomainStatus = "actif" | "proposé";
export type DomainOrigin = "auto" | "manuel";

export interface Domain {
  id: string;
  project_id: string;
  name: string;
  kind: DomainKind;
  status: DomainStatus;
  created_at: string;
  updated_at: string;
}

export interface ConversationDomain extends Domain {
  origin: DomainOrigin;
  associated_at: string;
}

export interface DigestDomainSuggestion {
  name: string;
  kind: DomainKind;
}

export type ConversationWithDomains<T extends Conversation = Conversation> = T & {
  domains: Array<Pick<ConversationDomain, "id" | "name" | "kind" | "origin">>;
};

export class DomainConflictError extends Error {
  constructor(message = "un domaine de ce nom existe déjà") {
    super(message);
    this.name = "DomainConflictError";
  }
}

export class DomainProtectedError extends Error {
  constructor(message = "domaine encore associé à des conversations") {
    super(message);
    this.name = "DomainProtectedError";
  }
}

export class DomainNotFoundError extends Error {
  constructor(message = "domaine inconnu") {
    super(message);
    this.name = "DomainNotFoundError";
  }
}

const NAME_MAX = 48;
const DIGEST_MAX = 2;
const METIER_HINT = /match|onboard|auth|wishlist|instagram|billing|paiement|affiliate/i;

export function kindFromName(name: string): DomainKind {
  return METIER_HINT.test(name) ? "métier" : "technique";
}

export function suggestionsFromLabels(
  labels: unknown,
  knownDomainNames: string[] = [],
): DigestDomainSuggestion[] {
  if (!Array.isArray(labels)) return [];
  const known = new Map(knownDomainNames.map((name) => [normalizeDomainName(name).toLowerCase(), name]));
  const suggestions: DigestDomainSuggestion[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (typeof label !== "string") continue;
    const key = normalizeDomainName(label).toLowerCase();
    const name = known.get(key);
    if (!name) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ name, kind: kindFromName(name) });
  }
  return suggestions;
}

export function suggestionsFromSkills(
  _skills: Array<{ name: string; project_id: string | null; provenance: string }>,
  _projectId: string,
): DigestDomainSuggestion[] {
  return [];
}

export function normalizeDomainName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
}

export function isDomainKind(value: unknown): value is DomainKind {
  return value === "métier" || value === "technique";
}

export function isDomainStatus(value: unknown): value is DomainStatus {
  return value === "actif" || value === "proposé";
}

export class DomainStore {
  constructor(private db: Database) {}

  get(id: string): Domain | null {
    const row = this.db.query("SELECT * FROM domains WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? hydrateDomain(row) : null;
  }

  findByName(projectId: string, name: string): Domain | null {
    const normalized = normalizeDomainName(name);
    if (!normalized) return null;
    const row = this.db.query(
      "SELECT * FROM domains WHERE project_id = ? AND name = ? COLLATE NOCASE",
    ).get(projectId, normalized) as Record<string, unknown> | null;
    return row ? hydrateDomain(row) : null;
  }

  listByProject(projectId: string): Domain[] {
    return (this.db.query(
      "SELECT * FROM domains WHERE project_id = ? ORDER BY status, name COLLATE NOCASE",
    ).all(projectId) as Record<string, unknown>[]).map(hydrateDomain);
  }

  create(projectId: string, input: { name: string; kind: DomainKind; status: DomainStatus }): Domain {
    const name = normalizeDomainName(input.name);
    if (!name) throw new Error("nom de domaine vide");
    if (!isDomainKind(input.kind)) throw new Error("kind de domaine invalide");
    if (!isDomainStatus(input.status)) throw new Error("statut de domaine invalide");
    if (this.findByName(projectId, name)) throw new DomainConflictError();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.query(
      `INSERT INTO domains (id, project_id, name, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, name, input.kind, input.status, now, now);
    return this.get(id)!;
  }

  proposeMany(projectId: string, items: DigestDomainSuggestion[]): Domain[] {
    const seen = new Set<string>();
    const result: Domain[] = [];
    for (const item of items) {
      const name = normalizeDomainName(item.name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = this.findByName(projectId, name);
      if (existing) {
        result.push(existing);
        continue;
      }
      result.push(this.create(projectId, {
        name,
        kind: isDomainKind(item.kind) ? item.kind : "technique",
        status: "proposé",
      }));
    }
    return result;
  }

  validate(id: string): Domain {
    const domain = this.require(id);
    if (domain.status === "actif") return domain;
    const now = new Date().toISOString();
    this.db.query("UPDATE domains SET status = 'actif', updated_at = ? WHERE id = ?").run(now, id);
    return this.get(id)!;
  }

  rename(id: string, input: { name?: string; kind?: DomainKind }): Domain {
    const domain = this.require(id);
    const name = input.name === undefined ? domain.name : normalizeDomainName(input.name);
    if (!name) throw new Error("nom de domaine vide");
    const kind = input.kind ?? domain.kind;
    if (!isDomainKind(kind)) throw new Error("kind de domaine invalide");
    const clash = this.findByName(domain.project_id, name);
    if (clash && clash.id !== id) throw new DomainConflictError();
    const now = new Date().toISOString();
    this.db.query("UPDATE domains SET name = ?, kind = ?, updated_at = ? WHERE id = ?")
      .run(name, kind, now, id);
    return this.get(id)!;
  }

  merge(sourceId: string, targetId: string): Domain {
    if (sourceId === targetId) throw new Error("fusion d'un domaine avec lui-même");
    const source = this.require(sourceId);
    const target = this.require(targetId);
    if (source.project_id !== target.project_id) throw new Error("fusion inter-projets interdite");
    this.db.transaction(() => {
      this.db.query(`
        INSERT OR IGNORE INTO conversation_domains (conversation_id, domain_id, origin, created_at)
        SELECT conversation_id, ?, origin, created_at
          FROM conversation_domains
         WHERE domain_id = ?
      `).run(targetId, sourceId);
      this.db.query("DELETE FROM conversation_domains WHERE domain_id = ?").run(sourceId);
      this.db.query("DELETE FROM domains WHERE id = ?").run(sourceId);
    })();
    return this.get(targetId)!;
  }

  remove(id: string): boolean {
    this.require(id);
    const count = (this.db.query(
      "SELECT COUNT(*) AS n FROM conversation_domains WHERE domain_id = ?",
    ).get(id) as { n: number }).n;
    if (count > 0) throw new DomainProtectedError();
    return this.db.query("DELETE FROM domains WHERE id = ?").run(id).changes > 0;
  }

  associate(conversationId: string, domainId: string, origin: DomainOrigin): void {
    this.require(domainId);
    this.db.query(`
      INSERT INTO conversation_domains (conversation_id, domain_id, origin, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, domain_id) DO NOTHING
    `).run(conversationId, domainId, origin, new Date().toISOString());
  }

  dissociate(conversationId: string, domainId: string): boolean {
    return this.db.query(
      "DELETE FROM conversation_domains WHERE conversation_id = ? AND domain_id = ?",
    ).run(conversationId, domainId).changes > 0;
  }

  forConversation(conversationId: string, options: { visibleOnly?: boolean } = {}): ConversationDomain[] {
    const rows = this.db.query(`
      SELECT d.*, cd.origin, cd.created_at AS associated_at
        FROM conversation_domains cd
        INNER JOIN domains d ON d.id = cd.domain_id
       WHERE cd.conversation_id = ?
       ORDER BY d.name COLLATE NOCASE
    `).all(conversationId) as Record<string, unknown>[];
    const items = rows.map(hydrateConversationDomain);
    return options.visibleOnly ? items.filter((domain) => domain.status === "actif") : items;
  }

  conversationIdsFor(domainId: string): string[] {
    return (this.db.query(
      "SELECT conversation_id FROM conversation_domains WHERE domain_id = ? ORDER BY created_at",
    ).all(domainId) as Array<{ conversation_id: string }>).map((row) => row.conversation_id);
  }

  applyDigestSuggestions(
    conversationId: string,
    projectId: string,
    suggestions: DigestDomainSuggestion[],
  ): Domain[] {
    const unique: DigestDomainSuggestion[] = [];
    const seen = new Set<string>();
    for (const suggestion of suggestions) {
      const name = normalizeDomainName(suggestion.name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({
        name,
        kind: isDomainKind(suggestion.kind) ? suggestion.kind : "technique",
      });
      if (unique.length >= DIGEST_MAX) break;
    }
    const applied: Domain[] = [];
    for (const suggestion of unique) {
      const domain = this.findByName(projectId, suggestion.name)
        ?? this.create(projectId, { name: suggestion.name, kind: suggestion.kind, status: "proposé" });
      this.associate(conversationId, domain.id, "auto");
      applied.push(this.get(domain.id)!);
    }
    return applied;
  }

  decorateConversations<T extends Conversation>(conversations: T[]): ConversationWithDomains<T>[] {
    if (conversations.length === 0) return [];
    const ids = conversations.map((conversation) => conversation.id);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.query(`
      SELECT cd.conversation_id, d.id, d.name, d.kind, cd.origin
        FROM conversation_domains cd
        INNER JOIN domains d ON d.id = cd.domain_id
       WHERE cd.conversation_id IN (${placeholders}) AND d.status = 'actif'
       ORDER BY d.name COLLATE NOCASE
    `).all(...ids) as Array<{
      conversation_id: string;
      id: string;
      name: string;
      kind: DomainKind;
      origin: DomainOrigin;
    }>;
    const byConversation = new Map<string, Array<Pick<ConversationDomain, "id" | "name" | "kind" | "origin">>>();
    for (const row of rows) {
      const list = byConversation.get(row.conversation_id) ?? [];
      list.push({ id: row.id, name: row.name, kind: row.kind, origin: row.origin });
      byConversation.set(row.conversation_id, list);
    }
    return conversations.map((conversation) => ({
      ...conversation,
      domains: byConversation.get(conversation.id) ?? [],
    }));
  }

  private require(id: string): Domain {
    const domain = this.get(id);
    if (!domain) throw new DomainNotFoundError();
    return domain;
  }
}

function hydrateDomain(row: Record<string, unknown>): Domain {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    name: String(row.name),
    kind: row.kind as DomainKind,
    status: row.status as DomainStatus,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function hydrateConversationDomain(row: Record<string, unknown>): ConversationDomain {
  return {
    ...hydrateDomain(row),
    origin: row.origin as DomainOrigin,
    associated_at: String(row.associated_at),
  };
}
