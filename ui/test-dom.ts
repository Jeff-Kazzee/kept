// A small DOM for tests, so a component can be rendered with react-dom,
// clicked and read without a new dependency (W6). It has what react-dom
// and these components use: nodes, attributes, events that capture and
// bubble, focus, inert and hidden, and a few simple selectors. It is not
// a browser: no layout, no CSS, no default actions. Never imported by the
// app, so the bundle leaves it out.
type Listener = { fn: (e: TestEvent) => void; capture: boolean };

export class TestEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;
  target: TestNode | null = null;
  currentTarget: TestNode | null = null;
  eventPhase = 0;
  readonly timeStamp = Date.now();
  readonly isTrusted = false;
  stopped = false;
  stoppedNow = false;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
  stopImmediatePropagation() {
    this.stopped = true;
    this.stoppedNow = true;
  }
}

export class TestKeyboardEvent extends TestEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  constructor(type: string, init: { key?: string; shiftKey?: boolean; bubbles?: boolean; cancelable?: boolean } = {}) {
    super(type, init);
    this.key = init.key ?? "";
    this.shiftKey = init.shiftKey ?? false;
  }
}

export class TestCustomEvent extends TestEvent {
  readonly detail: unknown;
  constructor(type: string, init: { detail?: unknown; bubbles?: boolean } = {}) {
    super(type, init);
    this.detail = init.detail;
  }
}

export class TestNode {
  nodeType = 1;
  nodeName = "";
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  ownerDocument: TestDocument | null = null;
  #listeners = new Map<string, Listener[]>();

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): TestNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): TestNode | null {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): TestNode | null {
    const p = this.parentNode;
    return p ? (p.childNodes[p.childNodes.indexOf(this) - 1] ?? null) : null;
  }
  get parentElement(): TestElement | null {
    return this.parentNode instanceof TestElement ? this.parentNode : null;
  }
  appendChild<T extends TestNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends TestNode>(child: T, ref: TestNode | null): T {
    if (!ref) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    return child;
  }
  removeChild<T extends TestNode>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== "" && v !== null && v !== undefined) this.appendChild(this.doc().createTextNode(String(v)));
  }
  contains(n: TestNode | null): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  getRootNode(): TestNode {
    let x: TestNode = this;
    while (x.parentNode) x = x.parentNode;
    return x;
  }
  doc(): TestDocument {
    return this instanceof TestDocument ? this : this.ownerDocument!;
  }
  addEventListener(type: string, fn: (e: TestEvent) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const list = this.#listeners.get(type) ?? [];
    if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture });
    this.#listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: TestEvent) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((l) => !(l.fn === fn && l.capture === capture)));
  }
  #fire(e: TestEvent, capture: boolean) {
    for (const l of [...(this.#listeners.get(e.type) ?? [])]) {
      if (l.capture !== capture) continue;
      e.currentTarget = this;
      l.fn.call(this, e);
      if (e.stoppedNow) return;
    }
  }
  // Capture from the top, then the target, then bubble up. The path ends
  // at the window, as in a browser.
  dispatchEvent(e: TestEvent): boolean {
    e.target = this;
    const path: TestNode[] = [];
    for (let x: TestNode | null = this; x; x = x.parentNode) path.push(x);
    const win = this.doc().defaultView;
    if (path[path.length - 1] === this.doc()) path.push(win);
    for (let i = path.length - 1; i > 0 && !e.stopped; i--) {
      e.eventPhase = 1;
      path[i]!.#fire(e, true);
    }
    if (!e.stopped) {
      e.eventPhase = 2;
      this.#fire(e, true);
      if (!e.stopped) this.#fire(e, false);
    }
    for (let i = 1; i < path.length && e.bubbles && !e.stopped; i++) {
      e.eventPhase = 3;
      path[i]!.#fire(e, false);
    }
    e.currentTarget = null;
    return !e.defaultPrevented;
  }
}

export class TestText extends TestNode {
  data: string;
  constructor(data: string) {
    super();
    this.nodeType = 3;
    this.nodeName = "#text";
    this.data = data;
  }
  get nodeValue() {
    return this.data;
  }
  set nodeValue(v: string) {
    this.data = v;
  }
  override get textContent() {
    return this.data;
  }
  override set textContent(v: string) {
    this.data = v;
  }
}

const SVG = "http://www.w3.org/2000/svg";

export class TestElement extends TestNode {
  readonly localName: string;
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> & { setProperty: (k: string, v: string) => void; removeProperty: (k: string) => void };
  // Properties react-dom sets directly on form controls. type, name and
  // defaultValue reflect their attributes, as in a browser.
  #value: string | null = null;
  checked = false;
  defaultChecked = false;
  get value() {
    return this.#value ?? this.getAttribute("value") ?? "";
  }
  set value(v: string) {
    this.#value = String(v);
  }
  get defaultValue() {
    return this.getAttribute("value") ?? "";
  }
  set defaultValue(v: string) {
    this.setAttribute("value", v);
  }
  get type() {
    return this.getAttribute("type") ?? "";
  }
  set type(v: string) {
    this.setAttribute("type", v);
  }
  get name() {
    return this.getAttribute("name") ?? "";
  }
  set name(v: string) {
    this.setAttribute("name", v);
  }
  scrollTop = 0;
  scrollLeft = 0;
  readonly dataset: Record<string, string> = {};
  constructor(tag: string, ns = "http://www.w3.org/1999/xhtml") {
    super();
    this.localName = tag;
    this.namespaceURI = ns;
    this.tagName = ns === SVG ? tag : tag.toUpperCase();
    this.nodeName = this.tagName;
    const style = {} as TestElement["style"];
    Object.defineProperty(style, "setProperty", { value: (k: string, v: string) => (style[k] = v) });
    Object.defineProperty(style, "removeProperty", { value: (k: string) => delete style[k] });
    this.style = style;
  }
  setAttribute(n: string, v: unknown) {
    this.attributes.set(n.toLowerCase(), String(v));
  }
  getAttribute(n: string) {
    return this.attributes.get(n.toLowerCase()) ?? null;
  }
  removeAttribute(n: string) {
    this.attributes.delete(n.toLowerCase());
  }
  hasAttribute(n: string) {
    return this.attributes.has(n.toLowerCase());
  }
  setAttributeNS(_ns: string | null, n: string, v: unknown) {
    this.setAttribute(n, v);
  }
  removeAttributeNS(_ns: string | null, n: string) {
    this.removeAttribute(n);
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  set id(v: string) {
    this.setAttribute("id", v);
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get inert() {
    return this.hasAttribute("inert");
  }
  set inert(v: boolean) {
    if (v) this.setAttribute("inert", "");
    else this.removeAttribute("inert");
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v: boolean) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get children(): TestElement[] {
    return this.childNodes.filter((c): c is TestElement => c instanceof TestElement);
  }
  // True when nothing above it is hidden or inert, as a person sees it.
  get shown(): boolean {
    for (let x: TestNode | null = this; x; x = x.parentNode) if (x instanceof TestElement && x.hidden) return false;
    return true;
  }
  get isInert(): boolean {
    for (let x: TestNode | null = this; x; x = x.parentNode) if (x instanceof TestElement && x.inert) return true;
    return false;
  }
  // What a keyboard can reach: buttons, links, form fields and anything
  // with a tabindex of 0 or more, shown, not disabled and not inert.
  get tabbable(): boolean {
    const t = this.getAttribute("tabindex");
    const native = ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName) || (this.tagName === "A" && this.hasAttribute("href")) || this.tagName === "SUMMARY";
    return (native ? t === null || Number(t) >= 0 : t !== null && Number(t) >= 0) && !this.disabled && this.shown && !this.isInert;
  }
  focus() {
    const t = this.getAttribute("tabindex");
    const focusable = this.tabbable || (t !== null && this.shown && !this.isInert);
    if (!focusable) return;
    const doc = this.doc();
    const prev = doc.activeElement;
    if (prev === this) return;
    doc.activeElement = this;
    prev?.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
    this.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
  }
  blur() {
    const doc = this.doc();
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
  }
  click() {
    // A browser can't click what it doesn't show.
    if (this.disabled || this.isInert || !this.shown) return;
    // A radio or a checkbox changes before the click, as in a browser.
    if (this.tagName === "INPUT" && (this.type === "radio" || this.type === "checkbox")) {
      const before = this.checked;
      this.checked = this.type === "radio" ? true : !before;
      const ok = this.dispatchEvent(new TestEvent("click", { bubbles: true, cancelable: true }));
      if (!ok) this.checked = before;
      return;
    }
    this.dispatchEvent(new TestEvent("click", { bubbles: true, cancelable: true }));
  }
  matches(selector: string): boolean {
    return selector.split(",").some((s) => matchCompound(this, s.trim()));
  }
  closest(selector: string): TestElement | null {
    for (let x: TestNode | null = this; x; x = x.parentNode) if (x instanceof TestElement && x.matches(selector)) return x;
    return null;
  }
  querySelectorAll(selector: string): TestElement[] {
    return descendants(this).filter((el) => matchSelector(el, selector, this));
  }
  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  scrollIntoView() {}
}

export class TestDocument extends TestNode {
  activeElement: TestElement | null = null;
  readonly documentElement: TestElement;
  readonly head: TestElement;
  readonly body: TestElement;
  defaultView: TestNode = new TestNode();
  constructor() {
    super();
    this.nodeType = 9;
    this.nodeName = "#document";
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    const el = new TestElement(tag.toLowerCase());
    el.ownerDocument = this;
    return el;
  }
  createElementNS(ns: string, tag: string) {
    const el = new TestElement(tag, ns);
    el.ownerDocument = this;
    return el;
  }
  createTextNode(data: string) {
    const t = new TestText(data);
    t.ownerDocument = this;
    return t;
  }
  querySelectorAll(selector: string) {
    return this.documentElement.querySelectorAll(selector);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getElementById(id: string) {
    return this.querySelector(`#${id}`);
  }
}

function descendants(root: TestNode): TestElement[] {
  const out: TestElement[] = [];
  const walk = (n: TestNode) => {
    for (const c of n.childNodes) {
      if (c instanceof TestElement) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

// Selectors: a list of compounds joined by spaces (descendant), each a tag,
// #id, .class, [attr], [attr="value"], :disabled or :not(...).
function matchSelector(el: TestElement, selector: string, scope: TestNode): boolean {
  return selector.split(",").some((one) => {
    const parts = one.trim().split(/\s+(?![^[]*\])/);
    let node: TestNode | null = el;
    if (!matchCompound(el, parts[parts.length - 1]!)) return false;
    for (let i = parts.length - 2; i >= 0; i--) {
      node = node!.parentNode;
      while (node && node !== scope && !(node instanceof TestElement && matchCompound(node, parts[i]!))) node = node.parentNode;
      if (!node || node === scope) return false;
    }
    return true;
  });
}

function matchCompound(el: TestElement, compound: string): boolean {
  const re = /(:not\(([^)]*)\))|(:disabled)|(#[\w-]+)|(\.[\w-]+)|(\[([\w-]+)(?:="([^"]*)")?\])|([a-zA-Z][\w-]*)|(\*)/g;
  let rest = compound;
  for (const m of compound.matchAll(re)) {
    rest = rest.replace(m[0], "");
    if (m[1] && matchCompound(el, m[2]!)) return false;
    if (m[3] && !el.disabled) return false;
    if (m[4] && el.id !== m[4].slice(1)) return false;
    if (m[5] && !el.className.split(/\s+/).includes(m[5].slice(1))) return false;
    if (m[6] && (!el.hasAttribute(m[7]!) || (m[8] !== undefined && el.getAttribute(m[7]!) !== m[8]))) return false;
    if (m[9] && el.localName !== m[9].toLowerCase()) return false;
  }
  if (rest.trim() !== "") throw new Error(`test-dom: selector not supported: ${compound}`);
  return true;
}

// Installs a fresh document and window on globalThis. Call before
// importing react-dom/client, which checks for a DOM when it loads.
export function installTestDom(): TestDocument {
  const doc = new TestDocument();
  const win = doc.defaultView as TestNode & Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  Object.assign(win, {
    document: doc,
    event: undefined,
    HTMLIFrameElement: class {},
    navigator: { userAgent: "test-dom" },
    requestAnimationFrame: (f: (t: number) => void) => setTimeout(() => f(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    matchMedia: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  });
  win.ownerDocument = doc;
  for (const [k, v] of Object.entries({
    window: win,
    document: doc,
    Node: TestNode,
    Text: TestText,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLIFrameElement: win.HTMLIFrameElement,
    Event: TestEvent,
    KeyboardEvent: TestKeyboardEvent,
    CustomEvent: TestCustomEvent,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    matchMedia: win.matchMedia,
    getComputedStyle: win.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  return doc;
}

// Renders a React node into a new container under the body and returns
// helpers to find, click and read. Every update runs inside act.
export async function mount(node: unknown) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const doc = document as unknown as TestDocument;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(node as Parameters<typeof root.render>[0]));
  const find = (selector: string): TestElement => {
    const el = container.querySelector(selector);
    if (!el) throw new Error(`test-dom: nothing matches ${selector}`);
    return el;
  };
  // A button by its text or its aria-label.
  const button = (text: string): TestElement => {
    const el = container.querySelectorAll("button").find((b) => b.textContent.trim() === text || b.textContent.includes(text) || b.getAttribute("aria-label") === text);
    if (!el) throw new Error(`test-dom: no button ${text}`);
    return el;
  };
  return {
    container,
    find,
    button,
    async click(el: TestElement) {
      await act(async () => el.click());
    },
    async key(el: TestElement, key: string) {
      await act(async () => {
        el.dispatchEvent(new TestKeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      container.parentNode?.removeChild(container);
    },
  };
}
