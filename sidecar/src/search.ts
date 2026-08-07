import type { Database } from "bun:sqlite";

export type SearchKind = "conversation" | "event" | "debrief";

export interface SearchResult {
  kind: SearchKind;
  sourceId: string;
  conversationId: string;
  projectId: string;
  title: string;
  excerpt: string;
  rank: number;
}

function matchQuery(input: string): string | null {
  const tokens = input.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.slice(0, 12).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

export class SearchIndex {
  constructor(private readonly db: Database) {
    this.createSchema();
    this.rebuild();
  }

  search(query: string, projectId?: string, limit = 50): SearchResult[] {
    const match = matchQuery(query);
    if (!match) return [];
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = projectId
      ? this.db.query(`
          SELECT kind, source_id, conversation_id, project_id, title,
            snippet(search_index, 5, '', '', '…', 28) AS excerpt,
            bm25(search_index, 0.0, 0.0, 0.0, 0.0, 8.0, 1.0) AS rank
          FROM search_index
          WHERE search_index MATCH ? AND project_id = ?
          ORDER BY rank LIMIT ?
        `).all(match, projectId, boundedLimit)
      : this.db.query(`
          SELECT kind, source_id, conversation_id, project_id, title,
            snippet(search_index, 5, '', '', '…', 28) AS excerpt,
            bm25(search_index, 0.0, 0.0, 0.0, 0.0, 8.0, 1.0) AS rank
          FROM search_index
          WHERE search_index MATCH ?
          ORDER BY rank LIMIT ?
        `).all(match, boundedLimit);
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      kind: row.kind as SearchKind,
      sourceId: String(row.source_id),
      conversationId: String(row.conversation_id),
      projectId: String(row.project_id),
      title: String(row.title),
      excerpt: String(row.excerpt),
      rank: Number(row.rank),
    }));
  }

  rebuild(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM search_index");
      this.db.exec(`
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
          SELECT 'conversation', id, id, project_id, title, title FROM conversations;

        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'event', CAST(events.id AS TEXT),
          COALESCE(conversations.id, parent.id),
          COALESCE(conversations.project_id, parent.project_id),
          CASE
            WHEN subtasks.id IS NULL THEN conversations.title
            ELSE parent.title || ' · ' || COALESCE(subtasks.label, 'sous-tâche')
          END,
          json_extract(events.payload, '$.text')
        FROM events
        LEFT JOIN conversations ON conversations.id = events.conversation_id
        LEFT JOIN subtasks ON subtasks.id = events.conversation_id
        LEFT JOIN conversations AS parent ON parent.id = subtasks.conversation_id
        WHERE json_valid(events.payload)
          AND json_extract(events.payload, '$.type') IN ('user-message', 'text-final')
          AND COALESCE(conversations.id, parent.id) IS NOT NULL;

        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'debrief', debriefs.id, conversations.id, conversations.project_id,
          'Débrief · ' || conversations.title, debriefs.content_md
        FROM debriefs
        INNER JOIN conversations ON conversations.id = debriefs.conversation_id;
      `);
    })();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        kind UNINDEXED,
        source_id UNINDEXED,
        conversation_id UNINDEXED,
        project_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS search_conversations_insert AFTER INSERT ON conversations BEGIN
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        VALUES ('conversation', NEW.id, NEW.id, NEW.project_id, NEW.title, NEW.title);
      END;
      CREATE TRIGGER IF NOT EXISTS search_conversations_delete AFTER DELETE ON conversations BEGIN
        DELETE FROM search_index WHERE conversation_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS search_conversations_title AFTER UPDATE OF title ON conversations BEGIN
        DELETE FROM search_index WHERE conversation_id = NEW.id;
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        VALUES ('conversation', NEW.id, NEW.id, NEW.project_id, NEW.title, NEW.title);
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'event', CAST(events.id AS TEXT), NEW.id, NEW.project_id,
          CASE WHEN subtasks.id IS NULL THEN NEW.title
            ELSE NEW.title || ' · ' || COALESCE(subtasks.label, 'sous-tâche') END,
          json_extract(events.payload, '$.text')
        FROM events
        LEFT JOIN subtasks ON subtasks.id = events.conversation_id
        WHERE (events.conversation_id = NEW.id OR subtasks.conversation_id = NEW.id)
          AND json_valid(events.payload)
          AND json_extract(events.payload, '$.type') IN ('user-message', 'text-final');
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'debrief', id, NEW.id, NEW.project_id, 'Débrief · ' || NEW.title, content_md
        FROM debriefs WHERE conversation_id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS search_events_insert AFTER INSERT ON events
      WHEN json_valid(NEW.payload)
        AND json_extract(NEW.payload, '$.type') IN ('user-message', 'text-final')
      BEGIN
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'event', CAST(NEW.id AS TEXT),
          COALESCE(conversations.id, parent.id),
          COALESCE(conversations.project_id, parent.project_id),
          CASE WHEN subtasks.id IS NULL THEN conversations.title
            ELSE parent.title || ' · ' || COALESCE(subtasks.label, 'sous-tâche') END,
          json_extract(NEW.payload, '$.text')
        FROM (SELECT 1)
        LEFT JOIN conversations ON conversations.id = NEW.conversation_id
        LEFT JOIN subtasks ON subtasks.id = NEW.conversation_id
        LEFT JOIN conversations AS parent ON parent.id = subtasks.conversation_id
        WHERE COALESCE(conversations.id, parent.id) IS NOT NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS search_events_delete AFTER DELETE ON events BEGIN
        DELETE FROM search_index WHERE kind = 'event' AND source_id = CAST(OLD.id AS TEXT);
      END;
      CREATE TRIGGER IF NOT EXISTS search_events_update AFTER UPDATE OF payload ON events BEGIN
        DELETE FROM search_index WHERE kind = 'event' AND source_id = CAST(OLD.id AS TEXT);
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'event', CAST(NEW.id AS TEXT),
          COALESCE(conversations.id, parent.id),
          COALESCE(conversations.project_id, parent.project_id),
          CASE WHEN subtasks.id IS NULL THEN conversations.title
            ELSE parent.title || ' · ' || COALESCE(subtasks.label, 'sous-tâche') END,
          json_extract(NEW.payload, '$.text')
        FROM (SELECT 1)
        LEFT JOIN conversations ON conversations.id = NEW.conversation_id
        LEFT JOIN subtasks ON subtasks.id = NEW.conversation_id
        LEFT JOIN conversations AS parent ON parent.id = subtasks.conversation_id
        WHERE json_valid(NEW.payload)
          AND json_extract(NEW.payload, '$.type') IN ('user-message', 'text-final')
          AND COALESCE(conversations.id, parent.id) IS NOT NULL;
      END;

      CREATE TRIGGER IF NOT EXISTS search_debriefs_insert AFTER INSERT ON debriefs BEGIN
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'debrief', NEW.id, conversations.id, conversations.project_id,
          'Débrief · ' || conversations.title, NEW.content_md
        FROM conversations WHERE conversations.id = NEW.conversation_id;
      END;
      CREATE TRIGGER IF NOT EXISTS search_debriefs_update AFTER UPDATE OF content_md ON debriefs BEGIN
        DELETE FROM search_index WHERE kind = 'debrief' AND source_id = OLD.id;
        INSERT INTO search_index(kind, source_id, conversation_id, project_id, title, body)
        SELECT 'debrief', NEW.id, conversations.id, conversations.project_id,
          'Débrief · ' || conversations.title, NEW.content_md
        FROM conversations WHERE conversations.id = NEW.conversation_id;
      END;
      CREATE TRIGGER IF NOT EXISTS search_debriefs_delete AFTER DELETE ON debriefs BEGIN
        DELETE FROM search_index WHERE kind = 'debrief' AND source_id = OLD.id;
      END;
    `);
  }
}
