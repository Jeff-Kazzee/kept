// The hosted site's pages as a person sees them (0014, design item 6, and
// 0015): the sign-in screen, Connections with usage credits in place of a
// key, the model costs, Usage, Delete account in Settings, and the usage
// stop in the chat. Rendered to static markup with the server renderer.
// Local mode shows none of it. The account menu is opened and clicked in
// ui/shell/AccountMenu.dom.test.ts.
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
import { SignIn, judgePath } from "./SignIn.tsx";
import { authErrorText } from "./accountAuth.ts";
import { accountLabel, hostedSignInError, type SignedInSession } from "./session.ts";

const run = async () => {};
const html = (node: ReactNode, agent: Partial<AgentState> = {}) =>
  renderToStaticMarkup(createElement(AgentContext.Provider, { value: { ...DEFAULT_AGENT, ...agent } }, node)).replaceAll("&#x27;", "'");

const session: SignedInSession = {
  mode: "hosted",
  signedIn: true,
  account: { kind: "user", email: "dana@example.com", name: "Dana Demo" },
  balanceMicros: 4_870_000,
  balance: "$4.87",
  expiresAt: 0,
  passwordMin: 10,
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
  it("0020, B9: the sign-in screen offers an email and password, a passkey and a judge code, and /judge opens the code form", () => {
    const page = html(createElement(SignIn, { passwordMin: 10, publicSignup: true, notice: null, onSignedIn: () => {} }));
    expect(page).not.toContain("Google");
    expect(page).toContain('type="email"');
    expect(page).toContain('autoComplete="current-password"');
    expect(page).toContain("Use a passkey");
    expect(page).toContain("I have a judge code");
    expect(page).toContain("Make an account");
    expect(page).not.toContain('name="judge-code"');
    expect(page).toContain("Your password is stored only as a hash.");
    // The privacy line names Better Auth only when its dashboard is on.
    expect(page).not.toContain("Better Auth");
    expect(html(createElement(SignIn, { passwordMin: 10, dashboard: true, publicSignup: true, notice: null, onSignedIn: () => {} }))).toContain("also go to Better Auth");
    expect(judgePath("/judge")).toBe(true);
    expect(judgePath("/judge/")).toBe(true);
    expect(judgePath("/judges")).toBe(false);
    const notice = html(createElement(SignIn, { passwordMin: 10, notice: "Your session ended. Sign in again.", onSignedIn: () => {} }));
    expect(notice).toContain('role="alert"');
    expect(hostedSignInError("chatgpt_not_available_here")).toBe("Sign in with ChatGPT is not available on the hosted site yet.");
    expect(hostedSignInError("anything")).toMatch(/did not finish/);
  });

  it("0020, K7 and K9: with public sign-up off, the screen leads with the judge code, hides Make an account, and links the waitlist when it is set", () => {
    const page = html(createElement(SignIn, { passwordMin: 10, publicSignup: false, waitlistUrl: "https://kept.here.now/", notice: null, onSignedIn: () => {} }));
    expect(page).toContain('name="judge-code"');
    expect(page.indexOf('name="judge-code"')).toBeLessThan(page.indexOf("Sign in to an existing account"));
    expect(page).toContain("Sign in to an existing account");
    expect(page).not.toContain("Make an account");
    expect(page).not.toContain('type="email"');
    expect(page).toContain('Not a judge? Kept is coming soon. <a href="https://kept.here.now/" rel="noopener noreferrer">Join the waitlist.</a>');
    expect(page.indexOf("Not a judge?")).toBeGreaterThan(page.indexOf('name="judge-code"'));
    // No waitlist setting, or one that is not https: no line.
    for (const waitlistUrl of [null, "javascript:alert(1)", "http://kept.example/"]) {
      expect(html(createElement(SignIn, { passwordMin: 10, publicSignup: false, waitlistUrl, notice: null, onSignedIn: () => {} }))).not.toContain("Not a judge?");
    }
    // With public sign-up on, the waitlist line never shows.
    expect(html(createElement(SignIn, { passwordMin: 10, publicSignup: true, waitlistUrl: "https://kept.here.now/", notice: null, onSignedIn: () => {} }))).not.toContain("Not a judge?");
  });

  it("0020: Better Auth's refusals read as the page's own sentences, never the server's text", () => {
    expect(authErrorText(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" })).toBe("That email and password do not match an account. Check them and try again.");
    // Fix round 1, item 6: a refused sign-up never says an account has the email.
    for (const code of ["EMAIL_UNAVAILABLE", "USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"]) {
      expect(authErrorText(422, { code })).toBe("That email cannot be used here. Try another, or sign in if it is yours.");
    }
    expect(authErrorText(403, { error: "signup_closed", message: "New accounts are not open on this site yet. Judges, choose I have a judge code." })).toMatch(/^New accounts are not open/);
    expect(authErrorText(400, { code: "PASSWORD_TOO_SHORT" })).toBe("Use a password of at least 10 characters.");
    expect(authErrorText(429, { message: "Too many requests. Please try again later." })).toBe("Too many tries from here. Wait a minute and try again.");
    expect(authErrorText(429, { error: "rate_limited", message: "Too many tries from this address. Wait a few minutes and try again." })).toMatch(/^Too many tries from this address/);
    expect(authErrorText(500, { code: "SOMETHING", message: "internal detail" })).not.toContain("internal detail");
  });

  it("the account label names a judge account for what it is", () => {
    expect(accountLabel({ kind: "judge", email: null, name: null })).toBe("Judge account");
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
