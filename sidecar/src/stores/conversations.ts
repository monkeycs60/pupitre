import type { Database } from "bun:sqlite";
import type { AppEvent, Provider, StoredEvent } from "../events";

export interface Conversation {
  id: string; project_id: string; title: string; provider: Provider;
  model: string; effort: string | null; speed: "standard" | "fast" | null;
  cli_session_id: string | null; pinned: boolean;
  continued_from: string | null;
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
    /** Défaut ON : toute nouvelle conversation peut déléguer. */
    orchestrator?: boolean;
    continuedFrom?: string | null;
    firstMessage: string;
  }): Conversation {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = input.firstMessage.length > TITLE_MAX
      ? input.firstMessage.slice(0, TITLE_MAX) + "…"
      : input.firstMessage;
    this.db.query(
      `INSERT INTO conversations
         (id, project_id, title, provider, model, effort, speed, orchestrator,
          continued_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      title,
      input.provider,
      input.model,
      input.effort ?? null,
      input.speed ?? null,
      input.orchestrator === false ? 0 : 1,
      input.continuedFrom ?? null,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return row ? { ...row, pinned: !!row.pinned, orchestrator: !!row.orchestrator } : null;
  }

  listByProject(projectId: string): Conversation[] {
    const rows = this.db.query(
      "SELECT * FROM conversations WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC"
    ).all(projectId) as any[];
    return rows.map((r) => ({ ...r, pinned: !!r.pinned, orchestrator: !!r.orchestrator }));
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }

  /** Retire une continuation ratée et ses événements sans toucher à sa source. */
  deleteFailedContinuation(id: string): boolean {
    const remove = this.db.transaction(() => {
      const row = this.db.query(
        "SELECT continued_from FROM conversations WHERE id = ?",
      ).get(id) as { continued_from: string | null } | null;
      if (!row?.continued_from) return false;
      this.db.query("DELETE FROM events WHERE conversation_id = ?").run(id);
      return this.db.query("DELETE FROM conversations WHERE id = ?").run(id).changes === 1;
    });
    return remove();
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
   */
  sweepOrphanedRuns(): number {
    const result = this.db.query(`
      WITH last_events AS (
        SELECT MAX(events.id) AS id
        FROM events
        INNER JOIN conversations ON conversations.id = events.conversation_id
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
