// The settings routes (0009, J5). Sprint 8 owns the time zone part. The
// provider, model and sign-in parts are sprint 10's (0010), kept in their
// own settings database and served by server/auth.ts, which gives this
// module its part of the view through `ProviderSource`. Without one, as in
// tests of the time zone alone, they read as not set. No route here
// returns a key or a token.
//
// One `settingsVersion` covers both stores (0010 P32): the settings
// stream's version plus the provider settings' version. Both only grow, so
// the sum grows on every change, and an equal sum means neither moved. A
// time zone write turns the page's version back into the stream's by
// taking off the provider part, and its 409 reports the sum.
//
// GET /api/settings           the settings view below
// PUT /api/settings/timezone  { timezone, expectedVersion, source? }
//   An IANA zone name, checked against the zones this runtime knows. The
//   page sends `source: "browser"` when it sends the browser's zone on first
//   load, while no zone is set. Answers the settings view.
import { z } from "zod";
import { YOU, type CaseActions } from "../src/actions/service.ts";
import { timezoneSettings, type TimezoneSettings } from "../src/settings/events.ts";
import { StaleEditError, type EventStore } from "../src/store/event-log.ts";

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

// Sprint 10's part of the view and its own version. `view` may add the
// model fields (model, models, modelNotice).
export type ProviderSource = { version(): number; view(): ProviderSettings & Record<string, unknown> };

const NO_SOURCE: ProviderSource = { version: () => 0, view: () => NO_PROVIDER };

export type SettingsView = TimezoneSettings & ProviderSettings;

// The whole view: the time zone part, the provider part, and one version.
export function settingsView(store: EventStore, source: ProviderSource = NO_SOURCE): SettingsView {
  const tz = timezoneSettings(store);
  return { ...tz, ...source.view(), settingsVersion: tz.settingsVersion + source.version() };
}

const TimezoneBody = z
  .object({ timezone: z.string().min(1).max(64), expectedVersion: z.number().int().nonnegative(), source: z.literal("browser").optional() })
  .strict();

export type Route = [string, RegExp, (m: RegExpExecArray, body: unknown) => Promise<unknown> | unknown];

export function settingsRoutes(store: EventStore, actions: CaseActions, source: ProviderSource = NO_SOURCE): Route[] {
  const view = (): SettingsView => settingsView(store, source);
  return [
    ["GET", /^\/api\/settings$/, () => view()],
    [
      "PUT",
      /^\/api\/settings\/timezone$/,
      (_m, body) => {
        const { timezone, expectedVersion, source: from } = TimezoneBody.parse(body);
        const providerVersion = source.version();
        const streamVersion = expectedVersion - providerVersion;
        try {
          // A version below the provider part cannot be current, and the
          // stream's own check refuses it.
          actions.setTimezone(YOU, timezone, Math.max(streamVersion, -1), { browser: from === "browser" });
        } catch (err) {
          // Reported in the page's terms: the whole version and view.
          if (err instanceof StaleEditError) {
            const current = view();
            throw new StaleEditError(err.streamId, expectedVersion, current.settingsVersion, current);
          }
          throw err;
        }
        return view();
      },
    ],
  ];
}
