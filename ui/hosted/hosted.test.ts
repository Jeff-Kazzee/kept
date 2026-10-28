// The hosted site's pages as a person sees them (0014, design item 6, and
// 0015): the sign-in screen, the sidebar's account menu, Connections with
// usage credits in place of a key, the model costs, Usage, Delete account
// in Settings, and the usage stop in the chat. Rendered to static markup with the server renderer. Local
// mode shows none of it.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PARTIAL_TEXT } from "../../src/agent/types.ts";
import { USAGE_TEXT, usageStopText } from "../../src/model/usage-text.ts";
import { AgentContext, DEFAULT_AGENT, type AgentState } from "../agent/AgentContext.tsx";
import { ModelSelect } from "../agent/ModelPicker.tsx";
import { turnErrorText } from "../chat/ChatView.tsx";
import { DEFAULT_SETTINGS, type Settings } from "../contract.ts";
import { errorSentence } from "../format.ts";
import { ApiError } from "../api.ts";
import { ConnectionsPage, SettingsPage, UsagePage } from "../pages/Settings.tsx";
import { AccountMenu } from "../shell/AccountMenu.tsx";
import { person } from "../shell/shell.ts";
import { SignIn, judgePath } from "./SignIn.tsx";
import { accountLabel, hostedSignInError, type SignedInSession } from "./session.ts";

const run = async () => {};
const html = (node: ReactNode, agent: Partial<AgentState> = {}) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, ...agent } }, node)).replaceAll("&#x27;", "'");

const session: SignedInSession = {
  mode: "hosted",
  signedIn: true,
  account: { kind: "google", email: "dana@example.com", name: "Dana Demo" },
  balanceMicros: 4_870_000,
  balance: "$4.87",
  expiresAt: 0,
  googleSignIn: true,
};

const hostedSettings: Settings = {
  ...DEFAULT_SETTINGS,
  settingsVersion: 2,
  provider: "meta",
  model: "muse-spark-1.3",
  meta: { keySet: true, source: "server" },
  models: [
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", costHint: "lower", turnCost: "about $0.09 a turn" },
    { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", costHint: "higher", turnCost: "about $0.38 a turn" },
  ],
  hosted: { chatgptAvailable: false, chatgptText: "x" },
};

describe("the hosted site", () => {
  it("the sign-in screen offers Google and a judge code, and /judge opens the code form", () => {
    const page = html(createElement(SignIn, { googleSignIn: true, notice: null, onSignedIn: () => {} }));
    expect(page).toContain("Sign in with Google");
    expect(page).toContain("I have a judge code");
    expect(page).not.toContain('name="judge-code"');
    expect(judgePath("/judge")).toBe(true);
    expect(judgePath("/judge/")).toBe(true);
    expect(judgePath("/judges")).toBe(false);
    const noGoogle = html(createElement(SignIn, { googleSignIn: false, notice: "Google sign-in was canceled. Nothing changed. You can try again.", onSignedIn: () => {} }));
    expect(noGoogle).not.toContain("Sign in with Google</button>");
    expect(noGoogle).toContain('role="alert"');
    expect(hostedSignInError("access_denied")).toBe("Google sign-in was canceled. Nothing changed. You can try again.");
    expect(hostedSignInError("anything")).toMatch(/did not finish/);
  });

  it("the sidebar's account menu names the account and its balance, with Settings, Usage, the theme and Sign out", () => {
    const menu = html(createElement(AccountMenu, { mode: "hosted", who: person(session, null), session, compact: false, onOpen: () => {}, onSignOut: () => {} }));
    expect(menu).toContain('aria-label="Account: Dana Demo, Balance $4.87"');
    expect(menu).toContain(">DD</span>");
    expect(menu).toContain("dana@example.com");
    for (const item of ["Settings", "Usage", ">Theme</legend>", "Sign out"]) expect(menu).toContain(item);
    expect(accountLabel({ kind: "judge", email: null, name: null })).toBe("Judge account");
    // A judge account is named for what it is.
    const judge: SignedInSession = { ...session, account: { kind: "judge", email: null, name: null } };
    const judgeMenu = html(createElement(AccountMenu, { mode: "hosted", who: person(judge, null), session: judge, compact: false, onOpen: () => {}, onSignOut: () => {} }));
    expect(judgeMenu).toContain("Judge access");
  });

  it("local mode's account menu has Settings and the theme, and no Usage, Sign out or balance", () => {
    const menu = html(createElement(AccountMenu, { mode: "local", who: person(null, null), session: null, compact: false, onOpen: () => {}, onSignOut: () => {} }));
    expect(menu).toContain('aria-label="Account: You, This computer"');
    expect(menu).toContain("Settings");
    expect(menu).toContain(">Theme</legend>");
    expect(menu).not.toContain("Usage");
    expect(menu).not.toContain("Sign out");
    expect(menu).not.toContain("Balance");
  });

  it("Connections shows usage credits in place of a key and ChatGPT as not available here, Usage is its own page, and Settings has Delete account", () => {
    const agent = { settings: hostedSettings, settingsAvailable: true, hosted: session };
    const page = html(createElement(ConnectionsPage, { modelClient: "meta-responses", run }), agent);
    expect(page).toContain("Usage credits (Meta models)");
    expect(page).toContain("Sign in with ChatGPT (not available on the hosted site yet)");
    expect(page).toContain("Muse Spark 1.3 costs about $0.09 a turn at your price.");
    expect(page).not.toContain('name="meta-key"');
    expect(page).not.toContain("Continue with ChatGPT");
    expect(html(createElement(UsagePage, { run }), agent)).toContain('id="set-usage"');
    const settings = html(createElement(SettingsPage, { version: 1, erasePending: false, run }), agent);
    expect(settings).toContain("Delete account");
    expect(settings).toContain("Delete case");
    const localAgent = { settings: { ...hostedSettings, hosted: undefined }, settingsAvailable: true };
    expect(html(createElement(ConnectionsPage, { modelClient: "meta-responses", run }), localAgent)).not.toContain("Usage credits");
    expect(html(createElement(SettingsPage, { version: 1, erasePending: false, run }), localAgent)).not.toContain("Delete account");
  });

  it("the model choice shows each model's cost per turn", () => {
    const page = html(createElement(ModelSelect), { settings: hostedSettings, settingsAvailable: true, hosted: session });
    expect(page).toContain("Muse Spark 1.3 (about $0.09 a turn)");
    expect(page).toContain("Muse Wonder 1.0 (about $0.38 a turn)");
  });

  it("a usage stop is a sentence written by code, recognized when stored, and shown as the server wrote it", () => {
    expect(usageStopText(USAGE_TEXT.credits_exhausted.text, PARTIAL_TEXT)).toBe("credits_exhausted");
    expect(usageStopText(`${PARTIAL_TEXT} ${USAGE_TEXT.daily_cap.reason}`, PARTIAL_TEXT)).toBe("daily_cap");
    expect(usageStopText("Your schedule is empty.", PARTIAL_TEXT)).toBeNull();
    expect(turnErrorText({ code: "credits_exhausted", message: USAGE_TEXT.credits_exhausted.text })).toBe(USAGE_TEXT.credits_exhausted.text);
    expect(errorSentence(new ApiError(402, { error: "credits_exhausted", message: USAGE_TEXT.credits_exhausted.text }))).toBe(USAGE_TEXT.credits_exhausted.text);
    expect(errorSentence(new ApiError(409, { error: "judge_used", message: "That judge code was already used. Each code works once." }))).toBe("That judge code was already used. Each code works once.");
  });

  it("the UI text has no em dashes and no semicolons in prose", () => {
    for (const text of [...Object.values(USAGE_TEXT).flatMap((v) => [v.text, v.reason])]) {
      expect(text).not.toMatch(/—|;/);
    }
  });
});
