import type { Database } from "bun:sqlite";

export type ChangeNature = "ajout" | "modification" | "correction" | "retrait";

export interface ChangeProposal {
  id: string;
  groupId: string;
  domainId: string;
  domainName: string;
  nature: ChangeNature;
  title: string;
  description: string;
  impact: string;
  evidence: string[];
  ambiguous: boolean;
  selected: boolean;
}

export interface ChangelogReview {
  id: string;
  conversationId: string;
  summaryId: string;
  eventIdFrom: number;
  eventIdTo: number;
  status: "proposé" | "publié";
  changes: ChangeProposal[];
  createdAt: string;
  publishedAt: string | null;
}

export class ChangelogStore {
  constructor(private db: Database) {}

  create(input: Omit<ChangelogReview, "id" | "status" | "createdAt" | "publishedAt">): ChangelogReview {
    const review: ChangelogReview = {
      ...input,
      id: crypto.randomUUID(),
      status: "proposé",
      createdAt: new Date().toISOString(),
      publishedAt: null,
    };
    this.db.query(`
      INSERT INTO changelog_reviews
        (id, conversation_id, summary_id, event_id_from, event_id_to, status, changes_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(review.id, review.conversationId, review.summaryId, review.eventIdFrom,
      review.eventIdTo, review.status, JSON.stringify(review.changes), review.createdAt);
    return review;
  }

  get(id: string): ChangelogReview | null {
    const row = this.db.query("SELECT * FROM changelog_reviews WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? hydrateReview(row) : null;
  }

  getBySummary(summaryId: string): ChangelogReview | null {
    const row = this.db.query("SELECT * FROM changelog_reviews WHERE summary_id = ?").get(summaryId) as Record<string, unknown> | null;
    return row ? hydrateReview(row) : null;
  }

  listByProject(projectId: string, domainId?: string): Array<Record<string, unknown>> {
    const rows = this.db.query(`
      SELECT dc.*, d.name AS domain_name, cr.conversation_id
      FROM domain_changes dc
      JOIN domains d ON d.id = dc.domain_id
      JOIN changelog_reviews cr ON cr.id = dc.review_id
      WHERE d.project_id = ? AND (? IS NULL OR dc.domain_id = ?)
      ORDER BY dc.created_at DESC, dc.id DESC
    `).all(projectId, domainId ?? null, domainId ?? null) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, evidence: JSON.parse(String(row.evidence_json)) }));
  }

  publish(reviewId: string, changes: ChangeProposal[]): void {
    const review = this.get(reviewId);
    if (!review) throw new Error("validation changelog inconnue");
    if (review.status === "publié") return;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const change of changes) {
        this.db.query(`
          INSERT OR IGNORE INTO domain_changes
            (id, group_id, review_id, domain_id, nature, title, description, impact, evidence_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(change.id, change.groupId, reviewId, change.domainId, change.nature,
          change.title, change.description, change.impact, JSON.stringify(change.evidence), now);
      }
      this.db.query("UPDATE changelog_reviews SET status = 'publié', changes_json = ?, published_at = ? WHERE id = ?")
        .run(JSON.stringify(changes), now, reviewId);
    })();
  }

  publication(domainId: string): { skill_root: string; skill_sha256: string | null } | null {
    return this.db.query("SELECT skill_root, skill_sha256 FROM domain_publications WHERE domain_id = ?")
      .get(domainId) as { skill_root: string; skill_sha256: string | null } | null;
  }

  savePublication(domainId: string, root: string, sha: string): void {
    this.db.query(`
      INSERT INTO domain_publications (domain_id, skill_root, skill_sha256, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(domain_id) DO UPDATE SET skill_root = excluded.skill_root,
        skill_sha256 = excluded.skill_sha256, updated_at = excluded.updated_at
    `).run(domainId, root, sha, new Date().toISOString());
  }
}

function hydrateReview(row: Record<string, unknown>): ChangelogReview {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    summaryId: String(row.summary_id),
    eventIdFrom: Number(row.event_id_from),
    eventIdTo: Number(row.event_id_to),
    status: row.status as ChangelogReview["status"],
    changes: JSON.parse(String(row.changes_json)) as ChangeProposal[],
    createdAt: String(row.created_at),
    publishedAt: row.published_at === null ? null : String(row.published_at),
  };
}
