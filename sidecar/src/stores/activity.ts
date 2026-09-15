import type { Database } from "bun:sqlite";

export type ActivityMotifKind = "recurrence" | "stabilize" | "practice" | "idea";
export type ActivityMotifStatus = "open" | "stabilized" | "dismissed" | "handled";
export type ActivityEvidenceKind = "conversation" | "commit" | "ticket" | "problem";

export const ACTIVITY_MOTIF_KINDS: ActivityMotifKind[] = ["recurrence", "stabilize", "practice", "idea"];
export const ACTIVITY_EVIDENCE_KINDS: ActivityEvidenceKind[] = ["conversation", "commit", "ticket", "problem"];

export interface ActivityEvidence {
  motif_id: string;
  kind: ActivityEvidenceKind;
  ref: string;
  project_id: string;
  label: string;
  day: string;
  created_at: string;
}

export interface ActivityMotif {
  id: string;
  project_id: string;
  kind: ActivityMotifKind;
  title: string;
  statement: string;
  status: ActivityMotifStatus;
  first_seen_day: string;
  last_seen_day: string;
  /** Renseigné quand un motif écarté est revenu avec des preuves postérieures. */
  returned_at: string | null;
  dismissed_at: string | null;
  todo_id: string | null;
  created_at: string;
  updated_at: string;
  evidence: ActivityEvidence[];
}

export interface ActivityReportTopic {
  title: string;
  detail: string;
  conversationIds: string[];
}

export interface ActivityReportConversation {
  id: string;
  title: string;
  ticketId: string | null;
  ticketKey: string | null;
  /** Jour local du premier tour : « en cours depuis le J » quand il précède le jour du rapport. */
  startedDay: string;
  userMs: number;
  agentMs: number;
  turns: number;
}

export interface ActivityReportCommit {
  sha: string;
  repositoryPath: string;
  branch: string;
  subject: string;
  productMessage: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  committedAt: string;
  conversationId: string | null;
}

export interface ActivityReportTicket {
  id: string;
  key: string;
  title: string;
  externalUrl: string | null;
}

export interface ActivityReportMergeRequest {
  /** `label!iid`, la référence stable du dépôt GitLab. */
  ref: string;
  iid: number;
  project: string;
  title: string;
  url: string;
  state: string;
  ticketKey: string;
  createdAt: string;
}

/** Passage d'un ticket vers un statut « prêt pour la production », relevé par la relève ClickUp. */
export interface ActivityReportTicketReady {
  ticketId: string;
  key: string;
  title: string;
  externalUrl: string | null;
  toStatus: string;
  changedAt: string;
}

export interface ActivityReportTodo {
  id: string;
  title: string;
  ticketId: string | null;
}

export interface ActivityReportProject {
  projectId: string;
  projectName: string;
  userMs: number;
  agentMs: number;
  topics: ActivityReportTopic[];
  topicsSource: "model" | "titles";
  conversations: ActivityReportConversation[];
  commits: ActivityReportCommit[];
  unlinkedCommitCount: number;
  linesAdded: number;
  linesRemoved: number;
  tickets: ActivityReportTicket[];
  mergeRequests: ActivityReportMergeRequest[];
  ticketsReady: ActivityReportTicketReady[];
  todosDone: ActivityReportTodo[];
}

export interface ActivityReportRetro {
  created: string[];
  updated: string[];
  stabilized: string[];
  returned: string[];
  error: string | null;
}

export interface ActivityReport {
  day: string;
  generatedAt: string;
  /** Deux ou trois phrases du modèle bon marché ; absent quand la synthèse a échoué. */
  summary: string | null;
  projects: ActivityReportProject[];
  totals: {
    userMs: number;
    agentMs: number;
    commits: number;
    mergeRequests: number;
    ticketsReady: number;
    linesAdded: number;
    linesRemoved: number;
    conversations: number;
  };
  retro: ActivityReportRetro;
}

export interface ActivityReportSummary {
  day: string;
  generated_at: string;
  projectCount: number;
  commits: number;
  mergeRequests: number;
  ticketsReady: number;
  userMs: number;
}

export interface ActivityState {
  first_day: string | null;
  last_day: string | null;
  last_run_at: string | null;
  last_error: string | null;
}

export class ActivityStore {
  constructor(private db: Database) {}

  saveReport(report: ActivityReport): void {
    this.db.query(`
      INSERT INTO activity_reports (day, generated_at, payload) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET generated_at = excluded.generated_at, payload = excluded.payload
    `).run(report.day, report.generatedAt, JSON.stringify(report));
  }

  report(day: string): ActivityReport | null {
    const row = this.db.query("SELECT payload FROM activity_reports WHERE day = ?")
      .get(day) as { payload: string } | null;
    return row ? JSON.parse(row.payload) as ActivityReport : null;
  }

  deleteReport(day: string): void {
    this.db.query("DELETE FROM activity_reports WHERE day = ?").run(day);
  }

  days(): ActivityReportSummary[] {
    return (this.db.query(`
      SELECT day, generated_at,
             json_array_length(payload, '$.projects') AS project_count,
             json_extract(payload, '$.totals.commits') AS commits,
             COALESCE(json_extract(payload, '$.totals.mergeRequests'), 0) AS merge_requests,
             COALESCE(json_extract(payload, '$.totals.ticketsReady'), 0) AS tickets_ready,
             json_extract(payload, '$.totals.userMs') AS user_ms
      FROM activity_reports ORDER BY day DESC
    `).all() as Array<{
      day: string; generated_at: string; project_count: number | bigint; commits: number | bigint;
      merge_requests: number | bigint; tickets_ready: number | bigint; user_ms: number | bigint;
    }>).map((row) => ({
      day: row.day,
      generated_at: row.generated_at,
      projectCount: Number(row.project_count),
      commits: Number(row.commits),
      mergeRequests: Number(row.merge_requests),
      ticketsReady: Number(row.tickets_ready),
      userMs: Number(row.user_ms),
    }));
  }

  state(): ActivityState {
    const rows = this.db.query("SELECT key, value FROM activity_state").all() as Array<{ key: string; value: string }>;
    const values = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as string | null]));
    return {
      first_day: values.first_day ?? null,
      last_day: values.last_day ?? null,
      last_run_at: values.last_run_at ?? null,
      last_error: values.last_error ?? null,
    };
  }

  setState(patch: Partial<ActivityState>): void {
    const upsert = this.db.query(`
      INSERT INTO activity_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) upsert.run(key, JSON.stringify(value));
      }
    })();
  }

  /** Marque le jour traité en gardant la borne basse la plus ancienne. */
  markProcessed(day: string, runAt: string): void {
    const current = this.state();
    this.setState({
      first_day: current.first_day === null || day < current.first_day ? day : current.first_day,
      last_day: current.last_day === null || day > current.last_day ? day : current.last_day,
      last_run_at: runAt,
      last_error: null,
    });
  }

  motif(id: string): ActivityMotif | null {
    const row = this.db.query("SELECT * FROM activity_motifs WHERE id = ?").get(id) as Omit<ActivityMotif, "evidence"> | null;
    return row ? { ...row, evidence: this.evidence(id) } : null;
  }

  listMotifs(filter: { projectId?: string; statuses?: ActivityMotifStatus[] } = {}): ActivityMotif[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const rows = this.db.query(`
      SELECT * FROM activity_motifs
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY last_seen_day DESC, updated_at DESC
    `).all(...params) as Array<Omit<ActivityMotif, "evidence">>;
    return rows.map((row) => ({ ...row, evidence: this.evidence(row.id) }));
  }

  createMotif(input: {
    projectId: string;
    kind: ActivityMotifKind;
    title: string;
    statement: string;
    day: string;
    evidence: Array<{ kind: ActivityEvidenceKind; ref: string; label: string }>;
  }, now: string): ActivityMotif {
    const id = crypto.randomUUID();
    this.db.transaction(() => {
      this.db.query(`
        INSERT INTO activity_motifs
          (id, project_id, kind, title, statement, status, first_seen_day, last_seen_day, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `).run(id, input.projectId, input.kind, input.title.slice(0, 120), input.statement.slice(0, 1200), input.day, input.day, now, now);
      this.insertEvidence(id, input.projectId, input.day, input.evidence, now);
    })();
    return this.motif(id)!;
  }

  /** Ajoute des preuves ; renvoie le nombre de preuves nouvelles. */
  addEvidence(
    motifId: string,
    day: string,
    evidence: Array<{ kind: ActivityEvidenceKind; ref: string; label: string }>,
    now: string,
  ): number {
    const motif = this.motif(motifId);
    if (!motif) throw new Error("motif inconnu");
    let added = 0;
    this.db.transaction(() => {
      added = this.insertEvidence(motifId, motif.project_id, day, evidence, now);
      if (added > 0) {
        this.db.query("UPDATE activity_motifs SET last_seen_day = MAX(last_seen_day, ?), updated_at = ? WHERE id = ?")
          .run(day, now, motifId);
      }
    })();
    return added;
  }

  updateMotif(id: string, patch: Partial<Pick<ActivityMotif,
    "statement" | "title" | "status" | "returned_at" | "dismissed_at" | "todo_id" | "last_seen_day">>, now: string): ActivityMotif {
    const fields = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (fields.length > 0) {
      this.db.query(`
        UPDATE activity_motifs
        SET ${fields.map(([key]) => `${key} = ?`).join(", ")}, updated_at = ?
        WHERE id = ?
      `).run(...fields.map(([, value]) => value as string | null), now, id);
    }
    const motif = this.motif(id);
    if (!motif) throw new Error("motif inconnu");
    return motif;
  }

  private evidence(motifId: string): ActivityEvidence[] {
    return this.db.query(
      "SELECT * FROM activity_motif_evidence WHERE motif_id = ? ORDER BY created_at ASC, ref ASC",
    ).all(motifId) as ActivityEvidence[];
  }

  private insertEvidence(
    motifId: string,
    projectId: string,
    day: string,
    evidence: Array<{ kind: ActivityEvidenceKind; ref: string; label: string }>,
    now: string,
  ): number {
    const insert = this.db.query(`
      INSERT OR IGNORE INTO activity_motif_evidence (motif_id, kind, ref, project_id, label, day, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let added = 0;
    for (const item of evidence) {
      const result = insert.run(motifId, item.kind, item.ref, projectId, item.label.slice(0, 200), day, now);
      added += Number(result.changes > 0);
    }
    return added;
  }
}
