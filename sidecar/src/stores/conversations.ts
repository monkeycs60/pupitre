import type { Database } from "bun:sqlite";
import type { AppEvent, Provider, StoredEvent } from "../events";
import { taskSummary, taskTitle } from "../conversation-title";
import type { PresetPermissionMode } from "./presets";

export interface Conversation {
  id: string; project_id: string; title: string; summary: string; provider: Provider;
  model: string; effort: string | null; speed: "standard" | "fast" | null;
  permission_mode: PresetPermissionMode | null;
  subagent_preset_id: string | null; subagent_effort: string | null;
  cli_session_id: string | null; pinned: boolean;
  /** Renommé à la main : le digest automatique ne l'écrase plus. */
  title_locked: boolean;
  /** Numéro de tour du dernier digest généré (0 = aucun). */
  digest_turn: number;
  archived: boolean; deleted_at: string | null;
  continued_from: string | null;
  handoff_pending: boolean;
  routine_id: string | null;
  /** Reçoit le bridge MCP `conductor` (délégation de sous-tâches). */
  orchestrator: boolean;
  created_at: string; updated_at: string;
}

const TITLE_MAX = 47;

export class ConversationStore {
  constructor(private db: Database) {}

  create(input: {
    projectId: string;
    provider: Provider;
    model: string;
    effort?: string | null;
    speed?: "standard" | "fast" | null;
    permissionMode?: PresetPermissionMode | null;
    subagentPresetId?: string | null;
    subagentEffort?: string | null;
    /** Défaut ON : toute nouvelle conversation peut déléguer. */
    orchestrator?: boolean;
    continuedFrom?: string | null;
    /** Vrai jusqu'au statut terminal réussi du premier tour de continuation. */
    handoffPending?: boolean;
    routineId?: string | null;
    firstMessage: string;
  }): Conversation {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = taskTitle(input.firstMessage);
    const summary = taskSummary(input.firstMessage);
    this.db.query(
      `INSERT INTO conversations
         (id, project_id, title, summary, provider, model, effort, speed, permission_mode, orchestrator,
          subagent_preset_id, subagent_effort,
          continued_from, handoff_pending, routine_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      title,
      summary,
      input.provider,
      input.model,
      input.effort ?? null,
      input.speed ?? null,
      input.permissionMode ?? null,
      input.orchestrator === false ? 0 : 1,
      input.subagentPresetId ?? null,
      input.subagentEffort ?? null,
      input.continuedFrom ?? null,
      input.handoffPending ? 1 : 0,
      input.routineId ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  setPermissionMode(id: string, mode: PresetPermissionMode | null): Conversation | null {
    this.db.query(
      "UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?",
    ).run(mode, new Date().toISOString(), id);
    return this.get(id);
  }

  get(id: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return row ? {
      ...row,
      summary: row.summary || row.title,
      pinned: !!row.pinned,
      title_locked: !!row.title_locked,
      digest_turn: row.digest_turn ?? 0,
      orchestrator: !!row.orchestrator,
      handoff_pending: !!row.handoff_pending,
      archived: !!row.archived,
      deleted_at: row.deleted_at ?? null,
    } : null;
  }

  listByProject(projectId: string, scope: "active" | "archived" | "trash" = "active"): Conversation[] {
    const predicate = scope === "trash"
      ? "deleted_at IS NOT NULL"
      : scope === "archived"
        ? "deleted_at IS NULL AND archived = 1"
        : "deleted_at IS NULL AND archived = 0";
    const rows = this.db.query(
      `SELECT * FROM conversations WHERE project_id = ? AND ${predicate}
       ORDER BY pinned DESC, updated_at DESC`
    ).all(projectId) as any[];
    return rows.map((r) => ({
      ...r,
      summary: r.summary || r.title,
      pinned: !!r.pinned,
      title_locked: !!r.title_locked,
      digest_turn: r.digest_turn ?? 0,
      orchestrator: !!r.orchestrator,
      handoff_pending: !!r.handoff_pending,
      archived: !!r.archived,
      deleted_at: r.deleted_at ?? null,
    }));
  }

  /** Renommage manuel : fige le titre, la régénération automatique s'arrête là. */
  rename(id: string, title: string): Conversation | null {
    const nextTitle = title.trim().slice(0, TITLE_MAX);
    if (!nextTitle) return this.get(id);
    this.db.query(
      "UPDATE conversations SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?"
    ).run(nextTitle, new Date().toISOString(), id);
    return this.get(id);
  }

  /**
   * Titre + résumé régénérés automatiquement. Ne touche à rien si l'utilisateur
   * a renommé la conversation à la main.
   */
  updateDigest(id: string, digest: { title: string; summary: string }, turn: number): Conversation | null {
    const nextTitle = digest.title.trim().slice(0, TITLE_MAX);
    const nextSummary = digest.summary.trim();
    if (!nextTitle || !nextSummary) return this.get(id);
    this.db.query(
      `UPDATE conversations SET title = ?, summary = ?, digest_turn = ?, updated_at = ?
       WHERE id = ? AND title_locked = 0`
    ).run(nextTitle, nextSummary, turn, new Date().toISOString(), id);
    return this.get(id);
  }

  /** Nombre de messages utilisateur : sert de compteur de tours pour le digest. */
  turnCount(id: string): number {
    const row = this.db.query(
      `SELECT COUNT(*) AS n FROM events
       WHERE conversation_id = ? AND json_extract(payload, '$.type') = 'user-message'`
    ).get(id) as { n: number } | null;
    return row?.n ?? 0;
  }

  /**
   * Matière du digest : le premier message (l'intention initiale) et les
   * derniers échanges (où la conversation en est vraiment).
   */
  digestSource(id: string, recent = 6): { first: string; latest: string[] } {
    const rows = this.db.query(
      `SELECT payload FROM events
       WHERE conversation_id = ?
         AND json_extract(payload, '$.type') IN ('user-message', 'text-final')
       ORDER BY id`
    ).all(id) as Array<{ payload: string }>;
    const texts = rows.map((row) => {
      const event = JSON.parse(row.payload) as { type: string; text?: string };
      return `${event.type === "user-message" ? "Utilisateur" : "Agent"} : ${event.text ?? ""}`;
    }).filter((line) => line.trim().length > 12);
    return { first: texts[0] ?? "", latest: texts.slice(-recent) };
  }

  setArchived(id: string, archived: boolean): Conversation | null {
    this.db.query("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, new Date().toISOString(), id);
    return this.get(id);
  }

  setDeleted(id: string, deleted: boolean): Conversation | null {
    const now = new Date().toISOString();
    this.db.query("UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(deleted ? now : null, now, id);
    return this.get(id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  /** Retire une continuation ratée et ses événements sans toucher à sa source. */
  deleteFailedContinuation(id: string): boolean {
    const remove = this.db.transaction(() => {
      const row = this.db.query(
        "SELECT continued_from, handoff_pending FROM conversations WHERE id = ?",
      ).get(id) as { continued_from: string | null; handoff_pending: number } | null;
      if (!row?.continued_from || !row.handoff_pending) return false;
      const subtasks = this.db.query(
        "SELECT id FROM subtasks WHERE conversation_id = ?",
      ).all(id) as Array<{ id: string }>;
      const deleteEvents = this.db.query("DELETE FROM events WHERE conversation_id = ?");
      for (const subtask of subtasks) deleteEvents.run(subtask.id);
      this.db.query("DELETE FROM subtasks WHERE conversation_id = ?").run(id);
      // Par prudence, une intégration future peut avoir attaché une review
      // pendant le seed ; ses flags/décisions suivent par ON DELETE CASCADE.
      this.db.query("DELETE FROM reviews WHERE conversation_id = ?").run(id);
      this.db.query("DELETE FROM events WHERE conversation_id = ?").run(id);
      return this.db.query("DELETE FROM conversations WHERE id = ?").run(id).changes === 1;
    });
    return remove();
  }

  completeHandoff(id: string): boolean {
    return this.db.query(`
      UPDATE conversations
      SET handoff_pending = 0, updated_at = ?
      WHERE id = ? AND handoff_pending = 1
    `).run(new Date().toISOString(), id).changes === 1;
  }

  /** Finalise les tours réussis, puis nettoie les continuations interrompues. */
  sweepPendingHandoffs(): number {
    const rows = this.db.query(`
      SELECT id FROM conversations WHERE handoff_pending = 1
    `).all() as Array<{ id: string }>;
    let removed = 0;
    for (const row of rows) {
      const lastStatus = this.listEvents(row.id)
        .filter((event) => event.type === "status")
        .at(-1);
      if (lastStatus?.type === "status" && lastStatus.state === "done") {
        this.completeHandoff(row.id);
        continue;
      }
      if (this.deleteFailedContinuation(row.id)) removed += 1;
    }
    return removed;
  }

  setCliSessionId(id: string, cliSessionId: string): void {
    this.db.query("UPDATE conversations SET cli_session_id = ?, updated_at = ? WHERE id = ?")
      .run(cliSessionId, new Date().toISOString(), id);
  }

  updateModel(id: string, input: {
    model: string;
    effort: string | null;
    speed: "standard" | "fast" | null;
  }): void {
    this.db.query(`
      UPDATE conversations
      SET model = ?, effort = ?, speed = ?, updated_at = ?
      WHERE id = ?
    `).run(input.model, input.effort, input.speed, new Date().toISOString(), id);
  }

  /** Estimation de cache à ré-ingérer : somme des tokens déjà comptabilisés. */
  usageTokens(id: string): number {
    return this.listEvents(id).reduce((total, event) => {
      if (event.type !== "usage") return total;
      return total + event.inputTokens + event.outputTokens;
    }, 0);
  }

  // Retourne l'id de la ligne insérée : le broadcast WS le rediffuse tel quel.
  appendEvent(conversationId: string, event: AppEvent): number {
    const append = this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db
        .query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
        .run(conversationId, JSON.stringify(event), now);
      this.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(now, conversationId);
      return Number(result.lastInsertRowid);
    });
    return append();
  }

  /**
   * Réduit le replay après un tour sans modifier le flux WebSocket déjà émis.
   * Seules les suites CONTIGUËS de deltas sont fusionnées : un outil ou tout
   * autre événement conserve ainsi exactement sa position dans le transcript.
   * L'id du premier delta est conservé, les suivants sont supprimés.
   */
  compactTextDeltas(conversationId: string): number {
    const compact = this.db.transaction(() => {
      const rows = this.db.query(
        "SELECT id, payload FROM events WHERE conversation_id = ? ORDER BY id",
      ).all(conversationId) as Array<{ id: number | bigint; payload: string }>;
      let removed = 0;
      let run: Array<{ id: number; event: { type: "text-delta"; text: string } }> = [];

      const flush = () => {
        if (run.length < 2) {
          run = [];
          return;
        }
        const [first, ...rest] = run;
        this.db.query("UPDATE events SET payload = ? WHERE id = ?")
          .run(JSON.stringify({ ...first.event, text: run.map((item) => item.event.text).join("") }), first.id);
        const remove = this.db.query("DELETE FROM events WHERE id = ?");
        for (const item of rest) remove.run(item.id);
        removed += rest.length;
        run = [];
      };

      for (const row of rows) {
        try {
          const event = JSON.parse(row.payload) as Partial<AppEvent>;
          if (event.type === "text-delta" && typeof event.text === "string") {
            run.push({
              id: Number(row.id),
              event: { type: "text-delta", text: event.text },
            });
            continue;
          }
        } catch {
          // Une ligne corrompue coupe la suite ; listEvents la signalera comme avant.
        }
        flush();
      }
      flush();
      return removed;
    });
    return compact();
  }

  /**
   * Clôt en une seule requête les tours que le redémarrage du sidecar a
   * forcément interrompus. La jointure sur conversations exclut les subtasks,
   * dont le statut métier doit aussi être synchronisé par SubtaskRunner.
   * On vise le dernier event de type `status` et non le dernier event tout
   * court : les adapters émettent `running` en premier, donc un tour coupé en
   * plein streaming laisse presque toujours un delta en dernière position.
   */
  sweepOrphanedRuns(): number {
    const result = this.db.query(`
      WITH last_events AS (
        SELECT MAX(events.id) AS id
        FROM events
        INNER JOIN conversations ON conversations.id = events.conversation_id
        WHERE json_valid(events.payload)
          AND json_extract(events.payload, '$.type') = 'status'
        GROUP BY events.conversation_id
      )
      UPDATE events
      SET payload = json_set(
        payload,
        '$.state', 'error',
        '$.error', 'interrompu (sidecar redémarré)'
      )
      WHERE id IN (SELECT id FROM last_events)
        AND json_valid(payload)
        AND json_extract(payload, '$.type') = 'status'
        AND json_extract(payload, '$.state') = 'running'
    `).run();
    return result.changes;
  }

  listEvents(conversationId: string): StoredEvent[] {
    const rows = this.db.query(
      "SELECT id, payload FROM events WHERE conversation_id = ? ORDER BY id"
    ).all(conversationId) as any[];
    const events: StoredEvent[] = [];
    for (const row of rows) {
      try {
        events.push({ ...JSON.parse(row.payload), id: Number(row.id) });
      } catch (error) {
        console.error("Événement de conversation corrompu, ligne ignorée", error);
      }
    }
    return events;
  }
}
