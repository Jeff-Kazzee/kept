// The case's calendar identity (0017, E1). A random id, made at the case's
// first Google Calendar write and erased by Delete case with the rest of the
// case. It is part of every event id the app derives and of the private
// property the app finds its events by, so a new case never takes over an
// event an earlier case made, even one the person removed in Google.
//
// A case whose calendar writes predate the mark keeps the earlier scheme
// (no mark) until Delete case, so its events are still found and its Undo
// records still work. That choice is stored like a mark, as null.
import { randomBytes } from "node:crypto";
import { ACTIVITY_STREAM, projectActivity } from "../activity/events.ts";
import { StaleEditError, type EventStore } from "../store/event-log.ts";
import { GOOGLE_INTENTS_STREAM } from "./intents.ts";

export const CALENDAR_CASE_STREAM = "calendar_case";

// 26 characters from a to v and 0 to 9, so it can join a Google event id.
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
const newMark = () => [...randomBytes(26)].map((b) => BASE32HEX[b & 31]).join("");

function stored(store: EventStore): string | null | undefined {
  const made = store.readStream(CALENDAR_CASE_STREAM).find((e) => e.type === "calendar_case_marked");
  return made ? (made.data as { mark: string | null }).mark : undefined;
}

// A case that wrote to Google Calendar before marks existed: an activity
// entry or an intent of a calendar write, none of which carries a mark.
function writesWithoutMark(store: EventStore): boolean {
  const records = projectActivity(store.readStream(ACTIVITY_STREAM)).records;
  if (records.some((r) => r.undo?.kind === "google_calendar" || r.kind.startsWith("calendar_event_"))) return true;
  return store.readStream(GOOGLE_INTENTS_STREAM).some((e) => e.type === "google_intent_opened");
}

// The case's mark. `create: false` only reads it: null when the case wrote
// to the calendar before marks, undefined when it has no mark yet, so no
// event at Google is this case's. `create: true` makes
// one when there is none, in the case command it runs in, so a Delete case
// meanwhile refuses the write.
export function calendarCaseMark(store: EventStore, options: { create: boolean }): string | null | undefined {
  const have = stored(store);
  if (have !== undefined) return have;
  if (!options.create) return writesWithoutMark(store) ? null : undefined;
  try {
    store.inCase(() =>
      store.transaction(() => {
        if (stored(store) !== undefined) return;
        const mark = writesWithoutMark(store) ? null : newMark();
        store.append(CALENDAR_CASE_STREAM, 0, [{ type: "calendar_case_marked", data: { mark } }]);
      }),
    );
  } catch (err) {
    // Another process made it first.
    if (!(err instanceof StaleEditError)) throw err;
  }
  return stored(store) ?? null;
}
