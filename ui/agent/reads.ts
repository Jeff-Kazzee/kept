// How the shell reads the agent routes (Muse round 1, findings 5 and 8).
// A route that answers 404 is not in this build, and its reader answers
// null. Any other failure keeps what the page last read, so one failed read
// does not reset every time on screen to the default zone. The page then
// says, quietly, that it shows the last settings it read.
import { ApiError } from "../api.ts";
import type { AgentBackend } from "../agentApi.ts";
import type { Settings } from "../contract.ts";

export type Read<T> = { ok: true; value: T | null } | { ok: false };

export async function settle<T>(read: () => Promise<T | null>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

// The value to show: the new one, or the last good one when the read failed.
export const keep = <T>(read: Read<T>, last: T | null): T | null => (read.ok ? read.value : last);

// Sends this device's zone once, on first load with no zone set. "sent"
// and "conflict" (someone set the settings first) both end the attempt.
// "failed" leaves it to try again at the next read.
export async function sendDeviceZone(backend: Pick<AgentBackend, "setTimezone">, settings: Settings, zone: string): Promise<"sent" | "conflict" | "failed"> {
  try {
    await backend.setTimezone(zone, settings.settingsVersion, "browser");
    return "sent";
  } catch (e) {
    return e instanceof ApiError && e.status === 409 ? "conflict" : "failed";
  }
}
