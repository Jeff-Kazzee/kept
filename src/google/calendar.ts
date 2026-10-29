// Google Calendar (0012, item 5). Lists events in a window for clash
// checks, in the case's time zone. Keeps one event per appointment slot in the
// chosen calendar: tentative while requested or while a change is
// proposed, confirmed when confirmed, deleted when canceled, declined or
// only offered.
//
// The app only edits events it created. Each of its events carries private
// extended properties with the app's mark, the slot key and the account's
// Google id (`sub`). An event counts as the app's only when all three match,
// so an event the person or another app made is never changed, nor is an
// event that sits at the app's id without them. Every update and delete
// sends the event's ETag in If-Match, so a change made at Google since the
// app read the event wins and the app reports it (Google answers 412). A
// write without an ETag is never sent (review round 2, finding 14).
//
// Event ids (review round 2, coordinator decision on findings 11, 12, 16
// and 17). The id is derived from a fixed app namespace, the account, the
// calendar and the slot key, so it is the same after the token file is
// lost or the account reconnects, and a create is idempotent: a second
// create of the same slot, or a retry after a create that reached Google
// but timed out, gets 409, and the app reads the event that is there. Only
// someone who can write to the calendar could predict an id and take it,
// and the property check refuses such an event. Before a create the app
// also asks Google once, by property, for the slot's event, and adopts a
// verified one, so an event made under another id is updated, not doubled.
//
// An event of the app's that was removed in Google Calendar is not put back
// by a sync (review round 2, finding 15). The sync reports it, and only an
// Undo or a sync the person asked for (`restoreRemoved`) puts it back.
//
// Each case has its own mark (0017, E1, src/google/case-mark.ts). It joins
// the id's inputs and the properties, so an event an earlier case made, or
// removed, is never this case's. An event or record without a mark is of the
// earlier scheme, and only a case that kept that scheme reads it as its own.
//
// Every write returns an undo record. Undo reverses the write at Google:
// it deletes an event the app created, puts back the fields an update
// changed, or puts a deleted event back. It finds the event by the id in
// the record and checks its properties, so a record from an earlier id
// scheme still works.
//
// Endpoints (Calendar API v3 reference, read on 2026-10-28):
//   GET    calendars/{id}/events?timeMin&timeMax&singleEvents&orderBy&timeZone
//   GET    calendars/{id}/events?privateExtendedProperty=name=value (repeatable)
//   GET    calendars/{id}/events/{eventId}
//   POST   calendars/{id}/events                with a client id, 409 if taken
//   PATCH  calendars/{id}/events/{eventId}       If-Match: etag
//   DELETE calendars/{id}/events/{eventId}       If-Match: etag, empty answer
import { createHash } from "node:crypto";
import { z } from "zod";
import type { IcsEvent, IcsTime } from "../domain/ics.ts";
import { localDateTime, wallClockToUtc } from "../domain/zone.ts";
import { ASSUMED_SLOT_MINUTES } from "../slots/clash.ts";
import { slotLabel } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import type { GoogleConnection } from "./connection.ts";
import { GoogleError, apiError, type GoogleResponse } from "./http.ts";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const APP_PROPERTY = "apptAssistant";
export const SLOT_PROPERTY = "apptSlotKey";
export const ACCOUNT_PROPERTY = "apptAccount";
export const CASE_PROPERTY = "apptCase";
// The most events the property lookup reads for one slot. More than one
// verified event is an error the person resolves in Google Calendar.
export const MAX_PROPERTY_MATCHES = 10;
const ID_NAMESPACE = "meta-hackathon-appointments/calendar-event/v1";
export const MAX_WINDOW_DAYS = 31;

export type GoogleTime = { dateTime?: string; date?: string; timeZone?: string };

// The fields the app sets on its own events.
export type EventFields = {
  summary: string;
  description: string;
  location: string;
  status: "tentative" | "confirmed";
  start: GoogleTime;
  end: GoogleTime;
};

// Google accepts a client-chosen event id of 5 to 1024 characters from
// a to v and 0 to 9 (base32hex). The id is "appt" and the base32hex of a
// SHA-256 over the namespace, the account, the calendar, the slot key and
// the case's mark when it has one, 56 characters. Without a mark the id is
// the one the earlier scheme gave.
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

export function eventIdFor(sub: string, calendarId: string, slotKey: string, mark: string | null = null): string {
  const bytes = createHash("sha256").update([ID_NAMESPACE, sub, calendarId, slotKey, ...(mark === null ? [] : [mark])].join("\u0000")).digest();
  let bits = 0;
  let value = 0;
  let out = "appt";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

export type CalendarEvent = {
  id: string;
  summary: string;
  status: string;
  start: IcsTime;
  end: IcsTime | null;
  allDay: boolean;
  // The slot key when this app created the event, otherwise null.
  slotKey: string | null;
};

// Data only, so an activity log can store it as JSON and run it later.
export type CalendarUndo = {
  kind: "google_calendar";
  // The account and calendar the write went to (connection.ts).
  account: string;
  calendarId: string;
  slotKey: string;
  // The case's mark (0017, E1). Absent in a record of the earlier scheme.
  mark?: string;
  action: "created" | "updated" | "deleted";
  eventId: string;
  // The event's ETag after the write, null after a delete.
  etagAfter: string | null;
  // The app's fields before the write, null for a create.
  before: EventFields | null;
};

export type SyncAction = "created" | "updated" | "deleted" | "unchanged" | "none";

// A planned write as plain data, recorded as an intent before the write
// (review round 3, findings 1 and 2).
export type WritePlan = {
  account: string;
  calendarId: string;
  slotKey: string;
  mark?: string;
  action: "created" | "updated" | "deleted";
  eventId: string;
  before: EventFields | null;
  want: EventFields | null;
};

// The plan and what `execute` needs from the read that made it.
// `needsMark` is true when the case has no mark yet (0017, fix round 1,
// R2): the plan's event id waits for the mark that `markPlan` gives it, in
// the transaction that records the write's intent.
export type PlannedWrite = { plan: WritePlan; have: RawEvent | null; removed: RawEvent | null; restore: boolean; needsMark?: boolean };
export type Planned = { write: PlannedWrite; outcome: null } | { write: null; outcome: SyncOutcome };

export type SyncOutcome = {
  action: SyncAction;
  slotKey: string;
  status: EventFields["status"] | null;
  eventId: string | null;
  // Null when nothing was written.
  undo: CalendarUndo | null;
};

const RawEvent = z.object({
  id: z.string().min(1).max(1024),
  etag: z.string().max(200).optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});
type RawEvent = z.infer<typeof RawEvent>;

const HIDDEN = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const clean = (s: string, max: number) => s.replace(HIDDEN, " ").replace(/\s+/g, " ").trim().slice(0, max);

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// An instant as a wall-clock date and time in a time zone.
export const wallClock = (ms: number, timeZone: string): { date: string; time: string } => localDateTime(ms, timeZone);

function icsTime(t: GoogleTime | undefined): IcsTime | null {
  if (!t) return null;
  if (t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return { date: t.date, time: null, tzid: null, utc: false };
  const ms = t.dateTime ? Date.parse(t.dateTime) : NaN;
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), tzid: null, utc: true };
}

const instant = (t: GoogleTime | undefined) => (t?.dateTime ? Date.parse(t.dateTime) : t?.date ? Date.parse(`${t.date}T00:00:00Z`) : NaN);

// Calendar events in the shape the clash check reads, so a Google calendar
// can stand where a loaded .ics file stands.
export function toIcsEvents(events: CalendarEvent[]): IcsEvent[] {
  return events.map((e) => ({ uid: e.id, summary: e.summary, start: e.start, end: e.end, recurring: false }));
}

const STATUS: Partial<Record<SlotView["state"], EventFields["status"]>> = {
  requested: "tentative",
  change_proposed: "tentative",
  confirmed: "confirmed",
};

// 0016, H4: the title names the office and the state, as "Lantern Hill
// Clinic (requested)". The state words are code's. Without an office name
// the title keeps the earlier words.
const SUMMARY: Record<EventFields["status"], (s: SlotView, office: string | null) => string> = {
  tentative: (s, office) =>
    s.state === "change_proposed" ? `${office ?? "Appointment"} (change proposed)` : office ? `${office} (requested)` : "Appointment (requested, not confirmed)",
  confirmed: (_s, office) => office ?? "Appointment",
};

// The office as the case holds it (src/reply/office.ts). Its place is not
// the event's: that is the slot's own (0017, E2).
export type EventOffice = { name: string | null };

// The event the slot should have, or null when it should have none. Every
// word is written by code, except the office's name and the slot's place,
// which come from the office's messages and are shown in the calendar as
// given.
export function desiredEvent(slot: SlotView | null, timeZone: string, office: EventOffice | null = null): EventFields | null {
  const status = slot ? STATUS[slot.state] : undefined;
  if (!slot || !status) return null;
  const timed = slot.time !== null;
  const start: GoogleTime = timed
    ? { dateTime: new Date(wallClockToUtc(slot.date, slot.time!, timeZone)).toISOString(), timeZone }
    : { date: slot.date };
  const end: GoogleTime = timed
    ? { dateTime: new Date(wallClockToUtc(slot.date, slot.time!, timeZone) + ASSUMED_SLOT_MINUTES * 60_000).toISOString(), timeZone }
    : { date: addDays(slot.date, 1) };
  return {
    summary: SUMMARY[status](slot, office?.name ? clean(office.name, 100) : null),
    description:
      `Added by the appointment change assistant for ${slotLabel(slot.date, slot.time)}. ` +
      (status === "confirmed" ? "The office confirmed it." : "The office has not confirmed it yet.") +
      " The app updates this event when the appointment changes. Edits made here are not read back.",
    // 0017, E2: the slot's own place, as the schedule and the reply show it.
    // Without one the event has no location.
    location: clean(slot.location ?? "", 300),
    status,
    start,
    end,
  };
}

function fieldsOf(e: RawEvent): EventFields {
  return {
    summary: e.summary ?? "",
    description: e.description ?? "",
    location: e.location ?? "",
    status: e.status === "tentative" ? "tentative" : "confirmed",
    start: e.start ?? {},
    end: e.end ?? {},
  };
}

function sameFields(a: EventFields, b: EventFields): boolean {
  return (
    a.summary === b.summary &&
    a.description === b.description &&
    a.location === b.location &&
    a.status === b.status &&
    instant(a.start) === instant(b.start) &&
    instant(a.end) === instant(b.end) &&
    Boolean(a.start.date) === Boolean(b.start.date)
  );
}

// The case's mark: a string, null for a case of the earlier scheme, or
// undefined when the case has none yet and so owns no event.
export type CaseMark = string | null | undefined;
const markOf = (r: { mark?: string }): string | null => r.mark ?? null;
const withMark = (mark: string | null) => (mark === null ? {} : { mark });

const properties = (slotKey: string, sub: string, mark: string | null) => ({
  private: { [APP_PROPERTY]: "1", [SLOT_PROPERTY]: slotKey, [ACCOUNT_PROPERTY]: sub, ...(mark === null ? {} : { [CASE_PROPERTY]: mark }) },
});

const withProperties = (fields: EventFields, slotKey: string, sub: string, mark: string | null) => ({
  ...fields,
  transparency: "opaque",
  extendedProperties: properties(slotKey, sub, mark),
});

// A patch body. It sends the app's properties again, so a restored or
// edited event keeps them (review round 2, finding 13). Timed and all-day
// values replace each other, so the other field is cleared.
const patchBody = (f: EventFields, slotKey: string, sub: string, mark: string | null) => ({
  ...f,
  extendedProperties: properties(slotKey, sub, mark),
  start: f.start.date ? { date: f.start.date, dateTime: null } : { dateTime: f.start.dateTime, timeZone: f.start.timeZone, date: null },
  end: f.end.date ? { date: f.end.date, dateTime: null } : { dateTime: f.end.dateTime, timeZone: f.end.timeZone, date: null },
});

export class GoogleCalendar {
  readonly #conn: GoogleConnection;
  readonly #timeZone: () => string;
  readonly #caseMark: (options: { create: boolean }) => CaseMark;

  // `timeZone` is the case's time zone (0009, J5), read at each call.
  // `caseMark` is the case's mark (src/google/case-mark.ts). `list` and
  // `plan` only read it. The case actions make it when a first write is
  // recorded (markPlan). Without it every case is of the earlier scheme.
  constructor(connection: GoogleConnection, options: { timeZone: () => string; caseMark?: (options: { create: boolean }) => CaseMark }) {
    this.#conn = connection;
    this.#timeZone = options.timeZone;
    this.#caseMark = options.caseMark ?? (() => null);
  }

  get timeZone(): string {
    return this.#timeZone();
  }

  // The account and calendar the connection names now, or null when it has
  // no calendar connection. Never throws.
  accountKey(): string | null {
    return this.#conn.accountKey();
  }

  #events(calendarId: string) {
    return `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  }

  async #call(url: string, init: RequestInit = {}): Promise<GoogleResponse> {
    return this.#conn.call("calendar", url, init);
  }

  // Events from the start of `from` to the end of `to`, both YYYY-MM-DD in
  // the case time zone, at most MAX_WINDOW_DAYS days. Recurring events are
  // expanded. Canceled events are left out.
  async list(window: { from: string; to: string }): Promise<CalendarEvent[]> {
    return (await this.listRead(window)).events;
  }

  // The same, and whether the read is complete: false when Google still had
  // a page after the last one read (fix round 2, F3).
  async listRead(window: { from: string; to: string }): Promise<{ events: CalendarEvent[]; complete: boolean }> {
    const { calendarId, sub } = this.#conn.calendar();
    const tz = this.#timeZone();
    const url = new URL(this.#events(calendarId));
    url.searchParams.set("timeMin", new Date(wallClockToUtc(window.from, "00:00", tz)).toISOString());
    url.searchParams.set("timeMax", new Date(wallClockToUtc(addDays(window.to, 1), "00:00", tz)).toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeZone", tz);
    url.searchParams.set("maxResults", "250");
    const out: Array<CalendarEvent & { raw: RawEvent }> = [];
    let complete = false;
    for (let page = 0; page < 4; page++) {
      const res = await this.#call(url.toString());
      if (res.status !== 200) throw apiError(res.status, res.body);
      const parsed = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().max(2000).optional() }).safeParse(res.body);
      if (!parsed.success) throw new GoogleError("google_invalid_response");
      for (const item of parsed.data.items ?? []) {
        const e = RawEvent.safeParse(item);
        if (!e.success || e.data.status === "cancelled") continue;
        const start = icsTime(e.data.start);
        if (!start) continue;
        out.push({
          id: e.data.id,
          summary: clean(e.data.summary ?? "(no title)", 300),
          status: e.data.status ?? "confirmed",
          start,
          end: icsTime(e.data.end),
          allDay: start.time === null,
          slotKey: null,
          raw: e.data,
        });
      }
      if (!parsed.data.nextPageToken) {
        complete = true;
        break;
      }
      url.searchParams.set("pageToken", parsed.data.nextPageToken);
    }
    // Read after the events, so an event this case made while they were
    // read counts as its own (0017, E1).
    const mark = this.#caseMark({ create: false });
    return { events: out.map(({ raw, ...e }) => ({ ...e, slotKey: ownSlot(sub, raw, mark) })), complete };
  }

  // The event with this id, deleted ones included, or null.
  async #get(calendarId: string, eventId: string): Promise<RawEvent | null> {
    const res = await this.#call(`${this.#events(calendarId)}/${encodeURIComponent(eventId)}`);
    if (res.status === 404 || res.status === 410) return null;
    if (res.status !== 200) throw apiError(res.status, res.body);
    const e = RawEvent.safeParse(res.body);
    if (!e.success) throw new GoogleError("google_invalid_response");
    return e.data;
  }

  // The slot's live event and, when there is none, its removed one. The
  // event at the slot's id comes first. Without a live one there, one
  // bounded lookup by property finds a verified event under another id.
  async #locate(calendarId: string, sub: string, slotKey: string, mark: string | null): Promise<{ live: RawEvent | null; removed: RawEvent | null }> {
    const atId = await this.#get(calendarId, eventIdFor(sub, calendarId, slotKey, mark));
    if (atId && ownSlot(sub, atId, mark) !== slotKey) throw new GoogleError("google_not_app_event");
    if (atId && atId.status !== "cancelled") return { live: atId, removed: null };
    const url = new URL(this.#events(calendarId));
    for (const [k, v] of Object.entries(properties(slotKey, sub, mark).private)) url.searchParams.append("privateExtendedProperty", `${k}=${v}`);
    url.searchParams.set("maxResults", String(MAX_PROPERTY_MATCHES));
    const res = await this.#call(url.toString());
    if (res.status !== 200) throw apiError(res.status, res.body);
    const parsed = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().optional() }).safeParse(res.body);
    if (!parsed.success) throw new GoogleError("google_invalid_response");
    const verified = (parsed.data.items ?? []).flatMap((item) => {
      const e = RawEvent.safeParse(item);
      return e.success && e.data.status !== "cancelled" && ownSlot(sub, e.data, mark) === slotKey ? [e.data] : [];
    });
    if (verified.length > 1 || parsed.data.nextPageToken) throw new GoogleError("google_duplicate");
    return { live: verified[0] ?? null, removed: atId };
  }

  // Creates the slot's event under its id. When Google already has that id
  // (409), the event there is read: a live one of the app's is returned
  // with `existed`, a removed one is put back only when `restore` is set.
  async #insert(calendarId: string, sub: string, slotKey: string, mark: string | null, fields: EventFields, restore: boolean): Promise<{ event: RawEvent; existed: boolean }> {
    const id = eventIdFor(sub, calendarId, slotKey, mark);
    const res = await this.#call(this.#events(calendarId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...withProperties(fields, slotKey, sub, mark) }),
    });
    if (res.status === 409) {
      const there = await this.#get(calendarId, id);
      if (!there) throw new GoogleError("google_changed");
      if (ownSlot(sub, there, mark) !== slotKey) throw new GoogleError("google_not_app_event");
      if (there.status !== "cancelled") return { event: there, existed: true };
      if (!restore) throw new GoogleError("google_changed", null, "removed");
      return { event: await this.#patch(calendarId, sub, slotKey, mark, there, there.etag, fields), existed: false };
    }
    if (res.status !== 200) throw apiError(res.status, res.body);
    const e = RawEvent.safeParse(res.body);
    if (!e.success || e.data.id !== id) throw new GoogleError("google_invalid_response");
    return { event: e.data, existed: false };
  }

  // Patches the app's event, with its properties, only under its ETag, and
  // checks that the answer is still the app's event for the slot.
  async #patch(calendarId: string, sub: string, slotKey: string, mark: string | null, e: RawEvent, etag: string | undefined, fields: EventFields): Promise<RawEvent> {
    if (!etag) throw new GoogleError("google_changed");
    const res = await this.#call(`${this.#events(calendarId)}/${encodeURIComponent(e.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(patchBody(fields, slotKey, sub, mark)),
    });
    if (res.status !== 200) throw apiError(res.status, res.body);
    const out = RawEvent.safeParse(res.body);
    if (!out.success) throw new GoogleError("google_invalid_response");
    if (out.data.id !== e.id || ownSlot(sub, out.data, mark) !== slotKey) throw new GoogleError("google_not_app_event");
    return out.data;
  }

  async #delete(calendarId: string, eventId: string, etag: string | undefined): Promise<void> {
    if (!etag) throw new GoogleError("google_changed");
    const res = await this.#call(`${this.#events(calendarId)}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { "If-Match": etag },
    });
    if (res.status !== 204 && res.status !== 200 && res.status !== 410) throw apiError(res.status, res.body);
  }

  // What a sync of the slot would write, read from Google without writing
  // (review round 3, findings 1 and 2). `write` is null when nothing is to
  // be written: the outcome is then "none" or "unchanged". Otherwise
  // `write.plan` is plain data the case actions record as an intent before
  // `execute` writes at Google. `slot` is null when the case has no such
  // slot any more. An event of the app's that was removed in Google
  // Calendar is put back only with `restoreRemoved`, which the agent sets
  // when the person asked for it.
  async plan(slotKey: string, slot: SlotView | null, options: { restoreRemoved?: boolean; office?: EventOffice | null } = {}): Promise<Planned> {
    const { calendarId, sub, key } = this.#conn.calendar();
    const restore = options.restoreRemoved === true;
    // 0017, E1: the case's own mark. A case without one owns no event, so
    // there is nothing to find, and only a write that will happen gets a
    // mark (fix round 1, R2).
    const read = this.#caseMark({ create: false });
    const want = desiredEvent(slot, this.#timeZone(), options.office ?? null);
    if (read === undefined) {
      if (!want) return { write: null, outcome: { action: "none", slotKey, status: null, eventId: null, undo: null } };
      return {
        write: { plan: { account: key, calendarId, slotKey, action: "created", eventId: "", before: null, want }, have: null, removed: null, restore, needsMark: true },
        outcome: null,
      };
    }
    const mark = read;
    const found = await this.#locate(calendarId, sub, slotKey, mark);
    const have = found.live;
    const base = { account: key, calendarId, slotKey, ...withMark(mark) };
    if (!have && !want) return { write: null, outcome: { action: "none", slotKey, status: null, eventId: null, undo: null } };
    if (!have && want) {
      if (found.removed && !restore) throw new GoogleError("google_changed", null, "removed");
      return {
        write: { plan: { ...base, action: "created", eventId: found.removed?.id ?? eventIdFor(sub, calendarId, slotKey, mark), before: null, want }, have: null, removed: found.removed, restore },
        outcome: null,
      };
    }
    const before = fieldsOf(have!);
    if (!want) return { write: { plan: { ...base, action: "deleted", eventId: have!.id, before, want: null }, have, removed: null, restore }, outcome: null };
    if (sameFields(before, want)) return { write: null, outcome: { action: "unchanged", slotKey, status: want.status, eventId: have!.id, undo: null } };
    return { write: { plan: { ...base, action: "updated", eventId: have!.id, before, want }, have, removed: null, restore }, outcome: null };
  }

  // A plan made before the case had a mark, with the mark and the event id
  // it gives. Called in the transaction that records the write's intent.
  markPlan(plan: WritePlan, mark: string | null): WritePlan {
    const { calendarId, sub, key } = this.#conn.calendar();
    if (plan.account !== key || plan.calendarId !== calendarId) throw new GoogleError("google_stale");
    const { mark: _old, ...rest } = plan;
    return { ...rest, ...withMark(mark), eventId: eventIdFor(sub, calendarId, plan.slotKey, mark) };
  }

  // Writes a planned change at Google and returns what happened, with its
  // undo record.
  async execute(write: PlannedWrite): Promise<SyncOutcome> {
    const { calendarId, sub, key } = this.#conn.calendar();
    const { plan } = write;
    if (plan.account !== key || plan.calendarId !== calendarId) throw new GoogleError("google_stale");
    if (plan.eventId === "") throw new GoogleError("google_invalid_response");
    const mark = markOf(plan);
    const base = { kind: "google_calendar" as const, account: key, calendarId, slotKey: plan.slotKey, ...withMark(mark) };
    let have = write.have;
    if (plan.action === "created") {
      const want = plan.want!;
      const made = write.removed
        ? { event: await this.#patch(calendarId, sub, plan.slotKey, mark, write.removed, write.removed.etag, want), existed: false }
        : await this.#insert(calendarId, sub, plan.slotKey, mark, want, write.restore);
      if (!made.existed) {
        return {
          action: "created",
          slotKey: plan.slotKey,
          status: want.status,
          eventId: made.event.id,
          undo: { ...base, action: "created", eventId: made.event.id, etagAfter: made.event.etag ?? null, before: null },
        };
      }
      // Another sync, or a create that timed out, made it first.
      have = made.event;
    }
    const before = fieldsOf(have!);
    if (!plan.want) {
      await this.#delete(calendarId, have!.id, have!.etag);
      return { action: "deleted", slotKey: plan.slotKey, status: null, eventId: have!.id, undo: { ...base, action: "deleted", eventId: have!.id, etagAfter: null, before } };
    }
    if (sameFields(before, plan.want)) return { action: "unchanged", slotKey: plan.slotKey, status: plan.want.status, eventId: have!.id, undo: null };
    const updated = await this.#patch(calendarId, sub, plan.slotKey, mark, have!, have!.etag, plan.want);
    return {
      action: "updated",
      slotKey: plan.slotKey,
      status: plan.want.status,
      eventId: updated.id,
      undo: { ...base, action: "updated", eventId: updated.id, etagAfter: updated.etag ?? null, before },
    };
  }

  // Whether a planned write reached Google, read without writing, for an
  // intent whose result was not recorded. "applied" carries the undo record
  // the write would have returned. "diverged" means the event is neither
  // as planned nor as before, so it changed at Google since.
  async inspect(plan: WritePlan): Promise<{ state: "applied"; undo: CalendarUndo } | { state: "not_applied" } | { state: "diverged" }> {
    const { calendarId, sub, key } = this.#conn.calendar();
    if (plan.account !== key || plan.calendarId !== calendarId) return { state: "diverged" };
    const e = await this.#get(calendarId, plan.eventId);
    if (e && ownSlot(sub, e, markOf(plan)) !== plan.slotKey) return { state: "diverged" };
    const live = e !== null && e.status !== "cancelled";
    const fields = live ? fieldsOf(e!) : null;
    const base = { kind: "google_calendar" as const, account: key, calendarId, slotKey: plan.slotKey, ...withMark(markOf(plan)), eventId: plan.eventId };
    if (plan.action === "deleted") {
      if (!live) return { state: "applied", undo: { ...base, action: "deleted", etagAfter: null, before: plan.before } };
      return sameFields(fields!, plan.before!) ? { state: "not_applied" } : { state: "diverged" };
    }
    if (live && sameFields(fields!, plan.want!)) {
      return { state: "applied", undo: { ...base, action: plan.action, etagAfter: e!.etag ?? null, before: plan.before } };
    }
    if (plan.action === "created") return live ? { state: "diverged" } : { state: "not_applied" };
    return live && sameFields(fields!, plan.before!) ? { state: "not_applied" } : { state: "diverged" };
  }

  // There is no write without a record (0017, fix round 2, F7): every
  // write goes plan, then CaseActions.googleWrite, then execute.

  // Whether an undo already happened at Google, read without writing, for
  // an undo intent whose result was not recorded.
  async undoState(u: CalendarUndo): Promise<"reversed" | "not_reversed" | "diverged"> {
    const { calendarId, sub, key } = this.#conn.calendar();
    if (u.account !== key || u.calendarId !== calendarId) return "diverged";
    const current = await this.#get(calendarId, u.eventId);
    if (current && ownSlot(sub, current, markOf(u)) !== u.slotKey) return "diverged";
    const live = current !== null && current.status !== "cancelled";
    if (u.action === "created") return live ? (current!.etag === u.etagAfter ? "not_reversed" : "diverged") : "reversed";
    if (u.action === "deleted") return live ? (u.before && sameFields(fieldsOf(current!), u.before) ? "reversed" : "diverged") : "not_reversed";
    if (!live) return "diverged";
    if (u.before && sameFields(fieldsOf(current!), u.before)) return "reversed";
    return current!.etag === u.etagAfter ? "not_reversed" : "diverged";
  }

  // Reverses one write. The event is the one the record names, fetched and
  // checked by its properties (review round 2, coordinator decision). An
  // undo that already happened at Google, as when a retry follows an undo
  // whose entry could not be written, is success (review round 3,
  // finding 1). Refuses when the connection now points at another account
  // or calendar, when the event is not the app's for that slot, or when it
  // changed at Google since the write (google_changed).
  async undo(u: CalendarUndo): Promise<{ action: SyncAction; eventId: string | null }> {
    const { calendarId, sub, key } = this.#conn.calendar();
    if (u.account !== key || u.calendarId !== calendarId) throw new GoogleError("google_not_app_event");
    const mark = markOf(u);
    const current = await this.#get(calendarId, u.eventId);
    if (current && ownSlot(sub, current, mark) !== u.slotKey) throw new GoogleError("google_not_app_event");
    const live = current !== null && current.status !== "cancelled";
    if (u.action === "deleted") {
      if (!u.before) throw new GoogleError("google_invalid_response");
      // Put back already, with the fields the delete removed.
      if (live && sameFields(fieldsOf(current!), u.before)) return { action: "created", eventId: current!.id };
      if (live) throw new GoogleError("google_changed");
      // The slot got a new event since the delete, so putting the old one
      // back would make two.
      if ((await this.#locate(calendarId, sub, u.slotKey, mark)).live) throw new GoogleError("google_changed");
      if (current) {
        const restored = await this.#patch(calendarId, sub, u.slotKey, mark, current, current.etag, u.before);
        return { action: "created", eventId: restored.id };
      }
      const { event, existed } = await this.#insert(calendarId, sub, u.slotKey, mark, u.before, true);
      if (existed) throw new GoogleError("google_changed");
      return { action: "created", eventId: event.id };
    }
    if (!live) {
      // Already gone at Google. Nothing to reverse for a create.
      if (u.action === "created") return { action: "none", eventId: null };
      throw new GoogleError("google_not_found");
    }
    // An update already reversed: the event has the earlier fields again.
    if (u.action === "updated" && u.before && sameFields(fieldsOf(current!), u.before)) return { action: "updated", eventId: current!.id };
    if (u.etagAfter === null || current!.etag !== u.etagAfter) throw new GoogleError("google_changed");
    if (u.action === "created") {
      await this.#delete(calendarId, u.eventId, u.etagAfter);
      return { action: "deleted", eventId: u.eventId };
    }
    if (!u.before) throw new GoogleError("google_invalid_response");
    const restored = await this.#patch(calendarId, sub, u.slotKey, mark, current!, u.etagAfter, u.before);
    return { action: "updated", eventId: restored.id };
  }
}

// The slot key when the event is the app's for this account and case,
// otherwise null: the app's mark, a slot key, the account and the case's
// mark all match. A case of the earlier scheme (null) owns only events
// without a case mark. A case with no mark yet owns none.
function ownSlot(sub: string, e: RawEvent, mark: CaseMark): string | null {
  if (mark === undefined) return null;
  const props = e.extendedProperties?.private;
  const slotKey = props?.[APP_PROPERTY] === "1" ? props[SLOT_PROPERTY] : undefined;
  if (slotKey === undefined || props?.[ACCOUNT_PROPERTY] !== sub) return null;
  return (props[CASE_PROPERTY] ?? null) === mark ? slotKey : null;
}

// A calendar time as a wall-clock fact in the case time zone.
export function caseWallClock(t: IcsTime, timeZone: string): { date: string; time: string | null } {
  if (t.time === null) return { date: t.date, time: null };
  return wallClock(Date.parse(`${t.date}T${t.time}:00Z`), timeZone);
}
