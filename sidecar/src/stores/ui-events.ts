import type { Database } from "bun:sqlite";
import { USAGE_CATALOG } from "../../../ui/src/usageCatalog";
import { localDay } from "../time-tracking";

export const UI_EVENT_BATCH_MAX = 200;
export const UI_EVENT_PROPS_MAX_BYTES = 1_024;
export const UI_EVENT_RETENTION_DAYS = 180;
const UI_EVENT_NAME = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
const UI_EVENT_NAME_MAX_LENGTH = 64;
const DAY_MS = 86_400_000;

export interface UiEventRow {
  at: string;
  name: string;
  projectId: string | null;
  props: string | null;
}

export interface UsageReport {
  since: string;
  until: string;
  catalog: Array<{ feature: string; label: string; area: string; count: number; lastAt: string | null }>;
  events: Array<{ name: string; count: number; lastAt: string }>;
  daily: Array<{ day: string; count: number }>;
  background: Array<{ kind: string; count: number }>;
}

function serializedProps(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter(([, item]) =>
    typeof item === "string"
    || typeof item === "boolean"
    || (typeof item === "number" && Number.isFinite(item)));
  if (entries.length === 0) return null;
  const json = JSON.stringify(Object.fromEntries(entries));
  return Buffer.byteLength(json) <= UI_EVENT_PROPS_MAX_BYTES ? json : null;
}

export function validUiEvents(events: unknown[]): UiEventRow[] {
  const valid: UiEventRow[] = [];
  for (const event of events.slice(0, UI_EVENT_BATCH_MAX)) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;
    const { at, name, projectId, props } = event as Record<string, unknown>;
    if (typeof name !== "string" || name.length > UI_EVENT_NAME_MAX_LENGTH || !UI_EVENT_NAME.test(name)) continue;
    const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(time)) continue;
    valid.push({
      at: new Date(time).toISOString(),
      name,
      projectId: typeof projectId === "string" && projectId !== "" ? projectId : null,
      props: serializedProps(props),
    });
  }
  return valid;
}

export class UiEventStore {
  constructor(private readonly db: Database) {}

  record(events: UiEventRow[]): void {
    const insert = this.db.query("INSERT INTO ui_events (at, name, project_id, props) VALUES (?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const event of events) insert.run(event.at, event.name, event.projectId, event.props);
    })();
  }

  purge(now = new Date()): number {
    const cutoff = new Date(now.getTime() - UI_EVENT_RETENTION_DAYS * DAY_MS).toISOString();
    return this.db.query("DELETE FROM ui_events WHERE at < ?").run(cutoff).changes;
  }

  usage(days: number, now = new Date()): UsageReport {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const since = start.toISOString();
    const until = now.toISOString();
    const events = this.db.query(`
      SELECT name, COUNT(*) AS count, MAX(at) AS lastAt
      FROM ui_events
      WHERE at >= ? AND at <= ?
      GROUP BY name
      ORDER BY count DESC, name
    `).all(since, until) as UsageReport["events"];
    const byName = new Map(events.map((event) => [event.name, event]));
    const byValue = this.db.query(`
      SELECT json_extract(props, ?) AS value, COUNT(*) AS count, MAX(at) AS lastAt
      FROM ui_events
      WHERE name = ? AND at >= ? AND at <= ?
      GROUP BY value
    `);
    const breakdowns = new Map<string, Map<unknown, { count: number; lastAt: string }>>();
    for (const { event, match } of USAGE_CATALOG) {
      const key = match && `${event} ${match.prop}`;
      if (!key || breakdowns.has(key)) continue;
      const rows = byValue.all(`$.${match.prop}`, event, since, until) as Array<{ value: unknown; count: number; lastAt: string }>;
      breakdowns.set(key, new Map(rows.map((row) => [row.value, row])));
    }
    const catalog = USAGE_CATALOG.map((entry) => {
      const usage = entry.match
        ? breakdowns.get(`${entry.event} ${entry.match.prop}`)?.get(entry.match.value)
        : byName.get(entry.event);
      return {
        feature: entry.feature,
        label: entry.label,
        area: entry.area,
        count: usage?.count ?? 0,
        lastAt: usage?.lastAt ?? null,
      };
    });
    // `date(at, 'localtime')` coûte environ 3 µs par ligne. Tout fuseau réel est décalé
    // d'un multiple de 15 min : un créneau UTC de 15 min ne chevauche jamais un minuit local.
    const slots = this.db.query(`
      SELECT printf('%s%02d', substr(at, 1, 14), substr(at, 15, 2) / 15 * 15) AS slot, COUNT(*) AS count
      FROM ui_events
      WHERE at >= ? AND at <= ?
      GROUP BY slot
    `).all(since, until) as Array<{ slot: string; count: number }>;
    const countByDay = new Map<string, number>();
    for (const { slot, count } of slots) {
      const day = localDay(new Date(`${slot}:00.000Z`));
      countByDay.set(day, (countByDay.get(day) ?? 0) + count);
    }
    const daily: UsageReport["daily"] = [];
    for (const day = new Date(start); day <= now; day.setDate(day.getDate() + 1)) {
      daily.push({ day: localDay(day), count: countByDay.get(localDay(day)) ?? 0 });
    }
    return { since, until, catalog, events, daily, background: this.background(localDay(start)) };
  }

  private background(sinceDay: string): UsageReport["background"] {
    // La table naît avec AutomaticCalls, pas avec openDb : elle peut manquer.
    const counted = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'automatic_call_counts'").get();
    if (!counted) return [];
    // `day` y est un jour UTC, comparé ici à un jour local : la borne glisse de l'écart horaire.
    return this.db.query(`
      SELECT kind, SUM(count) AS count
      FROM automatic_call_counts
      WHERE day >= ?
      GROUP BY kind
      ORDER BY count DESC, kind
    `).all(sinceDay) as UsageReport["background"];
  }
}
