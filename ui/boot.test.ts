// Muse round 2, finding 1: the first read belongs to one session owner. A
// sign-out and a sign-in as another account in the same page read again,
// and a read kept for one owner is never given to another.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoot, scopeBoot } from "./boot.ts";

const bootOf = (who: string, generation: number) => ({ live: { generation, seq: 1 }, state: { generation, who }, settings: null, activity: null, google: null, chat: null });

afterEach(() => {
  vi.unstubAllGlobals();
  scopeBoot("none");
});

describe("Muse round 2, finding 1: the boot read and the session owner", () => {
  it("signs out and in as another account: the new account reads its own case, never the old one's", async () => {
    let account = "a";
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (path: string) => {
      fetched.push(`${account}:${path}`);
      return new Response(JSON.stringify(bootOf(account, 1)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const first = await readBoot(false, "hosted:google:a@example.com");
    expect((first!.state as unknown as { who: string }).who).toBe("a");
    // The same owner, the same page: the read is kept.
    await readBoot(false, "hosted:google:a@example.com");
    expect(fetched).toEqual(["a:/api/boot"]);
    // Sign-out, then another account.
    scopeBoot("signed-out");
    account = "b";
    const second = await readBoot(false, "hosted:google:b@example.com");
    expect((second!.state as unknown as { who: string }).who).toBe("b");
    expect(fetched).toEqual(["a:/api/boot", "b:/api/boot"]);
  });

  it("a read kept for one owner is refused to another, even without a scope change", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(bootOf(`r${++n}`, n)), { status: 200, headers: { "Content-Type": "application/json" } }));
    const a = await readBoot(false, "hosted:google:a@example.com");
    const b = await readBoot(false, "hosted:judge:");
    expect(a).not.toBe(b);
    expect((b!.state as unknown as { who: string }).who).toBe("r2");
  });

  it("a route that says the case kept moving gives no boot, and the page reads each route", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "boot_unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } }));
    expect(await readBoot(false, "local")).toBeNull();
    expect(await readBoot(true, "local")).toBeNull();
  });
});
