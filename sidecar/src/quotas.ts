import type { Database } from "bun:sqlite";
import type { AppEvent, Provider } from "./events";

// Le QuotaTracker normalise les payloads bruts de quota des deux providers dans
// une forme unique, la garde en mémoire, la persiste (table `quota_state`) et
// notifie ses abonnés (WS `/ws?channel=quotas`).
//
// Payloads de référence (cf. tests/fixtures/README.md) :
// - claude, source riche : `GET /api/oauth/usage` (cf. adapters/claude-usage.ts)
//   {five_hour:{utilization, resets_at}, limits:[{kind, percent, resets_at,
//    scope}], …} — avec de vrais pourcentages, dont une fenêtre hebdo par modèle.
// - claude, source de repli : `rate_limit_event.rate_limit_info`
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

  /**
   * Ingestion d'un relevé complet : `account/rateLimits/read` côté codex,
   * `GET /api/oauth/usage` côté claude. Un snapshot fait autorité et peut donc
   * retirer une fenêtre disparue, contrairement aux updates du flux.
   */
  ingestPayload(provider: Provider, payload: unknown): QuotaState | null {
    return this.update(provider, payload, true);
  }

  private update(
    provider: Provider,
    payload: unknown,
    isFullSnapshot: boolean,
  ): QuotaState | null {
    const parsed = provider === "claude"
      ? claudeQuota(payload)
      : provider === "codex"
        ? codexQuota(payload)
        : { windows: [] as QuotaWindow[], isComplete: false };
    // Un payload clairsemé reste clairsemé même si l'appelant croit tenir un
    // snapshot : la forme du payload a le dernier mot sur son exhaustivité.
    const replace = isFullSnapshot && parsed.isComplete;
    if (parsed.windows.length === 0 && !replace) return null;

    const merged = new Map<string, QuotaWindow>();
    if (!replace) {
      for (const window of this.get(provider)?.windows ?? []) {
        merged.set(window.label, window);
      }
    }
    for (const window of parsed.windows) {
      merged.set(window.label, mergeWindow(merged.get(window.label), window));
    }

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

/**
 * Les flux datent en secondes epoch (millisecondes tolérées) ; l'endpoint OAuth
 * date en ISO 8601. On accepte les deux.
 */
function toIsoDate(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const seconds = optionalNumber(value);
  if (seconds === null) return null;
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Deux relevés décrivent-ils la même fenêtre ? Les sources ne datent pas avec
 * la même précision — l'endpoint OAuth va à la milliseconde, le flux d'un tour
 * arrondit à la seconde. Une comparaison stricte verrait une fenêtre neuve à
 * chaque tour et perdrait le pourcentage à chaque fois.
 */
function sameWindow(left: QuotaWindow, right: QuotaWindow): boolean {
  if (left.resetsAt === null || right.resetsAt === null) {
    return left.resetsAt === right.resetsAt;
  }
  const from = Date.parse(left.resetsAt);
  const to = Date.parse(right.resetsAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return left.resetsAt === right.resetsAt;
  return Math.abs(from - to) < 1_000;
}

/**
 * Un update clairsemé ne doit jamais dégrader ce qu'on sait déjà. Le
 * `rate_limit_event` du flux ne porte pas de pourcentage : reçu après un relevé
 * OAuth, il effacerait l'usage de la même fenêtre s'il l'écrasait tel quel. En
 * revanche, un `resetsAt` qui a bougé annonce la fenêtre SUIVANTE : là, l'usage
 * précédent ne la décrit plus et doit disparaître.
 */
function mergeWindow(
  existing: QuotaWindow | undefined,
  incoming: QuotaWindow,
): QuotaWindow {
  if (!existing || !sameWindow(existing, incoming)) return incoming;
  return {
    ...incoming,
    usedPercent: incoming.usedPercent ?? existing.usedPercent,
    windowDurationMins: incoming.windowDurationMins ?? existing.windowDurationMins,
  };
}

/** Nom de fenêtre stable pour une limite scopée : `seven_day_fable`. */
function scopedLabel(base: string, scope: unknown): string {
  const model = asRecord(asRecord(scope)?.model);
  const name = typeof model?.display_name === "string" ? model.display_name : null;
  if (name === null) return base;
  return `${base}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Les `limits[]` de `/api/oauth/usage` : la source riche, avec pourcentages. */
function oauthUsageWindows(limits: unknown[]): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const entry of limits) {
    const limit = asRecord(entry);
    if (!limit) continue;
    const kind = typeof limit.kind === "string" ? limit.kind : null;
    if (kind === null) continue;
    const label = kind === "session"
      ? "five_hour"
      : kind === "weekly_all"
        ? "seven_day"
        : kind === "weekly_scoped"
          ? scopedLabel("seven_day", limit.scope)
          : kind;
    windows.push({
      label,
      usedPercent: optionalNumber(limit.percent),
      resetsAt: toIsoDate(limit.resets_at),
      windowDurationMins: CLAUDE_WINDOW_MINS[label]
        ?? (label.startsWith("seven_day") ? 10_080 : null),
    });
  }
  return windows;
}

interface ParsedQuota {
  windows: QuotaWindow[];
  /**
   * Le payload décrit-il TOUTES les fenêtres du provider ? Un relevé complet
   * fait autorité et peut donc en retirer une ; un update clairsemé ne peut que
   * compléter. Un relevé complet mais vide reste complet : il dit « plus aucune
   * fenêtre », et c'est différent d'un payload illisible.
   */
  isComplete: boolean;
}

function claudeQuota(payload: unknown): ParsedQuota {
  const root = asRecord(payload);
  if (!root) return { windows: [], isComplete: false };

  // Source riche : la réponse de `/api/oauth/usage`, exhaustive par construction.
  if (Array.isArray(root.limits)) {
    return { windows: oauthUsageWindows(root.limits), isComplete: true };
  }

  // Repli : `rate_limit_event`, qui ne décrit qu'une fenêtre à la fois.
  // Tolérant — payload = rate_limit_info, ou l'event entier qui le contient.
  const info = asRecord(root.rate_limit_info) ?? root;
  const label = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  if (!label) return { windows: [], isComplete: false };
  return {
    isComplete: false,
    windows: [{
      label,
      // Le flux ne publie pas de pourcentage : on le lit s'il apparaît un jour.
      usedPercent: optionalNumber(info.usedPercent) ?? optionalNumber(info.used_percent),
      resetsAt: toIsoDate(info.resetsAt ?? info.resets_at),
      windowDurationMins: CLAUDE_WINDOW_MINS[label] ?? null,
    }],
  };
}

function codexQuota(payload: unknown): ParsedQuota {
  const root = asRecord(payload);
  // Le résultat de `account/rateLimits/read` enveloppe l'objet dans `rateLimits`.
  const limits = asRecord(root?.rateLimits) ?? root;
  if (!limits) return { windows: [], isComplete: false };
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
  // `read` et `updated` partagent la même forme : seul l'appelant sait laquelle
  // il tient. On lui laisse donc le choix, en exigeant un payload reconnaissable
  // pour qu'un `null` de réseau ne puisse pas passer pour un relevé vide.
  return {
    windows,
    isComplete: "primary" in limits || "secondary" in limits,
  };
}
