// Sprint 6 review round 1, finding 1: defense in depth on the local HTTP
// API. A request that changes state must come from the app's own page, and
// creating a grant or confirming an agent's proposal also needs the pairing
// code the server prints at start. Run against the real server process on a
// temporary database. These checks raise the bar only: a process running as
// the same OS user can still open the database file (see 0006).
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PAIRING_FAILURES, Pairing, requestSourceProblem } from "../server/guard.ts";
import { CaseService } from "../src/case/service.ts";
import { GrantStore } from "../src/grants/grants.ts";
import { RecordedModelClient } from "../src/model/recorded.ts";
import { fromPackage } from "../src/paths.ts";
import { RecordsService } from "../src/records/service.ts";
import { EventStore } from "../src/store/event-log.ts";
import { acceptMessages, intake } from "./helpers.ts";

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Res = { status: number; body: any };

function call(port: number, method: string, p: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// A case with m2 accepted and one pending proposal from an agent, then the
// app on that file. Returns the pairing code the server printed.
async function startApp() {
  const dir = mkdtempSync(path.join(tmpdir(), "http-guard-"));
  dirs.push(dir);
  const file = path.join(dir, "app.sqlite");
  const store = new EventStore(file);
  const svc = intake(store);
  const records = new RecordsService(store, svc, new CaseService(store, svc, RecordedModelClient.fromDirectory()));
  await acceptMessages(svc, ["m2"]);
  const { grant } = new GrantStore(store).create("Phone helper", "propose");
  const proposal = records.propose({ kind: "user_report", claim_type: "cancel", date: "2026-11-12", time: "10:30", statement: "Dana canceled Thursday." }, grant);
  store.close();

  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, APP_PORT: String(port), APP_DB: file, APP_LIVE_MODEL: "", MODEL_API_KEY: "" };
  const child = spawn(process.execPath, [fromPackage("server/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const code = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /Pairing code for this run: ([A-Z0-9]{4}-[A-Z0-9]{4})\./.exec(out);
      if (m) resolve(m[1]!);
    });
    child.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    setTimeout(() => reject(new Error("server did not start")), 15_000);
  });
  const state = async () => (await call(port, "GET", "/api/state", {})).body as { generation: number; grants: unknown[]; proposals: Array<{ id: string; status: string }>; messages: unknown[] };
  const page = (extra: Record<string, string> = {}) => ({
    "Content-Type": "application/json",
    "X-Case-Generation": "0",
    Origin: `http://127.0.0.1:${port}`,
    "X-Appointments-App": "1",
    ...extra,
  });
  return { port, code, proposalId: proposal.id, state, page };
}

const M = { channel: "sms", from: "Clinic", received_at: "2026-11-05T09:00:00-07:00", text: "See you Monday." };

describe("finding 1a: requests that change state must come from the app's page", () => {
  it("refuses a request with no Origin, a foreign Origin, a cross-site fetch or no app header, and writes nothing", async () => {
    const app = await startApp();
    const before = (await app.state()).messages.length;
    const refused = [
      { "Content-Type": "application/json", "X-Case-Generation": "0" },
      app.page({ Origin: "http://attacker.example" }),
      app.page({ Origin: "http://attacker.example", "Sec-Fetch-Site": "cross-site" }),
      { ...app.page(), "X-Appointments-App": "0" },
      (() => {
        const { "X-Appointments-App": _a, ...rest } = app.page();
        return rest;
      })(),
    ];
    for (const headers of refused) {
      expect(await call(app.port, "POST", "/api/messages", headers, M)).toMatchObject({ status: 403, body: { error: "forbidden_source" } });
    }
    expect((await app.state()).messages).toHaveLength(before);
    // The app's page: the same Origin, or Sec-Fetch-Site same-origin, and the app header.
    expect((await call(app.port, "POST", "/api/messages", app.page(), M)).status).toBe(200);
    const { Origin: _o, ...noOrigin } = app.page({ "Sec-Fetch-Site": "same-origin" });
    expect((await call(app.port, "POST", "/api/messages", noOrigin, M)).status).toBe(200);
    expect((await app.state()).messages).toHaveLength(before + 2);
    // Reads need neither.
    expect((await call(app.port, "GET", "/api/case/version", {})).status).toBe(200);
  }, 20_000);

  it("the rule itself", () => {
    const origins = ["http://127.0.0.1:5180", "http://localhost:5180"];
    expect(requestSourceProblem({ method: "GET" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "http://localhost:5180", appHeader: "1" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", secFetchSite: "same-origin", appHeader: "1" }, origins)).toBeNull();
    expect(requestSourceProblem({ method: "POST", secFetchSite: "same-site", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "http://127.0.0.1:5181", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "POST", origin: "null", appHeader: "1" }, origins)).not.toBeNull();
    expect(requestSourceProblem({ method: "PUT", origin: "http://localhost:5180" }, origins)).not.toBeNull();
  });
});

describe("finding 1b: creating a grant and confirming a proposal need the pairing code", () => {
  it("refuses both without the code or with a wrong one and writes nothing, and allows both with it", async () => {
    const app = await startApp();
    const grant = { name: "Agent made", tier: "propose" };
    const confirm = `/api/proposals/${app.proposalId}/confirm`;
    for (const [extra, error] of [
      [{}, "pairing_required"],
      [{ "X-Pairing-Code": "" }, "pairing_required"],
      [{ "X-Pairing-Code": "2222-2222" }, "pairing_failed"],
    ] as const) {
      expect(await call(app.port, "POST", "/api/grants", app.page(extra), grant)).toMatchObject({ status: 403, body: { error } });
      expect(await call(app.port, "POST", confirm, app.page(extra), { expectedVersion: 1 })).toMatchObject({ status: 403, body: { error } });
    }
    let s = await app.state();
    expect(s.grants).toHaveLength(1);
    expect(s.proposals).toEqual([expect.objectContaining({ id: app.proposalId, status: "pending" })]);

    // Other writes need no code. Reject and revoke only narrow access.
    const withCode = app.page({ "X-Pairing-Code": app.code });
    const created = await call(app.port, "POST", "/api/grants", withCode, grant);
    expect(created).toMatchObject({ status: 200, body: { grant: { name: "Agent made" } } });
    // The code is accepted in lower case and without the dash, as typed.
    expect((await call(app.port, "POST", confirm, app.page({ "X-Pairing-Code": app.code.toLowerCase().replace("-", "") }), { expectedVersion: 1 })).status).toBe(200);
    s = await app.state();
    expect(s.grants).toHaveLength(2);
    expect(s.proposals[0]).toMatchObject({ status: "confirmed" });
    // The code never comes back in any response.
    expect(JSON.stringify(s)).not.toContain(app.code);
  }, 20_000);

  it(`locks both actions after ${MAX_PAIRING_FAILURES} wrong codes until the app restarts`, () => {
    const pairing = new Pairing("ABCD-EFGH");
    expect(pairing.check("abcdefgh")).toBe("ok");
    for (let i = 1; i < MAX_PAIRING_FAILURES; i++) expect(pairing.check("WRONG-CODE")).toBe("wrong");
    expect(pairing.check("WRONG-CODE")).toBe("locked");
    expect(pairing.check("ABCD-EFGH")).toBe("locked");
    expect(new Pairing().code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });
});
