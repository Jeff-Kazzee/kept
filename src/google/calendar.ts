// Google Calendar (0012, item 5). Lists events in a window for clash
// checks, in the case time zone. Keeps one event per appointment slot in the
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
import { ASSUMED_SLOT_MINUTES, CASE_TIME_ZONE, wallClockToUtc } from "../slots/clash.ts";
import { slotLabel } from "../slots/labels.ts";
import type { SlotView } from "../slots/types.ts";
import type { GoogleConnection } from "./connection.ts";
import { GoogleError, apiError, type GoogleResponse } from "./http.ts";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const APP_PROPERTY = "apptAssistant";
export const SLOT_PROPERTY = "apptSlotKey";
export const ACCOUNT_PROPERTY = "apptAccount";
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
// SHA-256 over the namespace, the account, the calendar and the slot key,
// 56 characters.
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

export function eventIdFor(sub: string, calendarId: string, slotKey: string): string {
  const bytes = createHash("sha256").update([ID_NAMESPACE, sub, calendarId, slotKey].join("\u0000")).digest();
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
  action: "created" | "updated" | "deleted";
  eventId: string;
  // The event's ETag after the write, null after a delete.
  etagAfter: string | null;
  // The app's fields before the write, null for a create.
  before: EventFields | null;
};

export type SyncAction = "created" | "updated" | "deleted" | "unchanged" | "none";

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
export function wallClock(ms: number, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

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

const SUMMARY: Record<EventFields["status"], (s: SlotView) => string> = {
  tentative: (s) => (s.state === "change_proposed" ? "Appointment (change proposed)" : "Appointment (requested, not confirmed)"),
  confirmed: () => "Appointment",
};

// The event the slot should have, or null when it should have none. Every
// word is written by code, except the place, which comes from the office's
// message and is shown in the calendar as given.
export function desiredEvent(slot: SlotView | null, timeZone: string = CASE_TIME_ZONE): EventFields | null {
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
    summary: SUMMARY[status](slot),
    description:
      `Added by the appointment change assistant for ${slotLabel(slot.date, slot.time)}. ` +
      (status === "confirmed" ? "The office confirmed it." : "The office has not confirmed it yet.") +
      " The app updates this event when the appointment changes. Edits made here are not read back.",
    location: slot.location === null ? "" : clean(slot.location, 300),
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

const properties = (slotKey: string, sub: string) => ({ private: { [APP_PROPERTY]: "1", [SLOT_PROPERTY]: slotKey, [ACCOUNT_PROPERTY]: sub } });

const withProperties = (fields: EventFields, slotKey: string, sub: string) => ({
  ...fields,
  transparency: "opaque",
  extendedProperties: properties(slotKey, sub),
});

// A patch body. It sends the app's properties again, so a restored or
// edited event keeps them (review round 2, finding 13). Timed and all-day
// values replace each other, so the other field is cleared.
const patchBody = (f: EventFields, slotKey: string, sub: string) => ({
  ...f,
  extendedProperties: properties(slotKey, sub),
  start: f.start.date ? { date: f.start.date, dateTime: null } : { dateTime: f.start.dateTime, timeZone: f.start.timeZone, date: null },
  end: f.end.date ? { date: f.end.date, dateTime: null } : { dateTime: f.end.dateTime, timeZone: f.end.timeZone, date: null },
});

export class GoogleCalendar {
  readonly #conn: GoogleConnection;
  readonly #timeZone: () => string;

  constructor(connection: GoogleConnection, options: { timeZone?: () => string } = {}) {
    this.#conn = connection;
    this.#timeZone = options.timeZone ?? (() => CASE_TIME_ZONE);
  }

  get timeZone(): string {
    return this.#timeZone();
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
    const { calendarId, sub } = this.#conn.calendar();
    const tz = this.#timeZone();
    const url = new URL(this.#events(calendarId));
    url.searchParams.set("timeMin", new Date(wallClockToUtc(window.from, "00:00", tz)).toISOString());
    url.searchParams.set("timeMax", new Date(wallClockToUtc(addDays(window.to, 1), "00:00", tz)).toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeZone", tz);
    url.searchParams.set("maxResults", "250");
    const out: CalendarEvent[] = [];
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
          slotKey: ownSlot(sub, e.data),
        });
      }
      if (!parsed.data.nextPageToken) break;
      url.searchParams.set("pageToken", parsed.data.nextPageToken);
    }
    return out;
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
  async #locate(calendarId: string, sub: string, slotKey: string): Promise<{ live: RawEvent | null; removed: RawEvent | null }> {
    const atId = await this.#get(calendarId, eventIdFor(sub, calendarId, slotKey));
    if (atId && ownSlot(sub, atId) !== slotKey) throw new GoogleError("google_not_app_event");
    if (atId && atId.status !== "cancelled") return { live: atId, removed: null };
    const url = new URL(this.#events(calendarId));
    for (const [k, v] of Object.entries(properties(slotKey, sub).private)) url.searchParams.append("privateExtendedProperty", `${k}=${v}`);
    url.searchParams.set("maxResults", String(MAX_PROPERTY_MATCHES));
    const res = await this.#call(url.toString());
    if (res.status !== 200) throw apiError(res.status, res.body);
    const parsed = z.object({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().optional() }).safeParse(res.body);
    if (!parsed.success) throw new GoogleError("google_invalid_response");
    const verified = (parsed.data.items ?? []).flatMap((item) => {
      const e = RawEvent.safeParse(item);
      return e.success && e.data.status !== "cancelled" && ownSlot(sub, e.data) === slotKey ? [e.data] : [];
    });
    if (verified.length > 1 || parsed.data.nextPageToken) throw new GoogleError("google_duplicate");
    return { live: verified[0] ?? null, removed: atId };
  }

  // Creates the slot's event under its id. When Google already has that id
  // (409), the event there is read: a live one of the app's is returned
  // with `existed`, a removed one is put back only when `restore` is set.
  async #insert(calendarId: string, sub: string, slotKey: string, fields: EventFields, restore: boolean): Promise<{ event: RawEvent; existed: boolean }> {
    const id = eventIdFor(sub, calendarId, slotKey);
    const res = await this.#call(this.#events(calendarId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...withProperties(fields, slotKey, sub) }),
    });
    if (res.status === 409) {
      const there = await this.#get(calendarId, id);
      if (!there) throw new GoogleError("google_changed");
      if (ownSlot(sub, there) !== slotKey) throw new GoogleError("google_not_app_event");
      if (there.status !== "cancelled") return { event: there, existed: true };
      if (!restore) throw new GoogleError("google_changed", null, "removed");
      return { event: await this.#patch(calendarId, sub, slotKey, there, there.etag, fields), existed: false };
    }
    if (res.status !== 200) throw apiError(res.status, res.body);
    const e = RawEvent.safeParse(res.body);
    if (!e.success || e.data.id !== id) throw new GoogleError("google_invalid_response");
    return { event: e.data, existed: false };
  }

  // Patches the app's event, with its properties, only under its ETag, and
  // checks that the answer is still the app's event for the slot.
  async #patch(calendarId: string, sub: string, slotKey: string, e: RawEvent, etag: string | undefined, fields: EventFields): Promise<RawEvent> {
    if (!etag) throw new GoogleError("google_changed");
    const res = await this.#call(`${this.#events(calendarId)}/${encodeURIComponent(e.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": etag },
      body: JSON.stringify(patchBody(fields, slotKey, sub)),
    });
    if (res.status !== 200) throw apiError(res.status, res.body);
    const out = RawEvent.safeParse(res.body);
    if (!out.success) throw new GoogleError("google_invalid_response");
    if (out.data.id !== e.id || ownSlot(sub, out.data) !== slotKey) throw new GoogleError("google_not_app_event");
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

  // Brings the slot's event in line with the slot. `slot` is null when the
  // case has no such slot any more. An event of the app's that was removed
  // in Google Calendar is put back only with `restoreRemoved`, which the
  // agent sets when the person asked for it.
  async sync(slotKey: string, slot: SlotView | null, options: { restoreRemoved?: boolean } = {}): Promise<SyncOutcome> {
    const { calendarId, sub, key } = this.#conn.calendar();
    const restore = options.restoreRemoved === true;
    const want = desiredEvent(slot, this.#timeZone());
    const found = await this.#locate(calendarId, sub, slotKey);
    let have = found.live;
    const base = { kind: "google_calendar" as const, account: key, calendarId, slotKey };
    if (!have && !want) return { action: "none", slotKey, status: null, eventId: null, undo: null };
    if (!have && want) {
      let made: { event: RawEvent; existed: boolean };
      if (found.removed) {
        if (!restore) throw new GoogleError("google_changed", null, "removed");
        made = { event: await this.#patch(calendarId, sub, slotKey, found.removed, found.removed.etag, want), existed: false };
      } else {
        made = await this.#insert(calendarId, sub, slotKey, want, restore);
      }
      if (!made.existed) {
        return {
          action: "created",
          slotKey,
          status: want.status,
          eventId: made.event.id,
          undo: { ...base, action: "created", eventId: made.event.id, etagAfter: made.event.etag ?? null, before: null },
        };
      }
      // Another sync, or a create that timed out, made it first.
      have = made.event;
    }
    const before = fieldsOf(have!);
    if (!want) {
      await this.#delete(calendarId, have!.id, have!.etag);
      return { action: "deleted", slotKey, status: null, eventId: have!.id, undo: { ...base, action: "deleted", eventId: have!.id, etagAfter: null, before } };
    }
    if (sameFields(before, want)) return { action: "unchanged", slotKey, status: want.status, eventId: have!.id, undo: null };
    const updated = await this.#patch(calendarId, sub, slotKey, have!, have!.etag, want);
    return {
      action: "updated",
      slotKey,
      status: want.status,
      eventId: updated.id,
      undo: { ...base, action: "updated", eventId: updated.id, etagAfter: updated.etag ?? null, before },
    };
  }

  // Deletes the slot's event, if the app made one.
  async remove(slotKey: string): Promise<SyncOutcome> {
    return this.sync(slotKey, null);
  }

  // Reverses one write. The event is the one the record names, fetched and
  // checked by its properties (review round 2, coordinator decision).
  // Refuses when the connection now points at another account or calendar,
  // when the event is not the app's for that slot, or when it changed at
  // Google since the write (google_changed).
  async undo(u: CalendarUndo): Promise<{ action: SyncAction; eventId: string | null }> {
    const { calendarId, sub, key } = this.#conn.calendar();
    if (u.account !== key || u.calendarId !== calendarId) throw new GoogleError("google_not_app_event");
    const current = await this.#get(calendarId, u.eventId);
    if (current && ownSlot(sub, current) !== u.slotKey) throw new GoogleError("google_not_app_event");
    if (u.action === "deleted") {
      if (!u.before) throw new GoogleError("google_invalid_response");
      if (current && current.status !== "cancelled") throw new GoogleError("google_changed");
      // The slot got a new event since the delete, so putting the old one
      // back would make two.
      if ((await this.#locate(calendarId, sub, u.slotKey)).live) throw new GoogleError("google_changed");
      if (current) {
        const restored = await this.#patch(calendarId, sub, u.slotKey, current, current.etag, u.before);
        return { action: "created", eventId: restored.id };
      }
      const { event, existed } = await this.#insert(calendarId, sub, u.slotKey, u.before, true);
      if (existed) throw new GoogleError("google_changed");
      return { action: "created", eventId: event.id };
    }
    if (!current || current.status === "cancelled") {
      // Already gone at Google. Nothing to reverse for a create.
      if (u.action === "created") return { action: "none", eventId: null };
      throw new GoogleError("google_not_found");
    }
    if (u.etagAfter === null || current.etag !== u.etagAfter) throw new GoogleError("google_changed");
    if (u.action === "created") {
      await this.#delete(calendarId, u.eventId, u.etagAfter);
      return { action: "deleted", eventId: u.eventId };
    }
    if (!u.before) throw new GoogleError("google_invalid_response");
    const restored = await this.#patch(calendarId, sub, u.slotKey, current, u.etagAfter, u.before);
    return { action: "updated", eventId: restored.id };
  }
}

// The slot key when the event is the app's for this account, otherwise
// null: the app's mark, a slot key and the account all match.
function ownSlot(sub: string, e: RawEvent): string | null {
  const props = e.extendedProperties?.private;
  const slotKey = props?.[APP_PROPERTY] === "1" ? props[SLOT_PROPERTY] : undefined;
  return slotKey !== undefined && props?.[ACCOUNT_PROPERTY] === sub ? slotKey : null;
}

// A calendar time as a wall-clock fact in the case time zone.
export function caseWallClock(t: IcsTime, timeZone: string = CASE_TIME_ZONE): { date: string; time: string | null } {
  if (t.time === null) return { date: t.date, time: null };
  return wallClock(Date.parse(`${t.date}T${t.time}:00Z`), timeZone);
}
