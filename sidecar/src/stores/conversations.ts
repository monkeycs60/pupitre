import type { Database } from "bun:sqlite";
import type { AppEvent, Provider, StoredEvent } from "../events";
import { taskSummary, taskTitle } from "../conversation-title";
import { messageCountIncrement } from "../message-count";
import type { Preset, PresetPermissionMode, PresetStore } from "./presets";

export interface Conversation {
  id: string; project_id: string; title: string; summary: string; provider: Provider;
  model: string; effort: string | null; speed: "standard" | "fast" | null;
  preset_id: string | null;
  permission_mode: PresetPermissionMode | null;
  subagent_preset_id: string | null; subagent_effort: string | null;
  cli_session_id: string | null; pinned: boolean;
  /** Renommé à la main : le digest automatique ne l'écrase plus. */
  title_locked: boolean;
  /** Numéro de tour du dernier digest généré (0 = aucun). */
  digest_turn: number;
  /** Numéro du dernier tour dont la réponse est arrivée à son terme (0 = aucun).
   *  C'est lui, et non le digest, qui rend une conversation « à lire » : le
   *  digest ne se régénère que tous les 4 puis 10 tours. */
  answered_turn: number;
  message_count: number; last_read_turn: number;
  archived: boolean; deleted_at: string | null;
  continued_from: string | null;
  handoff_pending: boolean;
  routine_id: string | null;
  /** Worktree git dédié ; null = dossier principal du projet. Voir ADR 0001. */
  worktree_path: string | null;
  /** Branche courante du projet au moment de la création ; null = non capturé (avant la migration). */
  created_on_branch: string | null;
  ticket_id: string | null;
  ticket_key?: string | null;
  ticket_instruction: string | null;
  origin_type?: "sentry" | null;
  origin_key?: string | null;
  /** Reçoit le bridge MCP `conductor` (délégation de sous-tâches). */
  orchestrator: boolean;
  created_at: string; updated_at: string;
}

const TITLE_MAX = 47;

function matchesPreset(conversation: Pick<Conversation, "provider" | "model" | "effort" | "speed" | "orchestrator">, preset: Preset): boolean {
  return conversation.provider === preset.provider
    && conversation.model === preset.model
    && conversation.effort === preset.effort
    && conversation.speed === preset.speed
    && conversation.orchestrator === preset.orchestrator;
}

export class ConversationStore {
  constructor(private db: Database) {}

  /**
   * Les versions précédentes ne persistaient pas le preset sélectionné. Quand
   * la configuration enregistrée correspond à un seul preset, on répare cette
   * provenance au démarrage pour que les conversations historiques retrouvent
   * leur nom dans la sidebar.
   */
  backfillPresetIds(presets: Pick<PresetStore, "list">): number {
    const candidates = presets.list();
    const rows = this.db.query(
      `SELECT id, project_id, provider, model, effort, speed, orchestrator
       FROM conversations WHERE preset_id IS NULL`,
    ).all() as Array<Omit<Pick<Conversation, "id" | "project_id" | "provider" | "model" | "effort" | "speed" | "orchestrator">, "orchestrator"> & { orchestrator: number }>;
    let updated = 0;
    for (const row of rows) {
      const conversation = { ...row, orchestrator: !!row.orchestrator };
      const matches = candidates.filter((preset) => matchesPreset(conversation, preset));
      if (matches.length !== 1) continue;
      this.db.query(
        "UPDATE conversations SET preset_id = ? WHERE id = ? AND preset_id IS NULL",
      ).run(matches[0]!.id, conversation.id);
      updated += 1;
    }
    return updated;
  }

  create(input: {
    projectId: string;
    provider: Provider;
    model: string;
    presetId?: string | null;
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
    /** Worktree déjà créé par le service Git ; null = dépôt principal. */
    worktreePath?: string | null;
    /** Branche courante du projet au moment de la création. */
    createdOnBranch?: string | null;
    ticketId?: string | null;
    ticketInstruction?: string | null;
    originType?: "sentry" | null;
    originKey?: string | null;
    firstMessage: string;
  }): Conversation {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = taskTitle(input.firstMessage);
    const summary = taskSummary(input.firstMessage);
    this.db.query(
      `INSERT INTO conversations
         (id, project_id, title, summary, provider, model, preset_id, effort, speed, permission_mode, orchestrator,
          subagent_preset_id, subagent_effort,
          continued_from, handoff_pending, routine_id, worktree_path, created_on_branch, ticket_id, ticket_instruction, origin_type, origin_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      title,
      summary,
      input.provider,
      input.model,
      input.presetId ?? null,
      input.effort ?? null,
      input.speed ?? null,
      input.permissionMode ?? null,
      input.orchestrator === false ? 0 : 1,
      input.subagentPresetId ?? null,
      input.subagentEffort ?? null,
      input.continuedFrom ?? null,
      input.handoffPending ? 1 : 0,
      input.routineId ?? null,
      input.worktreePath ?? null,
      input.createdOnBranch ?? null,
      input.ticketId ?? null,
      input.ticketInstruction?.trim() || null,
      input.originType ?? null,
      input.originKey ?? null,
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
      answered_turn: row.answered_turn ?? 0,
      message_count: row.message_count ?? 0,
      last_read_turn: row.last_read_turn ?? 0,
      orchestrator: !!row.orchestrator,
      handoff_pending: !!row.handoff_pending,
      archived: !!row.archived,
      deleted_at: row.deleted_at ?? null,
    } : null;
  }

  listByProject(projectId: string, scope: "active" | "archived" | "trash" = "active"): Conversation[] {
    const predicate = scope === "trash"
      ? "c.deleted_at IS NOT NULL"
      : scope === "archived"
        ? "c.deleted_at IS NULL AND c.archived = 1"
        : "c.deleted_at IS NULL AND c.archived = 0";
    const rows = this.db.query(
      `SELECT c.*, t.key AS ticket_key,
              COALESCE(c.origin_type, CASE WHEN st.issue_id IS NOT NULL THEN 'sentry' ELSE NULL END) AS origin_type,
              COALESCE(c.origin_key, json_extract(si.payload_json, '$.shortId')) AS origin_key
       FROM conversations c
       LEFT JOIN tickets t ON t.id = c.ticket_id
       LEFT JOIN sentry_triages st ON st.conversation_id = c.id OR st.correction_conversation_id = c.id
       LEFT JOIN sentry_issues si ON si.id = st.issue_id
       WHERE c.project_id = ? AND ${predicate}
       ORDER BY c.pinned DESC, c.updated_at DESC`
    ).all(projectId) as any[];
    return rows.map((r) => ({
      ...r,
      summary: r.summary || r.title,
      pinned: !!r.pinned,
      title_locked: !!r.title_locked,
      digest_turn: r.digest_turn ?? 0,
      answered_turn: r.answered_turn ?? 0,
      message_count: r.message_count ?? 0,
      last_read_turn: r.last_read_turn ?? 0,
      orchestrator: !!r.orchestrator,
      handoff_pending: !!r.handoff_pending,
      archived: !!r.archived,
      deleted_at: r.deleted_at ?? null,
    }));
  }

  unreadCountsByProject(): Record<string, number> {
    const rows = this.db.query(`
      SELECT project_id, COUNT(*) AS count
      FROM conversations
      WHERE deleted_at IS NULL
        AND archived = 0
        AND answered_turn > last_read_turn
      GROUP BY project_id
    `).all() as Array<{ project_id: string; count: number | bigint }>;
    return Object.fromEntries(rows.map((row) => [row.project_id, Number(row.count)]));
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

  /**
   * Noms d'outils distincts appelés dans un projet. Sert à déduire quels
   * serveurs MCP ont réellement servi, sous-tâches comprises.
   */
  toolNamesByProject(projectId: string): string[] {
    const rows = this.db.query(
      `SELECT DISTINCT json_extract(payload, '$.toolName') AS name
       FROM events
       WHERE json_extract(payload, '$.type') = 'tool-start'
         AND conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)`
    ).all(projectId) as Array<{ name: string | null }>;
    return rows.flatMap((row) => (row.name ? [row.name] : []));
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

  /** Sans tour explicite, la conversation est lue jusqu'à son dernier tour
   *  répondu : l'UI ne connaît pas toujours le nombre de tours, sa page
   *  d'événements pouvant ne couvrir que la fin du fil. */
  markRead(id: string, lastReadTurn?: number): Conversation | null {
    this.db.query(
      `UPDATE conversations
       SET last_read_turn = MAX(last_read_turn, COALESCE(?, answered_turn))
       WHERE id = ?`,
    ).run(lastReadTurn ?? null, id);
    return this.get(id);
  }

  /** Fin de tour : la conversation devient « à lire » pour qui ne la regarde pas. */
  markAnswered(id: string): void {
    this.db.query("UPDATE conversations SET answered_turn = ? WHERE id = ?")
      .run(this.turnCount(id), id);
  }

  /**
   * Vide la corbeille : supprime définitivement les conversations jetées, leurs
   * événements, leurs sous-tâches et les reviews qui en dépendent. Sans ce
   * ménage, les événements resteraient orphelins — rien ne les relie par clé
   * étrangère, puisque `conversation_id` désigne aussi bien une sous-tâche.
   */
  purgeTrashed(): number {
    const purge = this.db.transaction(() => {
      const doomed = this.db.query(
        "SELECT id FROM conversations WHERE deleted_at IS NOT NULL",
      ).all() as Array<{ id: string }>;
      const deleteEvents = this.db.query("DELETE FROM events WHERE conversation_id = ?");
      for (const conversation of doomed) {
        const subtasks = this.db.query(
          "SELECT id FROM subtasks WHERE conversation_id = ?",
        ).all(conversation.id) as Array<{ id: string }>;
        for (const subtask of subtasks) deleteEvents.run(subtask.id);
        this.db.query("DELETE FROM subtasks WHERE conversation_id = ?").run(conversation.id);
        this.db.query("DELETE FROM reviews WHERE conversation_id = ?").run(conversation.id);
        deleteEvents.run(conversation.id);
        this.db.query("DELETE FROM conversations WHERE id = ?").run(conversation.id);
      }
      return doomed.length;
    });
    return purge();
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
      let assistantResponseCounted = false;
      if (event.type === "text-final") {
        const lastMessageEvent = this.db.query(
          `SELECT json_extract(payload, '$.type') AS type
           FROM events
           WHERE conversation_id = ?
             AND json_valid(payload)
             AND json_extract(payload, '$.type') IN ('user-message', 'text-final')
           ORDER BY id DESC
           LIMIT 1`,
        ).get(conversationId) as { type?: string } | null;
        assistantResponseCounted = lastMessageEvent?.type === "text-final";
      }
      const result = this.db
        .query("INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)")
        .run(conversationId, JSON.stringify(event), now);
      const messageIncrement = messageCountIncrement(event.type, assistantResponseCounted);
      this.db.query(
        `UPDATE conversations
         SET updated_at = ?, message_count = message_count + ?
         WHERE id = ?`,
      ).run(now, messageIncrement, conversationId);
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

  /**
   * Replay destiné à l'interface. Les limites de quota vivent dans leur canal
   * dédié et chaque `text-final` remplace les deltas qui le précèdent ; les
   * garder dans le transcript multipliait le JSON et le travail React sans
   * ajouter d'information visible. Les deltas postérieurs au dernier final
   * restent présents pour restaurer un tour interrompu en plein streaming.
   */
  listReplayEvents(conversationId: string): StoredEvent[] {
    const rows = this.db.query(`
      WITH last_final AS (
        SELECT COALESCE(MAX(id), 0) AS id
        FROM events
        WHERE conversation_id = ?
          AND json_valid(payload)
          AND json_extract(payload, '$.type') = 'text-final'
      )
      SELECT events.id, events.payload
      FROM events, last_final
      WHERE events.conversation_id = ?
        AND (
          NOT json_valid(events.payload)
          OR json_extract(events.payload, '$.type') != 'rate-limit'
        )
        AND (
          NOT json_valid(events.payload)
          OR json_extract(events.payload, '$.type') != 'text-delta'
          OR events.id > last_final.id
        )
      ORDER BY events.id
    `).all(conversationId, conversationId) as Array<{ id: number | bigint; payload: string }>;
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

  listReplayEventPage(
    conversationId: string,
    before: number | null,
    limit: number,
  ): { events: StoredEvent[]; nextBefore: number | null } {
    const rows = this.db.query(`
      WITH last_final AS (
        SELECT COALESCE(MAX(id), 0) AS id
        FROM events
        WHERE conversation_id = ?
          AND json_valid(payload)
          AND json_extract(payload, '$.type') = 'text-final'
      )
      SELECT events.id, events.payload
      FROM events, last_final
      WHERE events.conversation_id = ?
        AND (? IS NULL OR events.id < ?)
        AND (NOT json_valid(events.payload) OR json_extract(events.payload, '$.type') != 'rate-limit')
        AND (
          NOT json_valid(events.payload)
          OR json_extract(events.payload, '$.type') != 'text-delta'
          OR events.id > last_final.id
        )
      ORDER BY events.id DESC
      LIMIT ?
    `).all(conversationId, conversationId, before, before, limit) as Array<{ id: number | bigint; payload: string }>;
    const events: StoredEvent[] = [];
    for (const row of rows.reverse()) {
      try {
        events.push({ ...JSON.parse(row.payload), id: Number(row.id) });
      } catch (error) {
        console.error("Événement de conversation corrompu, ligne ignorée", error);
      }
    }
    return {
      events,
      nextBefore: rows.length === limit ? Number(rows[0]!.id) : null,
    };
  }

  /** Le dernier événement seul : le snapshot fleet le lit chaque seconde,
   *  charger tout le replay pour un `.at(-1)` coûtait des Mo de JSON.parse. */
  latestEvent(conversationId: string): StoredEvent | undefined {
    const row = this.db.query(
      "SELECT id, payload FROM events WHERE conversation_id = ? ORDER BY id DESC LIMIT 1"
    ).get(conversationId) as { id: number; payload: string } | null;
    if (!row) return undefined;
    try {
      return { ...JSON.parse(row.payload), id: Number(row.id) };
    } catch (error) {
      console.error("Événement de conversation corrompu, ligne ignorée", error);
      return undefined;
    }
  }
}
