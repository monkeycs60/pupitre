import type { Database } from "bun:sqlite";

export interface ModelCost {
  model: string;
  tokens: number;
}

export interface ConversationCost {
  conversationId: string;
  title: string;
  parentModel: string;
  totalTokens: number;
  directTokens: number;
  subtaskTokens: number;
  delegationSavingsTokens: number;
  models: ModelCost[];
}

export interface ProjectCostReport {
  projectId: string;
  month: string;
  totalTokens: number;
  directTokens: number;
  subtaskTokens: number;
  delegationSavingsTokens: number;
  conversations: ConversationCost[];
}

interface UsageRow {
  conversation_id: string;
  title: string;
  parent_model: string;
  scope: "direct" | "subtask";
  usage_model: string;
  input_tokens: number;
  output_tokens: number;
}

export class CostStore {
  constructor(private readonly db: Database) {}

  projectMonth(projectId: string, month: string): ProjectCostReport {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("mois invalide");
    const rows = this.db.query(`
      SELECT conversations.id AS conversation_id, conversations.title,
        COALESCE(
          (
            SELECT json_extract(parent_session.payload, '$.model')
            FROM events AS parent_session
            WHERE parent_session.conversation_id = conversations.id
              AND parent_session.id <= events.id
              AND json_valid(parent_session.payload)
              AND json_extract(parent_session.payload, '$.type') = 'session'
            ORDER BY parent_session.id DESC LIMIT 1
          ),
          conversations.model
        ) AS parent_model,
        CASE WHEN subtasks.id IS NULL THEN 'direct' ELSE 'subtask' END AS scope,
        COALESCE(
          (
            SELECT json_extract(session.payload, '$.model')
            FROM events AS session
            WHERE session.conversation_id = events.conversation_id
              AND session.id <= events.id
              AND json_valid(session.payload)
              AND json_extract(session.payload, '$.type') = 'session'
            ORDER BY session.id DESC LIMIT 1
          ),
          subtasks.model,
          conversations.model
        ) AS usage_model,
        COALESCE(json_extract(events.payload, '$.inputTokens'), 0) AS input_tokens,
        COALESCE(json_extract(events.payload, '$.outputTokens'), 0) AS output_tokens
      FROM events
      LEFT JOIN subtasks ON subtasks.id = events.conversation_id
      INNER JOIN conversations
        ON conversations.id = COALESCE(subtasks.conversation_id, events.conversation_id)
      WHERE conversations.project_id = ?
        AND strftime('%Y-%m', events.created_at) = ?
        AND json_valid(events.payload)
        AND json_extract(events.payload, '$.type') = 'usage'
      ORDER BY events.id
    `).all(projectId, month) as UsageRow[];

    const conversations = new Map<string, ConversationCost & { modelMap: Map<string, number> }>();
    for (const row of rows) {
      let cost = conversations.get(row.conversation_id);
      if (!cost) {
        cost = {
          conversationId: row.conversation_id,
          title: row.title,
          parentModel: row.parent_model,
          totalTokens: 0,
          directTokens: 0,
          subtaskTokens: 0,
          delegationSavingsTokens: 0,
          models: [],
          modelMap: new Map(),
        };
        conversations.set(row.conversation_id, cost);
      }
      const tokens = row.input_tokens + row.output_tokens;
      cost.totalTokens += tokens;
      if (row.scope === "direct") cost.directTokens += tokens;
      else {
        cost.subtaskTokens += tokens;
        if (row.usage_model.includes("luna") && !row.parent_model.includes("luna")) {
          // Contrefactuel volontairement exprimé en tokens, jamais en euros :
          // ces tokens auraient été consommés dans le budget du modèle parent.
          cost.delegationSavingsTokens += tokens;
        }
      }
      cost.modelMap.set(row.usage_model, (cost.modelMap.get(row.usage_model) ?? 0) + tokens);
    }

    const items = [...conversations.values()].map(({ modelMap, ...cost }) => ({
      ...cost,
      models: [...modelMap.entries()]
        .map(([model, tokens]) => ({ model, tokens }))
        .sort((left, right) => right.tokens - left.tokens),
    })).sort((left, right) => right.totalTokens - left.totalTokens);

    return {
      projectId,
      month,
      totalTokens: items.reduce((sum, item) => sum + item.totalTokens, 0),
      directTokens: items.reduce((sum, item) => sum + item.directTokens, 0),
      subtaskTokens: items.reduce((sum, item) => sum + item.subtaskTokens, 0),
      delegationSavingsTokens: items.reduce((sum, item) => sum + item.delegationSavingsTokens, 0),
      conversations: items,
    };
  }
}
