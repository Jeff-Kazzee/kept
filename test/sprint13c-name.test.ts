// Sprint 13C, M2 (0016): a reply is signed only with a name the person gave
// in this case. The app no longer signs with the fixtures' profile, and
// Delete case erases the name.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../server/api.ts";
import { createWorkspace } from "../server/workspace.ts";
import { CaseActions, PersonOnlyError, YOU } from "../src/actions/service.ts";
import { CaseService } from "../src/case/service.ts";
import type { CaseView } from "../src/case/types.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { RecordsService } from "../src/records/service.ts";
import { ReplyService } from "../src/reply/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { fixtureMessage, intake, useZone } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The services as the app builds them: no name passed in.
function app() {
  const store = new EventStore(":memory:", () => "2026-11-06T17:00:00.000Z");
  useZone(store);
  const client = RecordedModelClient.fromDirectory();
  const svc = intake(store);
  const kase = new CaseService(store, svc, client);
  const reply = new ReplyService(store, kase, client);
  const records = new RecordsService(store, svc, kase);
  const actions = new CaseActions(store, { intake: svc, kase, reply, records });
  return { store, intake: svc, kase, reply, records, actions, api: createApi(svc, kase, {}, reply, { store, records }) };
}

describe("sprint 13C, M2: the name that signs a reply", () => {
  it("the app's own workspace has no name until the person gives one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "s13c-name-"));
    dirs.push(dir);
    const ws = createWorkspace({ dbPath: path.join(dir, "app.sqlite"), secretsPath: path.join(dir, "app-secrets.sqlite"), port: 5197, extraHosts: [], googleClient: null, serverMetaKey: null });
    expect(ws.kase.userName()).toBeNull();
    expect(ws.kase.view().profile).toEqual({ userName: null, version: 0 });
    ws.close();
  });

  it("an open draft is built again and signed once the person gives a name, and Delete case erases it", async () => {
    const a = app();
    const m = a.actions.importMessage(YOU, fixtureMessage("m3"));
    const { evidence } = await a.actions.extract(YOU, m.id, { effort: "low", expectedVersion: m.version });
    for (const e of evidence) a.actions.acceptClaim(YOU, e.id, e.version);
    const offered = a.kase.view().slots.find((s) => s.state === "offered")!;
    let view = a.actions.startReply(YOU, "accept_offer", offered.key, a.kase.view().reply.version);
    expect(view.profile).toEqual({ userName: null, version: 0 });
    expect(view.reply.draft!.text.endsWith("Thank you.")).toBe(true);
    expect(view.reply.draft!.text).not.toContain("Dana");
    expect(view.reply.draft!.fields.find((f) => f.name === "user_name")).toMatchObject({ value: null, display: null });

    // Only the person gives it, and never an address.
    expect(() => a.actions.giveName({ actor: "agent" }, "Sam Rivera", 0)).toThrow(PersonOnlyError);
    const call = (body: unknown) => a.api({ method: "POST", path: "/api/profile/name", body, generation: a.kase.generation() });
    expect((await call({ expectedVersion: 0, name: "sam@example.com" })).status).toBe(422);
    const res = await call({ expectedVersion: 0, name: "  Sam   Rivera " });
    expect(res.status).toBe(200);
    view = res.body as CaseView;
    expect(view.profile).toEqual({ userName: "Sam Rivera", version: 1 });
    expect(view.reply.draft).toMatchObject({ id: "d2", valid: true });
    expect(view.reply.draft!.text.endsWith("Thank you,\nSam Rivera")).toBe(true);
    expect(a.actions.activity().entries[0]).toMatchObject({ kind: "name_given", summary: "Gave the name that signs your replies.", undoable: false });
    expect(JSON.stringify(a.actions.activity())).not.toContain("Sam Rivera");
    // A second give states the version it saw.
    expect((await call({ expectedVersion: 0, name: "Sam R" })).status).toBe(409);

    a.kase.deleteCase(a.kase.caseVersion(), "DELETE");
    expect(a.kase.view().profile).toEqual({ userName: null, version: 0 });
  });
});
