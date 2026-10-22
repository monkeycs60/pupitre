import ICAL from "ical.js";

export const GOOGLE_CALENDAR_TOKEN = "googleCalendar";
const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_OCCURRENCES = 20_000;

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO pour un rendez-vous horaire, `YYYY-MM-DD` pour une journée entière (fin exclue). */
  start: string;
  end: string;
  allDay: boolean;
}

export interface CalendarRange {
  configured: boolean;
  events: CalendarEvent[];
  error: string | null;
}

/** `webcal://` est le lien d'abonnement : le flux se lit en HTTPS. */
export function calendarFeedUrl(raw: string): string | null {
  const text = raw.trim().replace(/^webcal:\/\//i, "https://");
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const dayOf = (time: ICAL.Time) => `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;

function occurrence(id: string, event: ICAL.Event, start: ICAL.Time, end: ICAL.Time): CalendarEvent {
  const allDay = start.isDate;
  return {
    id,
    title: event.summary?.trim() || "(sans titre)",
    start: allDay ? dayOf(start) : start.toJSDate().toISOString(),
    end: allDay ? dayOf(end) : end.toJSDate().toISOString(),
    allDay,
  };
}

/** Rendez-vous du flux iCal qui touchent les jours locaux `from` à `to` inclus, récurrences déroulées. */
export function calendarEvents(ics: string, from: string, to: string): CalendarEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const zone of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(zone);
  const rangeStart = Date.parse(`${from}T00:00:00`);
  const rangeEnd = Date.parse(`${to}T00:00:00`) + 86_400_000;
  const overlaps = (item: CalendarEvent) => item.allDay
    ? item.start <= to && item.end > from
    : Date.parse(item.start) < rangeEnd && Date.parse(item.end) > rangeStart;

  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const component of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(component);
    if (event.isRecurrenceException()) exceptions.push(event);
    else masters.set(event.uid, event);
  }
  for (const exception of exceptions) masters.get(exception.uid)?.relateException(exception);

  const out: CalendarEvent[] = [];
  const keep = (item: CalendarEvent, status: unknown) => {
    if (status !== "CANCELLED" && overlaps(item)) out.push(item);
  };
  for (const event of masters.values()) {
    if (!event.startDate) continue;
    if (!event.isRecurring()) {
      keep(occurrence(event.uid, event, event.startDate, event.endDate ?? event.startDate), event.component.getFirstPropertyValue("status"));
      continue;
    }
    const iterator = event.iterator();
    for (let index = 0, next = iterator.next(); next && index < MAX_OCCURRENCES; index += 1, next = iterator.next()) {
      const details = event.getOccurrenceDetails(next);
      const item = occurrence(`${event.uid}/${details.recurrenceId.toString()}`, details.item, details.startDate, details.endDate);
      if (item.allDay ? item.start > to : Date.parse(item.start) >= rangeEnd) break;
      keep(item, details.item.component.getFirstPropertyValue("status"));
    }
  }
  for (const exception of exceptions) {
    if (!masters.has(exception.uid)) keep(occurrence(`${exception.uid}/${exception.recurrenceId.toString()}`, exception, exception.startDate, exception.endDate), exception.component.getFirstPropertyValue("status"));
  }
  return out.sort((left, right) => left.start.localeCompare(right.start));
}

export class GoogleCalendarService {
  private cache: { url: string; at: number; ics: string } | null = null;

  constructor(
    private readUrl: () => string | null,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async range(from: string, to: string): Promise<CalendarRange> {
    const raw = this.readUrl();
    const url = raw ? calendarFeedUrl(raw) : null;
    if (!url) return { configured: false, events: [], error: null };
    let error: string | null = null;
    if (!this.cache || this.cache.url !== url || this.now() - this.cache.at > CACHE_MS) {
      try {
        const response = await this.fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`Google Agenda a répondu ${response.status}`);
        this.cache = { url, at: this.now(), ics: await response.text() };
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Google Agenda injoignable";
      }
    }
    if (!this.cache || this.cache.url !== url) return { configured: true, events: [], error };
    try {
      return { configured: true, events: calendarEvents(this.cache.ics, from, to), error };
    } catch {
      return { configured: true, events: [], error: "Flux iCal illisible" };
    }
  }
}
