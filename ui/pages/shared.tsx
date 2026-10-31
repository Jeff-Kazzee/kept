// The small parts of Settings the shell shows on every load: the theme
// switch (also in the account menu), the time zone notice and the Delete
// case sentence. Settings, Connections and Usage load on demand (0019,
// P18), so these live apart from them.
import { useEffect, useId, useState } from "react";
import { ActionButton, type Run } from "../components/ActionButton.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import type { Settings } from "../contract.ts";
import { THEME_EVENT, readTheme, saveTheme, type ThemeChoice } from "../theme.ts";

const THEMES: Array<{ value: ThemeChoice; label: string; icon: IconName }> = [
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "system", label: "System", icon: "monitor" },
];

// The theme switch, in Settings and in the account menu. Both stay in step
// through the theme event (Z7).
export function ThemeSetting({ compact = false }: { compact?: boolean }) {
  const uid = useId();
  const [choice, setChoice] = useState<ThemeChoice>(() => (typeof localStorage === "undefined" ? "dark" : readTheme()));
  useEffect(() => {
    const update = (e: Event) => setChoice((e as CustomEvent<ThemeChoice>).detail);
    window.addEventListener(THEME_EVENT, update);
    return () => window.removeEventListener(THEME_EVENT, update);
  }, []);
  return (
    <fieldset className={compact ? "stack-xs theme-compact" : "stack-sm"}>
      <legend className={compact ? "menu-label" : "field-label"}>Theme</legend>
      <div className="segmented">
        {THEMES.map((t) => (
          <label key={t.value} htmlFor={`${uid}-${t.value}`}>
            <input
              id={`${uid}-${t.value}`}
              type="radio"
              name={`${uid}-theme`}
              value={t.value}
              checked={choice === t.value}
              onChange={() => {
                setChoice(t.value);
                saveTheme(t.value);
              }}
            />
            <Icon name={t.icon} size="sm" /> {t.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const SOURCE_WORDS: Record<Settings["timezoneSource"], string> = {
  you: "Set by you",
  agent: "Set by the assistant",
  browser: "From the first browser that opened the app",
  default: "The app's default",
};

// 0016, H3: where the zone came from. "From this device" only when this
// device's zone is the case's zone.
export function zoneSourceWords(source: Settings["timezoneSource"], zone: string, device: string | null): string {
  return source === "browser" && device === zone ? "From this device" : SOURCE_WORDS[source];
}

// 0016, H3: the zone came from a browser or the default and differs from
// this device's. Null when there is nothing to say.
export function zoneMismatch(settings: Pick<Settings, "timezone" | "timezoneSource">, device: string | null): string | null {
  if (!device || device === settings.timezone) return null;
  return settings.timezoneSource === "browser" || settings.timezoneSource === "default" ? device : null;
}

// A short notice with one button. The zone changes only when the person
// presses it.
export function ZoneNotice({ settings, device, run, save }: { settings: Settings; device: string | null; run: Run; save: (zone: string) => Promise<unknown> }) {
  const other = zoneMismatch(settings, device);
  if (!other) return null;
  const from = settings.timezoneSource === "browser" ? "set by the first browser that opened the app" : "the app's default";
  return (
    <div className="offline zone-notice" role="status">
      <Icon name="globe" size="sm" />
      <span>
        Times show in {settings.timezone}, {from}. This device uses {other}.
      </span>
      <ActionButton run={run} size="sm" variant="ghost" action={() => save(other)}>
        Use {other}
      </ActionButton>
    </div>
  );
}

// What the page says once Delete case finished (0017, E5).
export const CASE_DELETED_TEXT = "The case was deleted. Its messages, facts, replies, chat and activity are erased. Events it added to Google Calendar stay there.";
// 0021, D6: on the hosted site's shared demo calendar the case's events go
// too, or, when Google could not be reached, go with the next sweep
// (sprint 19 round 2, finding 5).
export const CASE_DELETED_SHARED_TEXT = "The case was deleted. Its messages, facts, replies, chat and activity are erased, and so are the events it added to the demo calendar.";
export const CASE_DELETED_PENDING_TEXT =
  "The case was deleted. Its messages, facts, replies, chat and activity are erased. Its events in the demo calendar could not be removed just now, so the site removes them within the hour.";

// Fix round 1, R7: the sentence stays on the page while the new, empty case
// is the one shown, so until the next thing done in the case. A Delete case
// is seen by its generation moving on.
export function caseDeletedShown(deletedFrom: number | null, state: { generation: number; caseVersion: number }): boolean {
  return deletedFrom !== null && state.generation !== deletedFrom && state.caseVersion === 0;
}
