import type { Database } from "bun:sqlite";

export type ChangelogEnrichmentStatus = "pending" | "enriched";
export type ProjectChangelogStatus = "idle" | "running" | "error";

export interface GitChangelogCommit {
  repositoryPath: string;
  sha: string;
  branch: string;
  subject: string;
  message?: string;
  committedAt: string;
}

export interface ProjectChangelogEntry {
  project_id: string;
  repository_path: string;
  commit_sha: string;
  branch: string;
  subject: string;
  committed_at: string;
  domain_id: string | null;
  domain_name: string | null;
  product_message: string | null;
  enrichment_status: ChangelogEnrichmentStatus;
  imported_at: string;
  enriched_at: string | null;
  /** null tant que `git show --numstat` n'a pas été lu pour ce commit. */
  lines_added: number | null;
  lines_removed: number | null;
}

export interface CommitLineStats {
  sha: string;
  added: number;
  removed: number;
}

export interface ProjectChangelogState {
  project_id: string;
  status: ProjectChangelogStatus;
  last_started_at: string | null;
  last_refreshed_at: string | null;
  next_refresh_at: string | null;
  error: string | null;
  backfill_version: number;
}

export interface ProjectChangelogPayload {
  entries: ProjectChangelogEntry[];
  state: ProjectChangelogState;
}

const emptyState = (projectId: string): ProjectChangelogState => ({
  project_id: projectId,
  status: "idle",
  last_started_at: null,
  last_refreshed_at: null,
  next_refresh_at: null,
  error: null,
  backfill_version: 0,
});

export class ChangelogStore {
  constructor(private db: Database) {}

  import(projectId: string, commits: GitChangelogCommit[], importedAt: string): number {
    const insert = this.db.query(`
      INSERT OR IGNORE INTO project_changelog_entries
        (project_id, repository_path, commit_sha, branch, subject, committed_at, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let imported = 0;
    this.db.transaction(() => {
      for (const commit of commits) {
        const result = insert.run(
          projectId,
          commit.repositoryPath,
          commit.sha,
          commit.branch,
          commit.subject,
          commit.committedAt,
          importedAt,
        );
        imported += Number(result.changes > 0);
      }
    })();
    return imported;
  }

  reconcile(projectId: string, commits: GitChangelogCommit[]): number {
    const expected = new Set(commits.map((commit) => commit.sha));
    const existing = this.db.query(`
      SELECT repository_path, commit_sha
      FROM project_changelog_entries
      WHERE project_id = ?
    `).all(projectId) as Array<{ repository_path: string; commit_sha: string }>;
    const remove = this.db.query(`
      DELETE FROM project_changelog_entries
      WHERE project_id = ? AND commit_sha = ?
    `);
    let removed = 0;
    this.db.transaction(() => {
      for (const entry of existing) {
        if (expected.has(entry.commit_sha)) continue;
        removed += Number(remove.run(projectId, entry.commit_sha).changes > 0);
      }
    })();
    return removed;
  }

  list(projectId: string, domainId?: string): ProjectChangelogEntry[] {
    return this.db.query(`
      SELECT pce.*, d.name AS domain_name
      FROM project_changelog_entries pce
      LEFT JOIN domains d ON d.id = pce.domain_id
      WHERE pce.project_id = ? AND (? IS NULL OR pce.domain_id = ?)
      ORDER BY pce.committed_at DESC, pce.commit_sha DESC
    `).all(projectId, domainId ?? null, domainId ?? null) as ProjectChangelogEntry[];
  }

  pending(projectId: string, limit: number): ProjectChangelogEntry[] {
    return this.db.query(`
      SELECT pce.*, NULL AS domain_name
      FROM project_changelog_entries pce
      WHERE pce.project_id = ? AND pce.enrichment_status = 'pending'
      ORDER BY pce.committed_at DESC, pce.commit_sha DESC
      LIMIT ?
    `).all(projectId, limit) as ProjectChangelogEntry[];
  }

  enrich(projectId: string, values: Array<{
    repositoryPath: string;
    sha: string;
    domainId: string | null;
    productMessage: string;
  }>, enrichedAt: string): void {
    const update = this.db.query(`
      UPDATE project_changelog_entries
      SET domain_id = ?, product_message = ?, enrichment_status = 'enriched', enriched_at = ?
      WHERE project_id = ? AND commit_sha = ?
        AND enrichment_status = 'pending'
    `);
    this.db.transaction(() => {
      for (const value of values) {
        update.run(
          value.domainId,
          value.productMessage,
          enrichedAt,
          projectId,
          value.sha,
        );
      }
    })();
  }

  missingLineStats(projectId: string, limit: number): Array<{ repository_path: string; commit_sha: string }> {
    return this.db.query(`
      SELECT repository_path, commit_sha
      FROM project_changelog_entries
      WHERE project_id = ? AND lines_added IS NULL
      ORDER BY committed_at DESC, commit_sha DESC
      LIMIT ?
    `).all(projectId, limit) as Array<{ repository_path: string; commit_sha: string }>;
  }

  setLineStats(projectId: string, values: CommitLineStats[]): void {
    const update = this.db.query(`
      UPDATE project_changelog_entries
      SET lines_added = ?, lines_removed = ?
      WHERE project_id = ? AND commit_sha = ?
    `);
    this.db.transaction(() => {
      for (const value of values) update.run(value.added, value.removed, projectId, value.sha);
    })();
  }

  /**
   * Commits dont la date tombe dans [from, to) : `committed_at` porte le
   * décalage horaire du commit, donc le tri fin se fait sur l'horodatage
   * parsé, après un dégrossissage SQL sur le jour à un jour près.
   */
  listBetween(projectId: string, from: string, to: string): ProjectChangelogEntry[] {
    const start = Date.parse(from);
    const end = Date.parse(to);
    const low = new Date(start - 86_400_000).toISOString().slice(0, 10);
    const high = new Date(end + 86_400_000).toISOString().slice(0, 10);
    return (this.db.query(`
      SELECT pce.*, d.name AS domain_name
      FROM project_changelog_entries pce
      LEFT JOIN domains d ON d.id = pce.domain_id
      WHERE pce.project_id = ? AND substr(pce.committed_at, 1, 10) BETWEEN ? AND ?
      ORDER BY pce.committed_at ASC, pce.commit_sha ASC
    `).all(projectId, low, high) as ProjectChangelogEntry[]).filter((entry) => {
      const at = Date.parse(entry.committed_at);
      return at >= start && at < end;
    });
  }

  /** Totaux d'un projet ou de tous : commits et lignes, bornés à une fenêtre facultative. */
  totals(projectId?: string, from?: string, to?: string): { commits: number; linesAdded: number; linesRemoved: number } {
    const entries = projectId && from && to
      ? this.listBetween(projectId, from, to)
      : (this.db.query(`
          SELECT commit_sha, committed_at, lines_added, lines_removed
          FROM project_changelog_entries ${projectId ? "WHERE project_id = ?" : ""}
        `).all(...(projectId ? [projectId] : [])) as ProjectChangelogEntry[]).filter((entry) => {
          if (!from || !to) return true;
          const at = Date.parse(entry.committed_at);
          return at >= Date.parse(from) && at < Date.parse(to);
        });
    return entries.reduce((sum, entry) => ({
      commits: sum.commits + 1,
      linesAdded: sum.linesAdded + (entry.lines_added ?? 0),
      linesRemoved: sum.linesRemoved + (entry.lines_removed ?? 0),
    }), { commits: 0, linesAdded: 0, linesRemoved: 0 });
  }

  /**
   * Commits et lignes par jour local et par projet sur [fromDay, toDay]. Le
   * jour vient des dix premiers caractères de `committed_at`, qui porte le
   * décalage horaire du commit : pas de conversion UTC à faire.
   */
  dailyTotals(fromDay: string, toDay: string): Array<{ day: string; projectId: string; commits: number; linesAdded: number; linesRemoved: number }> {
    return (this.db.query(`
      SELECT substr(committed_at, 1, 10) AS day, project_id,
             COUNT(*) AS commits, COALESCE(SUM(lines_added), 0) AS lines_added, COALESCE(SUM(lines_removed), 0) AS lines_removed
      FROM project_changelog_entries
      WHERE substr(committed_at, 1, 10) BETWEEN ? AND ?
      GROUP BY day, project_id
      ORDER BY day
    `).all(fromDay, toDay) as Array<{ day: string; project_id: string; commits: number | bigint; lines_added: number | bigint; lines_removed: number | bigint }>)
      .map((row) => ({ day: row.day, projectId: row.project_id, commits: Number(row.commits), linesAdded: Number(row.lines_added), linesRemoved: Number(row.lines_removed) }));
  }

  state(projectId: string): ProjectChangelogState {
    return this.db.query(
      "SELECT * FROM project_changelog_state WHERE project_id = ?",
    ).get(projectId) as ProjectChangelogState | null ?? emptyState(projectId);
  }

  markRunning(projectId: string, startedAt: string): void {
    this.db.query(`
      INSERT INTO project_changelog_state
        (project_id, status, last_started_at, last_refreshed_at, next_refresh_at, error)
      VALUES (?, 'running', ?, NULL, NULL, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        status = 'running', last_started_at = excluded.last_started_at, error = NULL
    `).run(projectId, startedAt);
  }

  markFinished(
    projectId: string,
    refreshedAt: string,
    nextRefreshAt: string,
    backfillVersion?: number,
  ): void {
    this.db.query(`
      UPDATE project_changelog_state
      SET status = 'idle', last_refreshed_at = ?, next_refresh_at = ?, error = NULL,
          backfill_version = COALESCE(?, backfill_version)
      WHERE project_id = ?
    `).run(refreshedAt, nextRefreshAt, backfillVersion ?? null, projectId);
  }

  markError(projectId: string, message: string, nextRefreshAt: string): void {
    this.db.query(`
      UPDATE project_changelog_state
      SET status = 'error', next_refresh_at = ?, error = ?
      WHERE project_id = ?
    `).run(nextRefreshAt, message.slice(0, 1000), projectId);
  }
}
