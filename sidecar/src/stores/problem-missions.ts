import type { Database } from "bun:sqlite";

export interface ProblemMission {
  id: string;
  public_id: string;
  project_id: string;
  conversation_id: string;
  title: string;
  problem_ids: string[];
  problem_count: number;
  closed_count: number;
  status: "open" | "closed";
  created_at: string;
  updated_at: string;
}

interface CreateProblemMissionInput {
  projectId: string;
  conversationId: string;
  title: string;
  problemIds: string[];
}

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class ProblemMissionStore {
  constructor(private db: Database) {}

  create(input: CreateProblemMissionInput): ProblemMission {
    const title = input.title.trim();
    if (!title) throw new Error("titre de mission requis");
    if (input.problemIds.length === 0) throw new Error("une mission requiert une problématique");
    if (new Set(input.problemIds).size !== input.problemIds.length) {
      throw new Error("les problématiques doivent être distinctes");
    }

    const write = this.db.transaction(() => {
      const conversation = this.db.query(
        "SELECT project_id FROM conversations WHERE id = ?",
      ).get(input.conversationId) as { project_id: string } | null;
      if (!conversation || conversation.project_id !== input.projectId) {
        throw new Error("conversation d'un autre projet");
      }
      const placeholders = input.problemIds.map(() => "?").join(", ");
      const rows = this.db.query(
        `SELECT id FROM problems WHERE project_id = ? AND id IN (${placeholders})`,
      ).all(input.projectId, ...input.problemIds) as Array<{ id: string }>;
      if (rows.length !== input.problemIds.length) {
        throw new Error("problématique d'un autre projet ou inconnue");
      }

      const id = crypto.randomUUID();
      const publicId = this.nextPublicId();
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO problem_missions
          (id, public_id, project_id, conversation_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, publicId, input.projectId, input.conversationId, title.slice(0, 160), now, now);
      const insertItem = this.db.query(`
        INSERT INTO problem_mission_items (mission_id, problem_id, position, created_at)
        VALUES (?, ?, ?, ?)
      `);
      input.problemIds.forEach((problemId, position) => {
        insertItem.run(id, problemId, position, now);
      });
      return this.get(id)!;
    });
    return write();
  }

  get(id: string): ProblemMission | null {
    return this.queryOne("missions.id = ?", id);
  }

  getByConversation(conversationId: string): ProblemMission | null {
    return this.queryOne("missions.conversation_id = ?", conversationId);
  }

  listProject(projectId: string): ProblemMission[] {
    return this.query("missions.project_id = ?", projectId);
  }

  private queryOne(predicate: string, value: string): ProblemMission | null {
    return this.query(predicate, value)[0] ?? null;
  }

  private query(predicate: string, value: string): ProblemMission[] {
    const rows = this.db.query(`
      SELECT missions.*,
        COUNT(items.problem_id) AS problem_count,
        COALESCE(SUM(CASE WHEN problems.status = 'closed' THEN 1 ELSE 0 END), 0) AS closed_count,
        GROUP_CONCAT(items.problem_id, '|') AS problem_ids
      FROM problem_missions missions
      JOIN problem_mission_items items ON items.mission_id = missions.id
      JOIN problems ON problems.id = items.problem_id
      WHERE ${predicate}
      GROUP BY missions.id
      ORDER BY missions.created_at DESC, missions.id DESC
    `).all(value) as Record<string, unknown>[];
    return rows.map(hydrateMission);
  }

  private nextPublicId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let candidate = "MS-";
      for (let index = 0; index < 6; index += 1) {
        candidate += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)] ?? "0";
      }
      const exists = this.db.query(
        "SELECT 1 FROM problem_missions WHERE public_id = ?",
      ).get(candidate);
      if (!exists) return candidate;
    }
    throw new Error("impossible de créer un ID de mission unique");
  }
}

function hydrateMission(row: Record<string, unknown>): ProblemMission {
  const problemCount = Number(row.problem_count);
  const closedCount = Number(row.closed_count);
  return {
    id: String(row.id),
    public_id: String(row.public_id),
    project_id: String(row.project_id),
    conversation_id: String(row.conversation_id),
    title: String(row.title),
    problem_ids: String(row.problem_ids).split("|").filter(Boolean),
    problem_count: problemCount,
    closed_count: closedCount,
    status: closedCount === problemCount ? "closed" : "open",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
