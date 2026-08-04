export type ConversationActivityKind = "turn" | "debrief" | "handoff" | "model-change";

export class ConversationBusyError extends Error {
  constructor(readonly kind: ConversationActivityKind) {
    super("une opération est déjà en cours sur cette conversation");
  }
}

/** Verrou process-local unique pour toutes les mutations d'une conversation. */
export class ConversationActivity {
  private active = new Map<string, ConversationActivityKind>();

  isBusy(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  acquire(conversationId: string, kind: ConversationActivityKind): () => void {
    const current = this.active.get(conversationId);
    if (current) throw new ConversationBusyError(current);
    this.active.set(conversationId, kind);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(conversationId);
    };
  }

  async runExclusive<T>(
    conversationId: string,
    kind: ConversationActivityKind,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const release = this.acquire(conversationId, kind);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
