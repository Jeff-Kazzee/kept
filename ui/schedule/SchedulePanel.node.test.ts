// Review 1, finding 6: "Waiting for you" shows the open question and the
// open reply draft together, and the draft card only once. Built from a
// real case through the API, as the page reads it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../../server/api.ts";
import { CaseService } from "../../src/case/service.ts";
import { RecordedModelClient } from "../../src/model/recorded.ts";
import { ReplyService } from "../../src/reply/service.ts";
import { EventStore } from "../../src/store/event-log.ts";
import { acceptMessages, agentAccess, intake } from "../../test/helpers.ts";
import type { AppState } from "../api.ts";
import { ScheduleTab, waitingCount } from "./SchedulePanel.tsx";

describe("waiting for you", () => {
  it("shows the open question and a draft opened by hand, with one draft card", async () => {
    const store = new EventStore(":memory:");
    const svc = intake(store);
    const client = RecordedModelClient.fromDirectory();
    const kase = new CaseService(store, svc, client, { userName: "Dana Reyes" });
    const reply = new ReplyService(store, kase, client);
    const api = createApi(svc, kase, { mode: "recorded" }, reply, agentAccess(store, svc, kase));
    await acceptMessages(svc, ["m1", "m2", "m3"]);
    const asked = await kase.askNext(kase.view().questionsVersion);
    expect(asked.question).not.toBeNull();
    // A reply about Tuesday, picked by hand while the question is open.
    reply.start("accept_offer", "2026-11-10T14:00", kase.view().reply.version);
    const state = (await api({ method: "GET", path: "/api/state", body: undefined })).body as AppState;
    expect(state.case.question).not.toBeNull();
    expect(state.case.reply.draft).not.toBeNull();
    expect(waitingCount(state)).toBe(2);

    const html = renderToStaticMarkup(createElement(ScheduleTab, { state, run: async () => {}, highlight: null }));
    expect(html).toContain('aria-label="Question"');
    expect(html).toContain(state.case.question!.text.replaceAll("'", "&#x27;"));
    expect(html.match(/aria-label="Reply draft"/g)).toHaveLength(1);
  });

  it("offers a conflict that waits for a question, with Explain and Ask, when the chat has not asked it", async () => {
    const store = new EventStore(":memory:");
    const svc = intake(store);
    const client = RecordedModelClient.fromDirectory();
    const kase = new CaseService(store, svc, client, { userName: "Dana Reyes" });
    const api = createApi(svc, kase, { mode: "recorded" }, new ReplyService(store, kase, client), agentAccess(store, svc, kase));
    await acceptMessages(svc, ["m1", "m2", "m3"]);
    const state = (await api({ method: "GET", path: "/api/state", body: undefined })).body as AppState;
    expect(state.case.question).toBeNull();
    expect(waitingCount(state)).toBe(1);
    const html = renderToStaticMarkup(createElement(ScheduleTab, { state, run: async () => {}, highlight: null }));
    expect(html).toContain('aria-label="Explanation"');
    expect(html).toContain(" Explain with the model</button>");
    expect(html).toContain(">Ask me the question about this</button>");
  });
});
