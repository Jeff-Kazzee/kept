// Google Calendar (0012, item 5). Lists events in a window for clash
// checks, in the case time zone. Keeps one event per appointment slot in the
// chosen calendar: tentative while requested or while a change is
// proposed, confirmed when confirmed, deleted when canceled, declined or
// only offered.
//
// The app only edits events it created. Every event it creates carries a
// private extended property with the slot key, and its id is kept in the
// connection file (connection.ts). An event counts as the app's only when
// both match, so an event the person or another app made, even one that
// copies the property, is never changed. Every update and delete sends the
// event's ETag in If-Match, so a change made at Google since the app read
// the event wins and the app reports it (Google answers 412).
//
// Every write returns an undo record. Undo reverses the write at Google:
// it deletes an event the app created, puts back the fields an update
// changed, or creates the event again after a delete (Google gives it a new
// id).
//
// Endpoints (Calendar API v3 reference, read on 2026-10-28):
//   GET    calendars/{id}/events?timeMin&timeMax&singleEvents&orderBy&timeZone
//   GET    calendars/{id}/events?privateExtendedProperty=name=value
//   GET    calendars/{id}/events/{eventId}
//   POST   calendars/{id}/events
//   PATCH  calendars/{id}/events/{eventId}       If-Match: etag
//   DELETE calendars/{id}/events/{eventId}       If-Match: etag, empty answer
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

const withProperties = (fields: EventFields, slotKey: string) => ({
  ...fields,
  transparency: "opaque",
  extendedProperties: { private: { [APP_PROPERTY]: "1", [SLOT_PROPERTY]: slotKey } },
});

// A patch body. Timed and all-day values replace each other, so the other
// field is cleared.
const patchBody = (f: EventFields) => ({
  ...f,
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
    const { calendarId, key } = this.#conn.calendar();
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
          slotKey: this.#ownSlot(key, e.data),
        });
      }
      if (!parsed.data.nextPageToken) break;
      url.searchParams.set("pageToken", parsed.data.nextPageToken);
    }
    return out;
  }

  // The slot key when the app created this event, otherwise null.
  #ownSlot(key: string, e: RawEvent): string | null {
    const props = e.extendedProperties?.private;
    const slotKey = this.#conn.createdSlot(key, e.id);
    return slotKey !== null && props?.[APP_PROPERTY] === "1" && props[SLOT_PROPERTY] === slotKey ? slotKey : null;
  }

  async #get(calendarId: string, eventId: string): Promise<RawEvent | null> {
    const res = await this.#call(`${this.#events(calendarId)}/${encodeURIComponent(eventId)}`);
    if (res.status === 404 || res.status === 410) return null;
    if (res.status !== 200) throw apiError(res.status, res.body);
    const e = RawEvent.safeParse(res.body);
    if (!e.success) throw new GoogleError("google_invalid_response");
    return e.data.status === "cancelled" ? null : e.data;
  }

  // The app's event for a slot, if there is one.
  async #find(calendarId: string, key: string, slotKey: string): Promise<RawEvent | null> {
    const url = new URL(this.#events(calendarId));
    url.searchParams.set("privateExtendedProperty", `${SLOT_PROPERTY}=${slotKey}`);
    url.searchParams.set("maxResults", "10");
    const res = await this.#call(url.toString());
    if (res.status !== 200) throw apiError(res.status, res.body);
    const parsed = z.object({ items: z.array(z.unknown()).optional() }).safeParse(res.body);
    if (!parsed.success) throw new GoogleError("google_invalid_response");
    for (const item of parsed.data.items ?? []) {
      const e = RawEvent.safeParse(item);
      if (e.success && e.data.status !== "cancelled" && this.#ownSlot(key, e.data) === slotKey) return e.data;
    }
    return null;
  }

  async #insert(calendarId: string, key: string, slotKey: string, fields: EventFields): Promise<RawEvent> {
    const res = await this.#call(this.#events(calendarId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(withProperties(fields, slotKey)),
    });
    if (res.status !== 200) throw apiError(res.status, res.body);
    const e = RawEvent.safeParse(res.body);
    if (!e.success) throw new GoogleError("google_invalid_response");
    this.#conn.rememberEvent(key, e.data.id, slotKey);
    return e.data;
  }

  async #patch(calendarId: string, e: RawEvent, etag: string | undefined, fields: EventFields): Promise<RawEvent> {
    const res = await this.#call(`${this.#events(calendarId)}/${encodeURIComponent(e.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
      body: JSON.stringify(patchBody(fields)),
    });
    if (res.status !== 200) throw apiError(res.status, res.body);
    const out = RawEvent.safeParse(res.body);
    if (!out.success) throw new GoogleError("google_invalid_response");
    return out.data;
  }

  async #delete(calendarId: string, key: string, eventId: string, etag: string | undefined): Promise<void> {
    const res = await this.#call(`${this.#events(calendarId)}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: etag ? { "If-Match": etag } : {},
    });
    if (res.status !== 204 && res.status !== 200 && res.status !== 410) throw apiError(res.status, res.body);
    this.#conn.forgetEvent(key, eventId);
  }

  // Brings the slot's event in line with the slot. `slot` is null when the
  // case has no such slot any more.
  async sync(slotKey: string, slot: SlotView | null): Promise<SyncOutcome> {
    const { calendarId, key } = this.#conn.calendar();
    const want = desiredEvent(slot, this.#timeZone());
    const have = await this.#find(calendarId, key, slotKey);
    const base = { kind: "google_calendar" as const, account: key, calendarId, slotKey };
    if (!have && !want) return { action: "none", slotKey, status: null, eventId: null, undo: null };
    if (!have && want) {
      const created = await this.#insert(calendarId, key, slotKey, want);
      return {
        action: "created",
        slotKey,
        status: want.status,
        eventId: created.id,
        undo: { ...base, action: "created", eventId: created.id, etagAfter: created.etag ?? null, before: null },
      };
    }
    const before = fieldsOf(have!);
    if (!want) {
      await this.#delete(calendarId, key, have!.id, have!.etag);
      return { action: "deleted", slotKey, status: null, eventId: have!.id, undo: { ...base, action: "deleted", eventId: have!.id, etagAfter: null, before } };
    }
    if (sameFields(before, want)) return { action: "unchanged", slotKey, status: want.status, eventId: have!.id, undo: null };
    const updated = await this.#patch(calendarId, have!, have!.etag, want);
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

  // Reverses one write. Refuses when the connection now points at another
  // account or calendar, when the event is no longer the app's, or when it
  // changed at Google since the write (google_changed).
  async undo(u: CalendarUndo): Promise<{ action: SyncAction; eventId: string | null }> {
    const { calendarId, key } = this.#conn.calendar();
    if (u.account !== key || u.calendarId !== calendarId) throw new GoogleError("google_not_app_event");
    if (u.action === "deleted") {
      if (!u.before) throw new GoogleError("google_invalid_response");
      // The slot got a new event since the delete, so putting the old one
      // back would make two.
      if (await this.#find(calendarId, key, u.slotKey)) throw new GoogleError("google_changed");
      const created = await this.#insert(calendarId, key, u.slotKey, u.before);
      return { action: "created", eventId: created.id };
    }
    const current = await this.#get(calendarId, u.eventId);
    if (!current) {
      // Already gone at Google. Nothing to reverse for a create.
      if (u.action === "created") return { action: "none", eventId: null };
      throw new GoogleError("google_not_found");
    }
    if (this.#ownSlot(key, current) !== u.slotKey) throw new GoogleError("google_not_app_event");
    if (u.etagAfter === null || current.etag !== u.etagAfter) throw new GoogleError("google_changed");
    if (u.action === "created") {
      await this.#delete(calendarId, key, u.eventId, u.etagAfter);
      return { action: "deleted", eventId: u.eventId };
    }
    if (!u.before) throw new GoogleError("google_invalid_response");
    const restored = await this.#patch(calendarId, current, u.etagAfter, u.before);
    return { action: "updated", eventId: restored.id };
  }
}

// A calendar time as a wall-clock fact in the case time zone.
export function caseWallClock(t: IcsTime, timeZone: string = CASE_TIME_ZONE): { date: string; time: string | null } {
  if (t.time === null) return { date: t.date, time: null };
  return wallClock(Date.parse(`${t.date}T${t.time}:00Z`), timeZone);
}
