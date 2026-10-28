// What powers the assistant, in the composer: the provider and the model
// ("Meta · Muse Spark 1.3"). It opens a picker of the provider's models,
// with a way to the provider settings. Settings has the same choice
// (ModelSelect). Each change sends the settings version it was shown at.
import { useId, useState } from "react";
import { Icon } from "../components/Icon.tsx";
import { useMenu } from "../components/Menu.tsx";
import type { ModelOption, Provider, Settings } from "../contract.ts";
import { useAgent } from "./AgentContext.tsx";

export const PROVIDER_SHORT: Record<Provider, string> = { meta: "Meta", chatgpt: "ChatGPT" };

const COST_WORDS: Record<NonNullable<ModelOption["costHint"]>, string> = { lower: "Lower cost", higher: "Higher cost" };

export const costWords = (m: ModelOption) => (m.costHint ? COST_WORDS[m.costHint] : null);

// "Meta · Muse Spark 1.3", or the provider alone while no model is set.
export function modelLabel(s: Settings): string | null {
  if (!s.provider) return null;
  const model = s.models.find((m) => m.id === s.model);
  return model ? `${PROVIDER_SHORT[s.provider]} · ${model.label}` : PROVIDER_SHORT[s.provider];
}

// The short form a phone shows: "Meta · Spark 1.3".
export const shortModelLabel = (label: string) => label.replace(/\bMuse /, "").replace(/ \(sample connection\)/, "");

// `fallback` names what answers when the build has no settings route or no
// provider is set, such as "Recorded responses".
export function ModelPicker({ fallback, scripted = false }: { fallback: string; scripted?: boolean }) {
  const { settings, settingsAvailable, backend, reload, openSettings, report } = useAgent();
  const menu = useMenu();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const ready = settingsAvailable && settings.providersInBuild;
  const chosen = ready ? modelLabel(settings) : null;
  // The scripted chat answers whatever is picked, and says so.
  const label = chosen ? (scripted ? `${chosen} (scripted)` : chosen) : fallback;
  const pick = async (model: string) => {
    setBusy(true);
    try {
      await backend.setModel(model, settings.settingsVersion);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return (
    <div className="attach model">
      <button
        ref={menu.buttonRef}
        type="button"
        className="model-pill"
        aria-expanded={menu.open}
        aria-controls={id}
        aria-label={`Model: ${label}. Change the model`}
        aria-busy={busy || undefined}
        onClick={() => menu.setOpen((o) => !o)}
      >
        <Icon name="sparkle" size="sm" />
        <span className="model-long">{label}</span>
        <span className="model-short" aria-hidden="true">
          {shortModelLabel(chosen ?? fallback)}
        </span>
        <Icon name="chevronDown" size="sm" />
      </button>
      <div ref={menu.menuRef} id={id} className="menu menu-wide" hidden={!menu.open}>
        {ready && settings.models.length > 0 ? (
          <>
            <p className="menu-label">{settings.provider ? `${PROVIDER_SHORT[settings.provider]} models` : "Models"}</p>
            {settings.models.map((m) => (
              <button
                key={m.id}
                type="button"
                className="menu-item"
                aria-pressed={m.id === settings.model}
                disabled={busy}
                onClick={() => menu.choose(() => void (m.id === settings.model ? undefined : pick(m.id)))}
              >
                <span className="menu-check" aria-hidden="true">
                  {m.id === settings.model && <Icon name="check" size="sm" />}
                </span>
                <span>
                  {m.label}
                  {costWords(m) && <small>{costWords(m)}</small>}
                </span>
              </button>
            ))}
          </>
        ) : (
          <p className="menu-label">{ready ? "Pick a provider in Settings to choose a model." : "Choosing a model is not available in this build yet."}</p>
        )}
        <button type="button" className="menu-item" onClick={() => menu.choose(openSettings)}>
          <Icon name="settings" />
          <span>Provider and sign-in settings</span>
        </button>
      </div>
    </div>
  );
}

// The same choice in Settings, as a labeled select.
export function ModelSelect() {
  const { settings, backend, reload, report } = useAgent();
  const uid = useId();
  if (!settings.provider || settings.models.length === 0) return null;
  return (
    <label className="field" htmlFor={`${uid}-model`}>
      <span>Model</span>
      <select
        id={`${uid}-model`}
        name="model"
        className="select"
        value={settings.model}
        onChange={async (e) => {
          try {
            await backend.setModel(e.target.value, settings.settingsVersion);
          } catch (err) {
            report(err);
          }
          await reload();
        }}
      >
        {settings.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {costWords(m) ? ` (${costWords(m)!.toLowerCase()})` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
