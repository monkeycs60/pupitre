import { expect, test } from "bun:test";
import { calendarEvents, calendarFeedUrl, GoogleCalendarService } from "../src/google-calendar";

const PARIS = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Paris",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const feed = (...events: string[][]) => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  ...PARIS,
  ...events.flat(),
  "END:VCALENDAR",
].join("\r\n");

const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];

test("un rendez-vous horaire garde son fuseau", () => {
  const ics = feed(event("UID:a", "SUMMARY:Alfred - Point stage", "DTSTART;TZID=Europe/Paris:20261027T100000", "DTEND;TZID=Europe/Paris:20261027T110000"));
  expect(calendarEvents(ics, "2026-10-26", "2026-11-01")).toEqual([
    { id: "a", title: "Alfred - Point stage", start: "2026-10-27T09:00:00.000Z", end: "2026-10-27T10:00:00.000Z", allDay: false },
  ]);
});

test("hors de la plage, rien ne remonte", () => {
  const ics = feed(event("UID:a", "SUMMARY:Ailleurs", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z"));
  expect(calendarEvents(ics, "2026-10-26", "2026-11-01")).toEqual([]);
});

test("une récurrence se déroule, avec ses exclusions et ses déplacements", () => {
  const ics = feed(
    event("UID:r", "SUMMARY:Point hebdo", "DTSTART:20260105T090000Z", "DTEND:20260105T093000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE:20261028T090000Z"),
    event("UID:r", "SUMMARY:Point hebdo décalé", "RECURRENCE-ID:20261026T090000Z", "DTSTART:20261026T140000Z", "DTEND:20261026T150000Z"),
  );
  expect(calendarEvents(ics, "2026-10-26", "2026-11-01").map((item) => [item.title, item.start])).toEqual([
    ["Point hebdo décalé", "2026-10-26T14:00:00.000Z"],
  ]);
});

test("une journée entière reste exprimée en jours", () => {
  const ics = feed(event("UID:d", "SUMMARY:Congrès", "DTSTART;VALUE=DATE:20261029", "DTEND;VALUE=DATE:20261031"));
  expect(calendarEvents(ics, "2026-10-26", "2026-11-01")).toEqual([
    { id: "d", title: "Congrès", start: "2026-10-29", end: "2026-10-31", allDay: true },
  ]);
});

test("un rendez-vous annulé disparaît", () => {
  const ics = feed(event("UID:c", "SUMMARY:Annulé", "STATUS:CANCELLED", "DTSTART:20261027T100000Z", "DTEND:20261027T110000Z"));
  expect(calendarEvents(ics, "2026-10-26", "2026-11-01")).toEqual([]);
});

test("le lien webcal se lit en HTTPS et le reste est refusé", () => {
  expect(calendarFeedUrl("webcal://calendar.google.com/calendar/ical/x/basic.ics")).toBe("https://calendar.google.com/calendar/ical/x/basic.ics");
  expect(calendarFeedUrl("pas une adresse")).toBeNull();
  expect(calendarFeedUrl("file:///etc/passwd")).toBeNull();
});

test("le flux est mis en cache, et l'ancien sert encore quand Google ne répond plus", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const ics = feed(event("UID:a", "SUMMARY:Rdv", "DTSTART:20261027T100000Z", "DTEND:20261027T110000Z"));
  const fetcher = (async () => {
    calls += 1;
    if (fail) throw new Error("hors ligne");
    return new Response(ics);
  }) as unknown as typeof fetch;
  const service = new GoogleCalendarService(() => "https://example.test/basic.ics", fetcher, () => now);
  expect((await service.range("2026-10-26", "2026-11-01")).events).toHaveLength(1);
  await service.range("2026-10-26", "2026-11-01");
  expect(calls).toBe(1);
  now = 10 * 60_000;
  fail = true;
  const stale = await service.range("2026-10-26", "2026-11-01");
  expect(calls).toBe(2);
  expect(stale).toMatchObject({ configured: true, error: "hors ligne" });
  expect(stale.events).toHaveLength(1);
});

test("sans adresse, l'agenda n'est pas configuré", async () => {
  const service = new GoogleCalendarService(() => null);
  expect(await service.range("2026-10-26", "2026-11-01")).toEqual({ configured: false, events: [], error: null });
});
