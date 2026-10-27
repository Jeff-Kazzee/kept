// SP3.8 and S12: approving a reply writes only local events. No fetch,
// socket, HTTP or DNS call leaves the app during approval and the
// simulated send.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseService } from "../src/case/service.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { ReplyService } from "../src/reply/service.ts";
import { SIMULATED_SEND_LABEL } from "../src/reply/templates.ts";
import { EventStore } from "../src/store/event-log.ts";
import { NETWORK_BLOCKED } from "./setup.ts";
import { acceptMessages, intake } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SP3.8 S12: the simulated send", () => {
  it("S12: Dana approves the reply MON. Only local events are written and no network call is made", async () => {
    const store = new EventStore();
    const service = intake(store);
    await acceptMessages(service, ["m3"]);
    const client = RecordedModelClient.fromDirectory();
    const kase = new CaseService(store, service, client, { userName: "Dana Reyes" });
    const reply = new ReplyService(store, kase, client);
    const drafted = await reply.suggest("MON", 0);
    expect(drafted.reply.draft).toMatchObject({ template: "accept_offer", slotKey: "2026-11-16T13:00", origin: "model" });

    // The test setup already makes fetch throw. Count every way out as well.
    const fetchSpy = vi.fn(() => {
      throw new Error(NETWORK_BLOCKED);
    });
    vi.stubGlobal("fetch", fetchSpy);
    const spies = [
      vi.spyOn(net.Socket.prototype, "connect"),
      vi.spyOn(net, "connect"),
      vi.spyOn(net, "createConnection"),
      vi.spyOn(tls, "connect"),
      vi.spyOn(http, "request"),
      vi.spyOn(http, "get"),
      vi.spyOn(https, "request"),
      vi.spyOn(https, "get"),
      vi.spyOn(dns, "lookup"),
    ];
    const before = store.readAll().length;
    const messages = service.messages().length;

    const view = reply.approve(drafted.reply.draft!.id, drafted.reply.draft!.fields.map((f) => f.name), drafted.reply.version);

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    const written = store.readAll().slice(before);
    expect(written.map((e) => [e.streamId, e.type])).toEqual([
      ["reply", "reply_approved"],
      ["reply", "reply_send_simulated"],
      ["evidence:reply-d1-1", "reply_recorded"],
    ]);
    // The send adds no message to the case.
    expect(service.messages()).toHaveLength(messages);
    expect(view.reply.sent).toMatchObject([{ template: "accept_offer", slotLabel: "Monday 11/16 1:00 PM", simulated: true }]);
    expect(view.slots.find((s) => s.key === "2026-11-16T13:00")!.stateLabel).toBe("Requested · reported by you");
    expect(SIMULATED_SEND_LABEL).toBe("Simulated. Nothing was sent.");
  });

  it("the spies see a real connection attempt, so a silent pass above is not an accident", () => {
    const spy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) {
      return this;
    });
    new net.Socket().connect(9, "127.0.0.1");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
