import type { Database } from "bun:sqlite";
import type { AppEvent, StoredEvent, TestScopeEvent } from "../events";

export type TestScopeStatus = "pending" | "running" | "passed" | "failed";
export type TestMethodKind = "unit" | "browser" | "manual";

export interface TestMethod {
  kind: TestMethodKind;
  label: string;
  instructions: string;
}

export interface TestScope {
  id: string;
  inventory_id: string;
  title: string;
  description: string;
  methods: TestMethod[];
  guardian_flag_ids: string[];
  status: TestScopeStatus;
  subtask_id: string | null;
  evidence_md: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestInventory {
  id: string;
  conversation_id: string;
  event_id_from: number;
  event_id_to: number;
  created_at: string;
  scopes: TestScope[];
}

export interface TestScopeInput {
  title: string;
  description: string;
  methods: TestMethod[];
  guardianFlagIds: string[];
}

export class TestScopeAlreadyRunningError extends Error {}

export class TestingStore {
  constructor(private db: Database) {
    this.sweepInterruptedScopes();
  }

  getInventory(id: string): TestInventory | null {
    const row = this.db.query("SELECT * FROM test_inventories WHERE id = ?").get(id) as
      Omit<TestInventory, "scopes"> | null;
    return row ? { ...row, scopes: this.listScopes(id) } : null;
  }

  getScope(id: string): TestScope | null {
    const row = this.db.query("SELECT * FROM test_scopes WHERE id = ?").get(id) as any;
    return row ? hydrateScope(row) : null;
  }

  listScopes(inventoryId: string): TestScope[] {
    const rows = this.db.query(`
      SELECT * FROM test_scopes WHERE inventory_id = ? ORDER BY created_at, id
    `).all(inventoryId) as any[];
    return rows.map(hydrateScope);
  }

  createWithReference(input: {
    conversationId: string;
    eventIdFrom: number;
    eventIdTo: number;
    scopes: TestScopeInput[];
  }): { inventory: TestInventory; event: StoredEvent } {
    const create = this.db.transaction(() => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.db.query(`
        INSERT INTO test_inventories
          (id, conversation_id, event_id_from, event_id_to, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, input.conversationId, input.eventIdFrom, input.eventIdTo, now);
      const insert = this.db.query(`
        INSERT INTO test_scopes
          (id, inventory_id, title, description, methods_json, guardian_flag_ids,
           status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `);
      for (const scope of input.scopes) {
        insert.run(
          crypto.randomUUID(), id, scope.title, scope.description,
          JSON.stringify(scope.methods), JSON.stringify(scope.guardianFlagIds), now, now,
        );
      }
      const inventory = this.getInventory(id)!;
      const reference: AppEvent = {
        type: "test-inventory-ref",
        inventoryId: inventory.id,
        scopes: inventory.scopes.map(scopeEvent),
        createdAt: inventory.created_at,
      };
      return {
        inventory,
        event: this.appendEvent(input.conversationId, reference, now),
      };
    });
    return create();
  }

  reserveScope(id: string): TestScope | null {
    const reserve = this.db.transaction(() => {
      const current = this.getScope(id);
      if (!current) return null;
      if (current.status === "running") {
        throw new TestScopeAlreadyRunningError("ce scope est déjà en cours");
      }
      this.db.query(`
        UPDATE test_scopes
        SET status = 'running', subtask_id = NULL, evidence_md = NULL,
            error = NULL, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id);
      return this.getScope(id);
    });
    return reserve();
  }

  attachSubtask(id: string, subtaskId: string): { scope: TestScope; event: StoredEvent } {
    const attach = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.query(`
        UPDATE test_scopes SET subtask_id = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(subtaskId, now, id);
      const scope = this.getScope(id);
      if (!scope) throw new Error("scope de test inconnu");
      const conversationId = this.conversationId(scope.inventory_id);
      const event: AppEvent = {
        type: "test-scope-started",
        inventoryId: scope.inventory_id,
        scopeId: scope.id,
        subtaskId,
        startedAt: now,
      };
      return { scope, event: this.appendEvent(conversationId, event, now) };
    });
    return attach();
  }

  completeScope(input: {
    id: string;
    status: "passed" | "failed";
    evidenceMd: string;
    error?: string | null;
    guardianFlagIdsAcked: string[];
  }, ackFlags?: () => string[]): { scope: TestScope; event: StoredEvent } {
    const complete = this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.query(`
        UPDATE test_scopes
        SET status = ?, evidence_md = ?, error = ?, updated_at = ?
        WHERE id = ?
      `).run(input.status, input.evidenceMd, input.error ?? null, now, input.id);
      const scope = this.getScope(input.id);
      if (!scope) throw new Error("scope de test inconnu");
      const guardianFlagIdsAcked = input.status === "passed" && ackFlags
        ? ackFlags()
        : input.guardianFlagIdsAcked;
      const conversationId = this.conversationId(scope.inventory_id);
      const event: AppEvent = {
        type: "test-scope-result",
        inventoryId: scope.inventory_id,
        scopeId: scope.id,
        status: input.status,
        evidenceMd: input.evidenceMd,
        guardianFlagIdsAcked,
        completedAt: now,
        ...(input.error ? { error: input.error } : {}),
      };
      return { scope, event: this.appendEvent(conversationId, event, now) };
    });
    return complete();
  }

  private conversationId(inventoryId: string): string {
    const row = this.db.query(`
      SELECT conversation_id FROM test_inventories WHERE id = ?
    `).get(inventoryId) as { conversation_id: string } | null;
    if (!row) throw new Error("inventaire de test inconnu");
    return row.conversation_id;
  }

  private appendEvent(
    conversationId: string,
    event: AppEvent,
    now: string,
  ): StoredEvent {
    const result = this.db.query(`
      INSERT INTO events (conversation_id, payload, created_at) VALUES (?, ?, ?)
    `).run(conversationId, JSON.stringify(event), now);
    this.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(now, conversationId);
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  private sweepInterruptedScopes(): void {
    const interrupted = this.db.query(`
      SELECT scopes.id, scopes.inventory_id, inventories.conversation_id
      FROM test_scopes scopes
      JOIN test_inventories inventories ON inventories.id = scopes.inventory_id
      WHERE scopes.status = 'running'
    `).all() as Array<{ id: string; inventory_id: string; conversation_id: string }>;
    if (interrupted.length === 0) return;
    const sweep = this.db.transaction(() => {
      for (const scope of interrupted) {
        const now = new Date().toISOString();
        const evidence = "Le sidecar a redémarré avant la fin de ce scope de test.";
        this.db.query(`
          UPDATE test_scopes
          SET status = 'failed', evidence_md = ?, error = ?, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(evidence, "interrompu (sidecar redémarré)", now, scope.id);
        this.appendEvent(scope.conversation_id, {
          type: "test-scope-result",
          inventoryId: scope.inventory_id,
          scopeId: scope.id,
          status: "failed",
          evidenceMd: evidence,
          guardianFlagIdsAcked: [],
          completedAt: now,
          error: "interrompu (sidecar redémarré)",
        }, now);
      }
    });
    sweep();
  }
}

function hydrateScope(row: any): TestScope {
  return {
    ...row,
    methods: parseArray<TestMethod>(row.methods_json),
    guardian_flag_ids: parseArray<string>(row.guardian_flag_ids),
  } as TestScope;
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function scopeEvent(scope: TestScope): TestScopeEvent {
  return {
    id: scope.id,
    title: scope.title,
    description: scope.description,
    methods: scope.methods,
    guardianFlagIds: scope.guardian_flag_ids,
    status: scope.status,
    subtaskId: scope.subtask_id,
    evidenceMd: scope.evidence_md,
    error: scope.error,
  };
}
