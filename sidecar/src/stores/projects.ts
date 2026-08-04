import type { Database } from "bun:sqlite";

export interface Project {
  id: string; name: string; path: string;
  permission_mode: string; pinned: boolean; created_at: string;
}

export class ProjectStore {
  constructor(private db: Database) {}

  create(input: { name: string; path: string }): Project {
    const id = crypto.randomUUID();
    this.db.query(
      "INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, input.name, input.path, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): Project | null {
    const row = this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as any;
    return row ? { ...row, pinned: !!row.pinned } : null;
  }

  list(): Project[] {
    const rows = this.db.query(
      "SELECT * FROM projects ORDER BY pinned DESC, created_at DESC"
    ).all() as any[];
    return rows.map((r) => ({ ...r, pinned: !!r.pinned }));
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.query("UPDATE projects SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
  }
}
