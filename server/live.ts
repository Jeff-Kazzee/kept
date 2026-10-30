// Round 2, finding 4: the page learns of a change at once. GET
// /api/case/version?since=<generation>.<seq>.<calendar> is held until the
// case's live version differs from `since`, or LIVE_HOLD_MS pass, and then
// answers the current version. Without `since` the route answers at once,
// as before. The wait reads the version every LIVE_CHECK_MS, a cheap read
// of the event log, because the MCP server writes to the same file from its
// own process. It stops when the client goes away. In hosted mode each
// check opens the account's workspace briefly, so a held request never
// keeps it open (server/hosted.ts).
export const LIVE_PATH = "/api/case/version";
export const LIVE_HOLD_MS = 25_000;
export const LIVE_CHECK_MS = 250;

export type Live = { generation: number; seq: number; calendar?: number };

const sameLive = (a: Live, b: Live) => a.generation === b.generation && a.seq === b.seq && (a.calendar ?? 0) === (b.calendar ?? 0);

// "12.340.2" or "12.340" -> the version, else null.
export function parseSince(search: string | undefined): Live | null {
  const raw = new URLSearchParams(search ?? "").get("since");
  if (raw === null || !/^\d{1,15}\.\d{1,15}(\.\d{1,15})?$/.test(raw)) return null;
  const [generation, seq, calendar] = raw.split(".").map(Number) as [number, number, number | undefined];
  return calendar === undefined ? { generation, seq } : { generation, seq, calendar };
}

export async function waitForChange(
  read: () => Promise<Live>,
  since: Live,
  o: { closed: () => boolean; holdMs?: number; checkMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<Live | null> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.holdMs ?? LIVE_HOLD_MS);
  for (;;) {
    const current = await read();
    if (!sameLive(current, since) || now() >= end) return current;
    await sleep(o.checkMs ?? LIVE_CHECK_MS);
    if (o.closed()) return null;
  }
}
