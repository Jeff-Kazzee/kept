// The case time zone (0009, J5). The person or their agent sets it, the
// page sends the browser's zone once on first load, and no zone is built
// in. Every time the app shows or resolves uses it: the chat's send times,
// the received time on import, relative days in the agent's checks, the
// calendar clash math and the activity log. The demo story runs in
// America/Denver elsewhere. Here a smaller story runs in Asia/Tokyo and
// Europe/London, across London's change on 2026-10-25.
import { describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { CaseActions, YOU } from "../src/actions/service.ts";
import { CaseService } from "../src/case/service.ts";
import { canonicalZone, wallClockToUtc, zonedIso } from "../src/domain/zone.ts";
import { parseIcs } from "../src/domain/ics.ts";
import { readFixtureText } from "../src/fixtures/load.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { ReplyService } from "../src/reply/service.ts";
import { timezoneSettings } from "../src/settings/events.ts";
import { findClashes } from "../src/slots/clash.ts";
import { EventStore } from "../src/store/event-log.ts";
import { agentFor, fnCall, message, pasted, reply, say, sequence, services, turnOutputs } from "./agent-helpers.ts";
import { agentAccess, asFreshPage, fixtureMessage, intake } from "./helpers.ts";

function api(store = new EventStore(":memory:", () => "2026-11-06T17:00:00.000Z")) {
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client);
  const handle = asFreshPage(createApi(svc, kase, {}, new ReplyService(store, kase, client), agentAccess(store, svc, kase)), kase);
  return { store, kase, handle };
}

describe("the settings routes", () => {
  it("GET /api/settings has the time zone part and the provider parts, with no key or token", async () => {
    const { handle } = api();
    const res = await handle({ method: "GET", path: "/api/settings", body: undefined });
    expect(res).toEqual({
      status: 200,
      body: {
        settingsVersion: 0,
        timezone: "UTC",
        timezoneSource: "default",
        provider: null,
        meta: { keySet: false, source: null },
        chatgpt: { signedIn: false, name: null, email: null, planUsage: false },
      },
    });
  });

  it("PUT /api/settings/timezone takes an IANA name at the expected version, the browser's zone once, and refuses others", async () => {
    const { handle, store } = api();
    const put = (body: unknown) => handle({ method: "PUT", path: "/api/settings/timezone", body });
    expect(await put({ timezone: "Asia/Tokyo", expectedVersion: 0, source: "browser" })).toMatchObject({
      status: 200,
      body: { settingsVersion: 1, timezone: "Asia/Tokyo", timezoneSource: "browser" },
    });
    expect(await put({ timezone: "Europe/London", expectedVersion: 0 })).toMatchObject({ status: 409, body: { error: "stale_edit" } });
    for (const bad of ["Mars/Olympus", "+05:00", "UTC+5", "", "x".repeat(65)]) {
      expect((await put({ timezone: bad, expectedVersion: 1 })).status, bad).toBeGreaterThanOrEqual(400);
    }
    expect(await put({ timezone: "Europe/London", expectedVersion: 1, source: "you" })).toMatchObject({ status: 400, body: { error: "invalid_body" } });
    expect(await put({ timezone: "europe/london", expectedVersion: 1 })).toMatchObject({ status: 200, body: { timezone: "Europe/London", timezoneSource: "you", settingsVersion: 2 } });
    // A page from another case generation is refused, as for every write.
    expect(await handle({ method: "PUT", path: "/api/settings/timezone", body: { timezone: "UTC", expectedVersion: 2 }, generation: 7 })).toMatchObject({
      status: 409,
      body: { error: "case_deleted" },
    });
    expect(timezoneSettings(store).timezone).toBe("Europe/London");
    // The changes are in the activity log as the person's, with Undo.
    const activity = (await handle({ method: "GET", path: "/api/activity", body: undefined })).body as { entries: Array<{ kind: string; actor: string; undoable: boolean }> };
    expect(activity.entries.map((e) => [e.kind, e.actor, e.undoable])).toEqual([
      ["timezone_set", "you", true],
      ["timezone_set", "you", true],
    ]);
  });

  it("loading the demo calendar sets the demo's zone as an assistant action, and its undo puts the zone before it back", async () => {
    const { handle, kase } = api();
    await handle({ method: "PUT", path: "/api/settings/timezone", body: { timezone: "Asia/Tokyo", expectedVersion: 0, source: "browser" } });
    await handle({ method: "POST", path: "/api/calendar", body: { name: "dana.ics", text: readFixtureText("calendar/dana.ics"), expectedVersion: 0 } });
    expect(kase.timeZone()).toBe("America/Denver");
    const activity = (await handle({ method: "GET", path: "/api/activity", body: undefined })).body as { activityVersion: number; entries: Array<{ id: string; kind: string; actor: string; summary: string }> };
    expect(activity.entries[0]).toMatchObject({ kind: "timezone_set", actor: "agent", summary: "Set the time zone to America/Denver (it was Asia/Tokyo)." });
    expect(activity.entries[1]).toMatchObject({ kind: "calendar_loaded", actor: "you" });
    await handle({ method: "POST", path: `/api/activity/${activity.entries[0]!.id}/undo`, body: { expectedVersion: activity.activityVersion } });
    expect(kase.timeZone()).toBe("Asia/Tokyo");
  });
});

describe("zone math", () => {
  it("names zones by their canonical IANA names and refuses offsets", () => {
    expect(canonicalZone("asia/tokyo")).toBe("Asia/Tokyo");
    expect(canonicalZone("UTC")).toBe("UTC");
    for (const bad of ["+09:00", "-0500", "GMT+9 ", "", null, 9]) expect(canonicalZone(bad), String(bad)).toBeNull();
  });

  it("finds the calendar's Denver meeting at its own instant in Tokyo and London, and London's 25-hour day on 2026-10-25", () => {
    const calendar = parseIcs(readFixtureText("calendar/dana.ics"));
    // The Denver team meeting at 9:00 MST on 11/13 is 01:00 on 11/14 in
    // Tokyo and 16:00 on 11/13 in London.
    expect(findClashes("2026-11-13", "09:15", calendar, "America/Denver").map((c) => c.summary)).toEqual(["Team meeting"]);
    expect(findClashes("2026-11-13", "09:15", calendar, "Asia/Tokyo")).toEqual([]);
    expect(findClashes("2026-11-14", "00:30", calendar, "Asia/Tokyo").map((c) => c.summary)).toEqual(["Team meeting"]);
    expect(findClashes("2026-11-13", "15:30", calendar, "Europe/London").map((c) => c.summary)).toEqual(["Team meeting"]);
    // London leaves summer time at 02:00 on 10/25, so that day has 25 hours.
    const away = parseIcs("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261025\nSUMMARY:Away\nEND:VEVENT\nEND:VCALENDAR");
    expect(findClashes("2026-10-25", "23:30", away, "Europe/London").map((c) => c.summary)).toEqual(["Away"]);
    expect(findClashes("2026-10-26", "00:00", away, "Europe/London")).toEqual([]);
    expect(wallClockToUtc("2026-10-24", "09:00", "Europe/London")).toBe(Date.UTC(2026, 9, 24, 8, 0));
    expect(wallClockToUtc("2026-10-26", "09:00", "Europe/London")).toBe(Date.UTC(2026, 9, 26, 9, 0));
  });
});

describe("a smaller story in Asia/Tokyo and Europe/London", () => {
  it("in Tokyo: the chat's times, the received time on import, today and relative days are Tokyo's", async () => {
    const app = services(new EventStore(":memory:", () => "2026-11-05T17:00:00.000Z"), undefined, undefined, "Asia/Tokyo");
    const m1 = fixtureMessage("m1");
    const model = sequence(
      // No stated send time, so the message is received when it was pasted.
      reply(fnCall("import_message", { text: m1.text, channel: "sms", from: null, received_at: null })),
      reply(fnCall("get_schedule", {})),
      reply(message("Today is Friday 11/6. The message names Tuesday 11/10 2:00 PM.")),
    );
    const agent = agentFor(app, model);
    const r = await say(agent, app, pasted("m1"));
    expect(r.report.outcome).toBe("answered");
    const msg = app.intake.message("m1").message;
    expect(msg.received_at).toBe("2026-11-06T02:00:00.000+09:00");
    const schedule = turnOutputs(model.calls.at(-1)!.body.input).find((o) => o.name === "get_schedule")!.output;
    expect(schedule.today).toEqual({ date: "2026-11-06", label: "Friday 11/6" });
    expect(schedule.time_zone).toMatchObject({ name: "Asia/Tokyo" });
    expect(agent.chat().messages.map((m) => m.createdAt)).toEqual(["2026-11-06T02:00:00.000+09:00", "2026-11-06T02:00:00.000+09:00"]);
    // The activity log's times are Tokyo's too.
    expect(new CaseActions(app.store, app).activity().entries[0]!.at).toMatch(/\+09:00$/);
    // In Tokyo it is already Friday, so "today is Thursday" fails the check.
    const wrong = sequence(reply(fnCall("get_schedule", {})), reply(message("Today is Thursday 11/5.")), reply(message("Today is Thursday 11/5.")));
    expect((await say(agentFor(app, wrong), app, "What day is it?")).report.outcome).toBe("ungrounded");
  });

  it("in London: the chat's times carry +01:00 before the change and +00:00 after, and a stated send time is read in London", async () => {
    let now = "2026-10-24T23:30:00.000Z";
    const app = services(new EventStore(":memory:", () => now), () => now, undefined, "Europe/London");
    const agent = agentFor(app, sequence(reply(message("Hello.")), reply(message("Hello again."))), { now: () => now });
    await say(agent, app, "Hi");
    now = "2026-10-25T01:30:00.000Z";
    await say(agent, app, "Hi again");
    expect(agent.chat().messages.map((m) => m.createdAt)).toEqual([
      "2026-10-25T00:30:00.000+01:00",
      "2026-10-25T00:30:00.000+01:00",
      "2026-10-25T01:30:00.000+00:00",
      "2026-10-25T01:30:00.000+00:00",
    ]);
    // The person's own words date the message in London: "this came
    // yesterday at 3" on 10/25 means 10/24 at 15:00 BST.
    const text = "This came yesterday at 3.\n\nLantern Hill Clinic: Dana, your visit is confirmed.";
    const model = sequence(
      reply(fnCall("import_message", { text: "Lantern Hill Clinic: Dana, your visit is confirmed.", channel: "sms", from: null, received_at: "2026-10-24T15:00:00+01:00" })),
      reply(message("I added the message.")),
    );
    const r = await say(agentFor(app, model, { now: () => now }), app, text);
    expect(r.report.tools[0]).toMatchObject({ tool: "import_message", ok: true });
    const imported = app.intake.messages().at(-1)!;
    expect(imported.message.received_at).toBe("2026-10-24T15:00:00+01:00");
    expect(imported.sourceSuggested).toContain("received_at");
    // The same words read in Denver would be a different day, so the
    // suggested time would not be kept there.
    expect(zonedIso("2026-10-24T14:00:00.000Z", "America/Denver")).toBe("2026-10-24T08:00:00.000-06:00");
  });

  it("YOU sets the zone through the case actions and the case reads it at once", () => {
    const store = new EventStore(":memory:");
    const app = services(store, undefined, undefined, null);
    expect(app.kase.timeZone()).toBe("UTC");
    new CaseActions(store, app).setTimezone(YOU, "Asia/Tokyo", 0);
    expect(app.kase.timeZone()).toBe("Asia/Tokyo");
    expect(app.kase.zoned("2026-11-05T17:00:00.000Z")).toBe("2026-11-06T02:00:00.000+09:00");
  });
});
