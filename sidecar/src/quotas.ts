import type { Database } from "bun:sqlite";
import type { AppEvent, Provider } from "./events";

// Le QuotaTracker normalise les payloads bruts de quota des deux providers dans
// une forme unique, la garde en mémoire, la persiste (table `quota_state`) et
// notifie ses abonnés (WS `/ws?channel=quotas`).
//
// Payloads de référence (cf. tests/fixtures/README.md) :
// - claude : `rate_limit_event.rate_limit_info`
//   {status, resetsAt: <epoch s>, rateLimitType: "five_hour", …} — pas de %.
// - codex  : `account/rateLimits/updated` → params.rateLimits
//   {primary:{usedPercent, windowDurationMins, resetsAt}, secondary:…|null, …}.

export interface QuotaWindow {
  /** Identifiant stable de la fenêtre pour ce provider (clé de merge). */
  label: string;
  /** null = le provider ne publie pas de pourcentage pour cette fenêtre. */
  usedPercent: number | null;
  /** Date ISO 8601 de remise à zéro, ou null si inconnue. */
  resetsAt: string | null;
  windowDurationMins: number | null;
}

export interface QuotaState {
  provider: Provider;
  windows: QuotaWindow[];
  updatedAt: string;
}

export interface QuotaSnapshot {
  claude: QuotaState | null;
  codex: QuotaState | null;
}

type QuotaListener = (state: QuotaState) => void;

// Durées connues des fenêtres claude (le payload ne les porte pas).
const CLAUDE_WINDOW_MINS: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
  weekly: 10_080,
  opus_weekly: 10_080,
  seven_day_opus: 10_080,
};

export class QuotaTracker {
  private states = new Map<Provider, QuotaState>();
  private listeners = new Set<QuotaListener>();

  constructor(private db: Database) {
    const rows = this.db.query("SELECT key, value FROM quota_state").all() as {
      key: string;
      value: string;
    }[];
    for (const row of rows) {
      if (row.key !== "claude" && row.key !== "codex") continue;
      try {
        this.states.set(row.key, JSON.parse(row.value) as QuotaState);
      } catch (error) {
        console.error("État de quota corrompu, ligne ignorée", error);
      }
    }
  }

  get(provider: Provider): QuotaState | null {
    return this.states.get(provider) ?? null;
  }

  snapshot(): QuotaSnapshot {
    return { claude: this.get("claude"), codex: this.get("codex") };
  }

  subscribe(listener: QuotaListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** No-op sur les events non rate-limit : branchable tel quel sur un emit. */
  ingest(event: AppEvent): QuotaState | null {
    if (event.type !== "rate-limit") return null;
    // account/rateLimits/updated est une mise à jour clairsemée : un champ null
    // signifie « indisponible dans cet update », pas « fenêtre supprimée ».
    return this.update(event.provider, event.payload, false);
  }

  /** Ingestion directe du snapshot complet `account/rateLimits/read`. */
  ingestPayload(provider: Provider, payload: unknown): QuotaState | null {
    return this.update(provider, payload, true);
  }

  private update(
    provider: Provider,
    payload: unknown,
    replaceCodexSnapshot: boolean,
  ): QuotaState | null {
    const windows = provider === "claude"
      ? claudeWindows(payload)
      : codexWindows(payload);
    if (
      windows.length === 0
      && (
        provider === "claude"
        || !replaceCodexSnapshot
        || !isCodexSnapshot(payload)
      )
    ) return null;

    // Claude et les notifications Codex sont clairsemés : merge. Seul le poll
    // Codex explicite est un snapshot complet et peut retirer une fenêtre.
    const merged = new Map<string, QuotaWindow>();
    if (provider === "claude" || !replaceCodexSnapshot) {
      for (const window of this.get(provider)?.windows ?? []) {
        merged.set(window.label, window);
      }
    }
    for (const window of windows) merged.set(window.label, window);

    const state: QuotaState = {
      provider,
      windows: [...merged.values()],
      updatedAt: new Date().toISOString(),
    };
    this.states.set(provider, state);
    this.db.query(
      `INSERT INTO quota_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(provider, JSON.stringify(state));
    for (const listener of this.listeners) listener(state);
    return state;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Les deux providers datent en secondes epoch ; on tolère les millisecondes. */
function toIsoDate(value: unknown): string | null {
  const seconds = optionalNumber(value);
  if (seconds === null) return null;
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function claudeWindows(payload: unknown): QuotaWindow[] {
  // Tolérant : payload = rate_limit_info, ou l'event entier qui le contient.
  const root = asRecord(payload);
  const info = asRecord(root?.rate_limit_info) ?? root;
  if (!info) return [];
  const label = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  if (!label) return [];
  return [{
    label,
    // Claude ne publie pas de pourcentage aujourd'hui : on le lit s'il apparaît.
    usedPercent: optionalNumber(info.usedPercent) ?? optionalNumber(info.used_percent),
    resetsAt: toIsoDate(info.resetsAt ?? info.resets_at),
    windowDurationMins: CLAUDE_WINDOW_MINS[label] ?? null,
  }];
}

function codexWindows(payload: unknown): QuotaWindow[] {
  const root = asRecord(payload);
  // Le résultat de `account/rateLimits/read` enveloppe l'objet dans `rateLimits`.
  const limits = asRecord(root?.rateLimits) ?? root;
  if (!limits) return [];
  const windows: QuotaWindow[] = [];
  for (const label of ["primary", "secondary"]) {
    const window = asRecord(limits[label]);
    if (!window) continue;
    const usedPercent = optionalNumber(window.usedPercent);
    const resetsAt = toIsoDate(window.resetsAt);
    const windowDurationMins = optionalNumber(window.windowDurationMins);
    if (usedPercent === null && resetsAt === null && windowDurationMins === null) {
      continue;
    }
    windows.push({ label, usedPercent, resetsAt, windowDurationMins });
  }
  return windows;
}

/** Un snapshot Codex avec primary/secondary à null reste un snapshot valide. */
function isCodexSnapshot(payload: unknown): boolean {
  const root = asRecord(payload);
  const limits = asRecord(root?.rateLimits) ?? root;
  return limits !== null && ("primary" in limits || "secondary" in limits);
}
