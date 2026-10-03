import type { Database } from "bun:sqlite";
export class AutomaticCalls {
  private windows = new Map<string, { started: number; count: number }>();
  constructor(private db: Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS automatic_call_counts(day TEXT NOT NULL,kind TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,kind))",
    );
  }
  async run<T>(kind: string, generate: () => Promise<T>): Promise<T> {
    const now = Date.now();
    let window = this.windows.get(kind);
    if (!window || now - window.started >= 300000) {
      window = { started: now, count: 0 };
      this.windows.set(kind, window);
    }
    if (window.count >= 10)
      throw new Error(`Plafond des appels automatiques atteint : ${kind}`);
    window.count++;
    this.db
      .query(
        "INSERT INTO automatic_call_counts VALUES (?,?,1) ON CONFLICT(day,kind) DO UPDATE SET count=count+1",
      )
      .run(new Date().toISOString().slice(0, 10), kind);
    return generate();
  }
  list() {
    return this.db
      .query(
        "SELECT day,kind,count FROM automatic_call_counts ORDER BY day DESC,kind LIMIT 100",
      )
      .all();
  }
}
