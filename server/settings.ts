// The settings routes (0009, J5). Sprint 8 owns the time zone part. The
// provider and sign-in parts belong to sprint 10, which adds its own routes
// and fills `ProviderSettings`. Until then they read as not set. No route
// here returns a key or a token.
//
// GET /api/settings           the settings view below
// PUT /api/settings/timezone  { timezone, expectedVersion, source? }
//   An IANA zone name, checked against the zones this runtime knows. The
//   page sends `source: "browser"` when it sends the browser's zone on first
//   load, while no zone is set. Answers the settings view.
import { z } from "zod";
import { YOU, type CaseActions } from "../src/actions/service.ts";
import { timezoneSettings, type TimezoneSettings } from "../src/settings/events.ts";
import type { EventStore } from "../src/store/event-log.ts";

// Owned by sprint 10.
export type ProviderSettings = {
  provider: "meta" | "chatgpt" | null;
  meta: { keySet: boolean; source: "you" | "server" | null };
  chatgpt: { signedIn: boolean; name: string | null; email: string | null; planUsage: boolean };
};

export const NO_PROVIDER: ProviderSettings = {
  provider: null,
  meta: { keySet: false, source: null },
  chatgpt: { signedIn: false, name: null, email: null, planUsage: false },
};

export type SettingsView = TimezoneSettings & ProviderSettings;

const TimezoneBody = z
  .object({ timezone: z.string().min(1).max(64), expectedVersion: z.number().int().nonnegative(), source: z.literal("browser").optional() })
  .strict();

export type Route = [string, RegExp, (m: RegExpExecArray, body: unknown) => Promise<unknown> | unknown];

export function settingsRoutes(store: EventStore, actions: CaseActions, provider: () => ProviderSettings = () => NO_PROVIDER): Route[] {
  const view = (): SettingsView => ({ ...timezoneSettings(store), ...provider() });
  return [
    ["GET", /^\/api\/settings$/, () => view()],
    [
      "PUT",
      /^\/api\/settings\/timezone$/,
      (_m, body) => {
        const { timezone, expectedVersion, source } = TimezoneBody.parse(body);
        actions.setTimezone(YOU, timezone, expectedVersion, { browser: source === "browser" });
        return view();
      },
    ],
  ];
}
