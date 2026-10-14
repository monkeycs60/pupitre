import type { QuotaSnapshot, QuotaTracker } from "./quotas";
import { ClaudeUsageRateLimitedError, readClaudeUsage } from "./adapters/claude-usage";
import { readGrokUsage } from "./adapters/grok-usage";
import { readOpenCodeGoUsage } from "./adapters/opencode-go-usage";
import { codexAppServer } from "./adapters/codex-app-server";

// Les providers exposent une lecture d'état pure et gratuite :
//   - codex  : `account/rateLimits/read` sur son app-server ;
//   - claude : `GET /api/oauth/usage` avec le jeton de Claude Code ;
//   - grok   : `GET …/v1/billing?format=credits` avec le jeton de `grok login`.
// Le rafraîchisseur les relève ensemble, sans jamais consommer de quota — d'où
// la relève périodique, qui garde la barre vivante pendant une session.

/** Cadence de la relève de fond. Trois lectures gratuites : rien à économiser. */
export const QUOTA_POLL_MS = 5 * 60 * 1000;

interface QuotaRefreshDeps {
  readCodexRateLimits?: () => Promise<unknown>;
  readClaudeUsage?: () => Promise<unknown | null>;
  readGrokUsage?: () => Promise<unknown | null>;
  readOpenCodeGoUsage?: () => Promise<unknown | null>;
  now?: () => number;
}

export class QuotaRefreshIncompleteError extends Error {}

function minutesUntil(at: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  return minutes === 1 ? "1 min" : `${minutes} min`;
}

export class QuotaRefresher {
  private inFlight: Promise<QuotaSnapshot> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private claudeRetryAt: number | null = null;
  private claudeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private now: () => number;
  private readCodex: () => Promise<unknown>;
  private readClaude: () => Promise<unknown | null>;
  private readGrok: () => Promise<unknown | null>;
  private readReasonix: () => Promise<unknown | null>;

  constructor(private quotas: QuotaTracker, deps: QuotaRefreshDeps = {}) {
    this.readCodex = deps.readCodexRateLimits
      ?? (() => codexAppServer.readRateLimits());
    this.readClaude = deps.readClaudeUsage ?? (() => readClaudeUsage());
    this.readGrok = deps.readGrokUsage ?? (() => readGrokUsage());
    this.readReasonix = deps.readOpenCodeGoUsage ?? (() => readOpenCodeGoUsage());
    this.now = deps.now ?? Date.now;
  }

  refresh(): Promise<QuotaSnapshot> {
    // Un seul passage à la fois : la relève périodique et un clic simultané ne
    // doivent pas partir en double.
    if (this.inFlight) return this.inFlight;
    const run = this.run().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /** Relève immédiate puis périodique. Idempotent. */
  start(intervalMs: number = QUOTA_POLL_MS): void {
    void this.refresh().catch(() => {});
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.claudeRetryTimer !== null) clearTimeout(this.claudeRetryTimer);
    this.claudeRetryTimer = null;
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async readClaudeRespectingLimit(): Promise<unknown | null> {
    if (this.claudeRetryAt !== null && this.now() < this.claudeRetryAt) return null;
    try {
      const usage = await this.readClaude();
      this.claudeRetryAt = null;
      return usage;
    } catch (error) {
      if (!(error instanceof ClaudeUsageRateLimitedError)) throw error;
      this.claudeRetryAt = error.retryAt;
      this.scheduleClaudeRetry(error.retryAt);
      return null;
    }
  }

  private scheduleClaudeRetry(at: number): void {
    if (this.claudeRetryTimer !== null) clearTimeout(this.claudeRetryTimer);
    this.claudeRetryTimer = setTimeout(() => {
      this.claudeRetryTimer = null;
      void this.refresh().catch(() => {});
    }, Math.max(0, at - this.now()) + 1_000);
    this.claudeRetryTimer.unref?.();
  }

  private async run(): Promise<QuotaSnapshot> {
    // Une source indisponible ne doit jamais effacer l'autre, ni l'état stocké.
    await Promise.all([
      this.readCodex()
        .then((rateLimits) => {
          if (rateLimits) this.quotas.ingestPayload("codex", rateLimits);
        })
        .catch(() => {}),
      this.readClaudeRespectingLimit()
        .then((usage) => {
          if (usage) this.quotas.ingestPayload("claude", usage);
        })
        .catch(() => {}),
      this.readGrok()
        .then((usage) => {
          if (usage) this.quotas.ingestPayload("grok", usage);
        })
        .catch(() => {}),
      this.readReasonix()
        .then((usage) => {
          if (usage) this.quotas.ingestPayload("reasonix", usage);
        })
        .catch(() => {}),
    ]);
    if (this.claudeRetryAt !== null && this.now() < this.claudeRetryAt) {
      throw new QuotaRefreshIncompleteError(
        `Claude limite la lecture de ses quotas : nouvel essai automatique dans ${minutesUntil(this.claudeRetryAt, this.now())}.`,
      );
    }
    return this.quotas.snapshot();
  }
}
