// Sprint 17 (0019): a turn's receipts are one group with an Undo per row
// (P5), slot chips show only for new or changed times (P6), the follow-up
// chips never sit over the transcript (P8), the lazy views open from every
// caller (P18), the fixtures load on demand (P17), and the motion and
// token rules of the stylesheet (P2, P14).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState } from "./api.ts";
import { AgentContext, DEFAULT_AGENT, type AgentState } from "./agent/AgentContext.tsx";
import { FOLD_AT, Receipts, groupSummary } from "./agent/Receipts.tsx";
import { ChatView, freshChips, type ChatViewProps } from "./chat/ChatView.tsx";
import { createFixturesLoader } from "./chat/demo.ts";
import type { ChatState } from "./chat/state.ts";
import type { ChatMessage, FactChip } from "./chat/types.ts";
import type { ActivityEntry } from "./contract.ts";
import { setCaseZone } from "./format.ts";
import { SIDEBAR, VIEW_TITLES, openersFor, type View } from "./shell/shell.ts";
import { installTestDom, mount } from "./test-dom.ts";
import { PART_FAILED, onDemand } from "./components/onDemand.tsx";

beforeAll(() => {
  installTestDom();
  setCaseZone("America/Denver");
});

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const css = read("./styles.css");
const at = "2026-11-05T16:00:00.000Z";

const state = {
  messages: [],
  evidence: [],
  proposals: [],
  records: [],
  case: { slots: [], conflicts: [], question: null, staleEvidenceIds: [], reply: { draft: null, sent: [], options: [], withheld: [], suggestion: null, version: 0 } },
} as unknown as AppState;

const entry = (id: string, summary: string, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  at,
  actor: "agent",
  kind: "timezone_set",
  summary,
  target: null,
  undoable: true,
  undone: false,
  ...extra,
});

describe("0019, P5: the receipt group", () => {
  const three = [entry("a1", "Added the email from Lantern Hill Clinic."), entry("a2", "Set the time zone to America/Denver."), entry("a3", "Added Monday 11/16 1:00 PM to Google Calendar.")];

  it("folds three or more actions under a one-line summary, and each row keeps its own Undo", async () => {
    const undone: string[][] = [];
    const agent: AgentState = { ...DEFAULT_AGENT, undo: async (ids) => void undone.push([...ids]) };
    const view = await mount(createElement(AgentContext.Provider, { value: agent }, createElement(Receipts, { entries: three, state })));
    const summary = view.find(".receipt-summary");
    expect(summary.textContent).toContain("3 actions · Added the email from Lantern Hill Clinic., and 2 more");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(view.find("ul.receipts").getAttribute("hidden")).not.toBeNull();
    await view.click(summary);
    expect(view.find(".receipt-summary").getAttribute("aria-expanded")).toBe("true");
    expect(view.find("ul.receipts").getAttribute("hidden")).toBeNull();
    // One Undo per row, each for its own action only.
    for (const e of three) expect(view.button(`Undo: ${e.summary}`)).toBeTruthy();
    await view.click(view.button(`Undo: ${three[1]!.summary}`));
    expect(undone).toEqual([["a2"]]);
    await view.unmount();
  });

  it("shows one or two actions as rows of the same quiet group, with no summary", () => {
    const html = renderToStaticMarkup(createElement(AgentContext.Provider, { value: DEFAULT_AGENT }, createElement(Receipts, { entries: three.slice(0, 2), state })));
    expect(FOLD_AT).toBe(3);
    expect(html).toContain('<div class="receipt-group">');
    expect(html).not.toContain("receipt-summary");
    expect(html.match(/aria-label="Undo: /g)).toHaveLength(2);
  });

  it("the summary says how many were undone, and a refused Undo opens the group so its reason shows", async () => {
    expect(groupSummary([{ text: "One", entries: [entry("x", "One", { undone: true })] }, { text: "Two", entries: [entry("y", "Two")] }, { text: "Three", entries: [entry("z", "Three")] }])).toBe(
      "3 actions · One, and 2 more · 1 undone",
    );
    const agent: AgentState = { ...DEFAULT_AGENT, blocked: { a3: "A later action depends on this one." } };
    const html = renderToStaticMarkup(createElement(AgentContext.Provider, { value: agent }, createElement(Receipts, { entries: three, state })));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("A later action depends on this one.");
  });
});

const chip = (slotKey: string, stateLabel: string): FactChip => ({ slotKey, label: slotKey, stateLabel, evidenceIds: [] });
const answer = (id: string, chips: FactChip[], text = "Here."): ChatMessage => ({ id, role: "assistant", text, createdAt: at, cards: [], chips, actions: [] });

describe("0019, P6: slot chips only for new or changed times", () => {
  it("a later answer that names the same times in the same states shows none, and a changed state shows again", () => {
    const thu = "2026-11-12T10:30";
    const fri = "2026-11-13T09:15";
    const shown = freshChips([
      answer("a1", [chip(thu, "Confirmed · office message"), chip(fri, "Offered · office message")]),
      answer("a2", [chip(thu, "Confirmed · office message"), chip(fri, "Offered · office message")]),
      answer("a3", [chip(thu, "Canceled · office message"), chip(fri, "Offered · office message")]),
      answer("a4", []),
    ]);
    expect(shown.get("a1")!.map((c) => c.slotKey)).toEqual([thu, fri]);
    expect(shown.get("a2")).toEqual([]);
    expect(shown.get("a3")!.map((c) => c.stateLabel)).toEqual(["Canceled · office message"]);
    expect(shown.get("a4")).toEqual([]);
  });

  it("the thread renders the chips of the first answer only", () => {
    const thu = "2026-11-12T10:30";
    const live = { ...state, case: { ...state.case, slots: [{ key: thu, label: "Thursday 11/12 10:30 AM", stateLabel: "Confirmed · office message" }] } } as unknown as AppState;
    const html = renderChat({ status: "ready", chatVersion: 2, messages: [answer("a1", [chip(thu, "Confirmed · office message")]), answer("a2", [chip(thu, "Confirmed · office message")])], pending: null }, { state: live });
    expect(html.match(/class="chip fact-chip"/g)).toHaveLength(1);
    expect(html.match(/data-chip-message="a1"/g)).toHaveLength(1);
    expect(html).not.toContain('data-chip-message="a2"');
  });
});

function renderChat(chat: Omit<ChatState, "declinedText" | "toolsByMessage">, extra: Partial<ChatViewProps> = {}) {
  const view = createElement(ChatView, {
    state,
    run: async () => {},
    chat: { declinedText: {}, toolsByMessage: {}, ...chat },
    streaming: false,
    scripted: false,
    send: async () => {},
    onShowSlot: () => {},
    onLoadCalendar: async () => {},
    onLoadDemo: async () => null,
    fixtures: [],
    ...extra,
  });
  return renderToStaticMarkup(createElement(AgentContext.Provider, { value: DEFAULT_AGENT }, view)).replaceAll("&#x27;", "'");
}

const ruleOf = (selector: string) => {
  const i = css.indexOf(`\n${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
};

describe("0019, P8: the follow-up chips never sit over the transcript", () => {
  const slots = { ...state, case: { ...state.case, slots: [{ key: "2026-11-12T10:30", label: "Thursday 11/12 10:30 AM", stateLabel: "Confirmed · office message" }] } } as unknown as AppState;
  const chat = { status: "ready" as const, chatVersion: 1, messages: [answer("a1", [])], pending: null };

  it("the row is part of the composer's area, outside the scrolling thread, and keeps its place while empty", () => {
    const html = renderChat(chat, { state: slots });
    const thread = html.slice(html.indexOf('<div class="thread"'), html.indexOf('<div class="composer-wrap">'));
    const composer = html.slice(html.indexOf('<div class="composer-wrap">'));
    expect(thread).not.toContain("followups");
    expect(thread).not.toContain("What is confirmed?");
    expect(composer).toContain('<div class="followups"><div class="chips followup-chips" role="group" aria-label="Suggestions">');
    expect(composer).toContain(">What is confirmed?</button>");
    // While a turn streams the row stays, empty, so the composer does not move.
    const busy = renderChat(chat, { state: slots, streaming: true });
    expect(busy).toContain('<div class="followups"></div>');
  });

  it("the composer's area has a solid ground, its fade takes no clicks, and nothing in it is positioned over the thread", () => {
    expect(ruleOf(".composer-wrap")).toMatch(/background: var\(--bg\)/);
    expect(ruleOf(".composer-wrap::before")).toMatch(/pointer-events: none/);
    expect(ruleOf(".followups")).toMatch(/min-height: var\(--touch\)/);
    for (const sel of [".followups", ".followup-chips", ".new-pill"]) expect(ruleOf(sel)).not.toMatch(/position: (absolute|fixed)/);
  });
});

describe("0019, P18: every view loads on demand and opens from each caller", () => {
  it("each sidebar and account item, each opener and each toast link names a view the page chunk renders", async () => {
    const opened: View[] = [];
    const openers = openersFor((v) => opened.push(v));
    openers.openConnections();
    openers.openUsage();
    const callers = new Set<View>([...SIDEBAR.flatMap((i) => (i.view && i.view !== "case" ? [i.view] : [])), ...opened, "connections", "usage"]);
    const { default: PageView } = await import("./shell/PageView.tsx");
    for (const view of callers) {
      const html = renderToStaticMarkup(
        createElement(AgentContext.Provider, { value: DEFAULT_AGENT }, createElement(PageView, { view: view as Exclude<View, "case">, state: { ...state, modelClient: "none", caseVersion: 0, erasePending: false } as unknown as AppState, run: async () => {}, onBack: () => {}, onActivity: () => {}, caseDeleted: false, onCaseDeleted: () => {} })),
      );
      expect(html, view).toContain("Back to your case");
      expect(VIEW_TITLES[view]).toBeTruthy();
    }
    expect([...callers].sort()).toEqual(["access", "connections", "settings", "usage"]);
  });

  it("the shell opens every page through the one lazy import, and warms it when idle", () => {
    const app = read("./App.tsx");
    expect(app).toMatch(/const pages = onDemand\(\(\) => import\("\.\/shell\/PageView\.tsx"\)\);/);
    expect(app).toMatch(/export const loadPages = pages\.ensure;/);
    expect(app).toMatch(/const PageView = pages\.part\(/);
    // Round 2, finding 1: no bare lazy() is left, so every part has its boundary.
    for (const file of ["./App.tsx", "./chat/ChatView.tsx", "./case/lazyCards.tsx", "./schedule/lazyPanel.tsx"]) expect(read(file), file).not.toMatch(/\blazy\(/);
    expect(app).toMatch(/<PageView\s+view=\{view\}/);
    expect(app).toMatch(/Promise\.all\(\[loadPages\(\), loadCaseCards\(\), loadPanel\(\)\]\)/);
    // No page module is imported statically by the first-load code.
    for (const file of ["./App.tsx", "./shell/AccountMenu.tsx", "./shell/Sidebar.tsx", "./chat/ChatView.tsx", "./agent/ModelPicker.tsx"]) {
      expect(read(file), file).not.toMatch(/from "\.\.?\/(pages\/Settings|shell\/Pages|hosted\/SignIn|chat\/ImportSheet|schedule\/SchedulePanel|case\/(ReplyCard|ConflictCards|OwnReportCard|ClaimsCard))\.tsx"/);
    }
  });
});

describe("0019, P17: the fixtures load on demand", () => {
  it("loads once, gives each message once, and tries again after a failure", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([{ messages: [{ id: "m1" }, { id: "m2" }] }, { messages: [{ id: "m1" }] }]);
    const got: unknown[] = [];
    const ensure = createFixturesLoader(read, (l) => got.push(l));
    expect(await ensure()).toEqual([]);
    const list = await ensure();
    expect(list.map((m) => m.id)).toEqual(["m1", "m2"]);
    await ensure();
    expect(read).toHaveBeenCalledTimes(2);
    expect(got).toHaveLength(1);
  });

  it("the shell asks for them only from the demo, the import sheet, or once the demo is in the case", () => {
    const app = read("./App.tsx");
    expect(app).not.toMatch(/useEffect\(\(\) => \{\s*void api\.fixtures\(\)/);
    expect(app).toMatch(/if \(demoStarted\) void ensureFixtures\(\);/);
    expect(app).toMatch(/const list = await ensureFixtures\(\);/);
    expect(read("./chat/ChatView.tsx")).toMatch(/Promise\.all\(\[loadFixturesRef\.current\?\.\(\), loadImportSheet\(\)\]\)/);
  });

  it("opening the import sheet from the attach menu loads them first", async () => {
    const loadFixtures = vi.fn(async () => []);
    const view = await mount(
      createElement(AgentContext.Provider, {
        value: DEFAULT_AGENT,
        children: createElement(ChatView, {
          state,
          run: async () => {},
          chat: { status: "ready", chatVersion: 0, messages: [], pending: null, declinedText: {}, toolsByMessage: {} },
          streaming: false,
          scripted: false,
          send: async () => {},
          onShowSlot: () => {},
          onLoadCalendar: async () => {},
          onLoadDemo: async () => null,
          fixtures: [],
          loadFixtures,
        }),
      }),
    );
    expect(loadFixtures).not.toHaveBeenCalled();
    await view.click(view.button("Attach a calendar file or an office message"));
    await view.click(view.button("Add an office message"));
    expect(loadFixtures).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});

// The stylesheet's token block: the font faces and the first :root rule.
const tokenEnd = css.indexOf(':root[data-theme="light"]');
const rules = css.slice(tokenEnd);

describe("0019, P2: every color, space and radius comes from a token", () => {
  it("no raw color outside the token block", () => {
    expect(tokenEnd).toBeGreaterThan(0);
    const raw = rules.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\blight-dark\(|\boklch\(/g) ?? [];
    expect(raw).toEqual([]);
    // Named colors only as a mask's alpha, never as a color.
    const named = rules
      .split(";")
      .filter((d) => !/mask-image/.test(d))
      .join(";")
      .match(/:\s*[^;{}]*\b(white|black|red|green|blue|gray|grey)\b/g);
    expect(named).toBeNull();
  });

  it("no raw spacing or radius past a 2 px hairline outside the token block", () => {
    const decls = rules.match(/\b(padding|margin|gap|row-gap|column-gap|border(-[a-z]+)*-radius)(-[a-z]+)*: [^;}]*/g) ?? [];
    const raw = decls.filter((d) => /(^|[\s(,-])([3-9]|\d{2,})px\b/.test(d.replace(/^[a-z-]+: /, "")));
    expect(raw).toEqual([]);
  });

  it("the type is Inter, self-hosted under 50 KB with its license, preloaded, with a metric-matched fallback", () => {
    expect(css).toMatch(/font-family: "Inter";\s*src: url\("\.\/fonts\/inter-latin\.woff2"\) format\("woff2"\);/);
    expect(css).toMatch(/font-display: swap;/);
    expect(css).toMatch(/font-family: "Inter Fallback";[^}]*size-adjust: [\d.]+%;/);
    expect(css).toMatch(/--font: "Inter", "Inter Fallback"/);
    const font = readFileSync(new URL("./fonts/inter-latin.woff2", import.meta.url));
    expect(font.length).toBeLessThan(50 * 1024);
    expect(font.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(read("./fonts/OFL.txt")).toContain("SIL Open Font License");
    expect(read("./index.html")).toMatch(/<link rel="preload" href="\.\/fonts\/inter-latin\.woff2" as="font" type="font\/woff2" crossorigin \/>/);
  });
});

describe("0019, P14: motion", () => {
  it("three durations and one easing are tokens", () => {
    expect(css).toMatch(/--dur-1: 120ms;/);
    expect(css).toMatch(/--dur-2: 180ms;/);
    expect(css).toMatch(/--dur-3: 260ms;/);
    expect(css.match(/--ease: cubic-bezier\(/g)).toHaveLength(1);
  });

  it("every animation moves only transform and opacity, and no transition touches layout", () => {
    for (const [, name, body] of css.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?\})\s*\}/g)) {
      const props = [...body!.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      expect(props.every((p) => p === "transform" || p === "opacity"), `${name}: ${props.join(", ")}`).toBe(true);
    }
    const transitions = css.match(/transition: [^;]*/g) ?? [];
    for (const t of transitions) expect(t, t).not.toMatch(/\b(width|height|inline-size|block-size|top|left|right|bottom|margin|padding|border-radius|grid-template|inset)\b/);
  });

  it("all motion is off under prefers-reduced-motion", () => {
    const i = css.indexOf("@media (prefers-reduced-motion: reduce) {");
    expect(i).toBeGreaterThan(-1);
    const block = css.slice(i, css.indexOf("\n}", i));
    expect(block).toMatch(/\*, \*::before, \*::after \{/);
    expect(block).toMatch(/animation-duration: 0\.01ms !important/);
    expect(block).toMatch(/transition-duration: 0\.01ms !important/);
    expect(block).toMatch(/scroll-behavior: auto !important/);
    expect(block).toMatch(/\.skeleton-line::after, \.skeleton-block::after[^}]*animation: none !important/);
  });
});

describe("round 2, finding 1: a chunk that fails to load", () => {
  it("shows the failure and Try again in the part's own space, and Try again loads it anew", async () => {
    let calls = 0;
    const Hello = ({ who }: { who: string }) => createElement("p", { className: "hello" }, `Hello ${who}`);
    const chunk = onDemand(async () => {
      calls++;
      if (calls === 1) throw new Error("Failed to fetch dynamically imported module");
      return { Hello };
    });
    const Part = chunk.part((m) => m.Hello, "Hello", createElement("span", { className: "waiting" }, "…"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await mount(createElement("div", { className: "shell" }, createElement("h1", null, "The shell"), createElement(Part, { who: "Dana" })));
    const { act } = await import("react");
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    // The shell stays, and the part's space says what happened.
    expect(view.container.textContent).toContain("The shell");
    expect(view.find(".part-error").textContent).toContain(PART_FAILED);
    await view.click(view.button("Try again"));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(view.find(".hello").textContent).toBe("Hello Dana");
    expect(calls).toBe(2);
    expect(chunk.isLoaded()).toBe(true);
    errors.mockRestore();
    await view.unmount();
  });

  it("a later ensure after a failure loads again instead of keeping the failure", async () => {
    let calls = 0;
    const chunk = onDemand(async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return { ok: true };
    });
    await expect(chunk.ensure()).rejects.toThrow("offline");
    await expect(chunk.ensure()).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
