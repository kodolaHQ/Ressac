// The vim mode's actor (plan 50, spec §2): vim keys in the top http(s) document of a main window's web tab.
// The parent decides whether the mode applies to a document (the setting, a main window, a WebAiOs tab) and tells the
// child: when the child asks (a new document, a page back from the bfcache) and when the setting changes.
// The child listens on its chrome event handler, in front of every page listener (the design actor's guard): a key it
// takes never reaches the page. Packaged: a change here needs build:ui.

const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/** How long a `g` or `y` waits for its second letter. */
const PREFIX_MS = 1000;
/** One line of j / k / h / l, in CSS pixels (Vimium's). */
const LINE = 60;
/** The letters of the link hints: the home row. */
const HINT_KEYS = "asdfghjkl";
/** The labels' fade out, in ms (none under reduced motion). */
const FADE_MS = 150;
// The labels, in a closed shadow root in the page: `:host` important declarations win over the page's. Glass, Geist
// Mono and the space's aura accent (DESIGN.md), on the window's own tokens (the parent sends them: see "vim:style").
const HINTS_CSS = `
:host { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important; }
.hints { transition: opacity ${FADE_MS}ms ease-out; }
.hint { position: absolute; padding: 1px 4px; border-radius: 6px; border: 1px solid var(--border); background: color-mix(in srgb, var(--sheet) 86%, transparent);
  backdrop-filter: blur(12px) saturate(1.4); color: var(--accent);
  font: 500 11px/1.4 "Geist Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .02em; white-space: nowrap;
  transition: opacity ${FADE_MS}ms ease-out;
  animation: in 460ms linear(0, .06 2.4%, .24 5.1%, .55 9.4%, .84 14.6%, 1.01 19.4%, 1.07 23.2%, 1.08 26.6%, 1.05 32.8%, 1 41%, .99 50%, 1); }
.hint b { font-weight: 500; opacity: .45; }
.gone, .out { opacity: 0; }
@keyframes in { from { opacity: 0; transform: scale(.85); } }
@media (prefers-reduced-motion: reduce) { .hints, .hint { transition: none; animation: none; } }
`;

/** The window's tokens the labels paint with. */
const HINT_TOKENS = ["--accent", "--sheet", "--border"];

/** `n` labels over HINT_KEYS, breadth-first: as short as possible, and none is the start of another. */
function hintLabels(n: number): string[] {
  const labels = [""];
  let next = 0;
  while (labels.length - next < n || next === 0) {
    const stem = labels[next++]!;
    for (const c of HINT_KEYS) labels.push(stem + c);
  }
  return labels.slice(next, next + n);
}

/**
 * A web process is untrusted: the parent reads only the message's name. What it acts on (the tab, its window) comes from
 * its own browsing context, and only while the mode is on there; the worst a compromised page can do is what vim keys do
 * to its own tab.
 */
export class WebAiOsVimParent extends JSWindowActorParent {
  /** The main window's controller and this document's WebAiOs tab, when the mode applies here. */
  private target(): { controller: any; tabId: string; browser: any } | null {
    const browser = this.browsingContext?.top?.embedderElement;
    const win = browser?.ownerDocument?.defaultView;
    // Only main windows have a controller: site app, agent app and popup windows are left alone (v1).
    const controller = win?.webaiosWindow;
    const tabId = win?.gBrowser?.getTabForBrowser(browser)?.getAttribute("webaios-tab-id");
    return controller?.store.state.settings.vimMode && tabId ? { controller, tabId, browser } : null;
  }

  /** Sends the child its mode (the setting changed). */
  tell(): void {
    this.sendAsyncMessage("vim:mode", { on: !!this.target() });
  }

  receiveMessage(m: { name: string; data?: unknown }): boolean | null {
    const t = this.target();
    if (m.name === "vim:state") return !!t;
    if (!t) return null;
    // The same calls as ⌘[ / ⌘] / ⌘R and ⌘W (controller.ts), so the store stays in step.
    if (m.name === "vim:back") t.controller.command(t.tabId, "back");
    else if (m.name === "vim:forward") t.controller.command(t.tabId, "forward");
    else if (m.name === "vim:reload") t.controller.command(t.tabId, "reload");
    else if (m.name === "vim:closeTab") void t.controller.closeTab(t.tabId);
    else if (m.name === "vim:copyUrl") Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(t.browser.currentURI.spec);
    else if (m.name === "vim:reopen") t.controller.shortcut({ type: "reopen" });
    else if (m.name === "vim:command") t.controller.shortcut({ type: "shortcut", r: "command" });
    else if (m.name === "vim:address") t.controller.shortcut({ type: "shortcut", r: "address" });
    else if (m.name === "vim:tab") {
      // The window's own ⌘1 / ⌘9 for the ends; the sidebar's neighbour for next / previous.
      const to = (m.data as { to?: unknown } | undefined)?.to;
      if (to === "first" || to === "last") t.controller.shortcut({ type: "nth", n: to === "first" ? 1 : 9 });
      else if (to === "next" || to === "previous") t.controller.shortcut({ type: "neighbour", delta: to === "next" ? 1 : -1 });
    } else if (m.name === "vim:space") {
      const delta = (m.data as { delta?: unknown } | undefined)?.delta;
      if (delta === 1 || delta === -1) t.controller.shortcut({ type: "nextSpace", delta });
    } else if (m.name === "vim:find") {
      const g = t.browser.ownerDocument.defaultView.gBrowser;
      void g.getFindBar(g.getTabForBrowser(t.browser)).then((bar: any) => bar.onFindCommand());
    } else if (m.name === "vim:openTab") {
      // F: the page names the link; only an http(s) address opens, in the background, in this tab's space.
      const url = (m as { data?: { url?: unknown } }).data?.url;
      const space = t.controller.store.state.tabs[t.tabId]?.spaceId;
      if (typeof url === "string" && /^https?:\/\//i.test(url) && space)
        t.controller.store.dispatch({ type: "openTab", windowId: t.controller.windowId, url, spaceId: space, after: t.tabId, activate: false });
    } else if (m.name === "vim:style") {
      // The window's tokens (window.css), in its theme; the displayed tab's space is the active one, whose aura's accent
      // the controller sets on the root.
      const style = t.browser.ownerDocument.defaultView.getComputedStyle(t.browser.ownerDocument.documentElement);
      return Object.fromEntries(HINT_TOKENS.map((k) => [k, style.getPropertyValue(k)])) as any;
    }
    return null;
  }
}

/** The focus is somewhere typing goes: a field, a contenteditable (or inside one), a designMode document. */
function editable(t: EventTarget | undefined): boolean {
  const el = t as HTMLElement | undefined;
  if (!el || el.nodeType !== 1) return false;
  return el.localName === "input" || el.localName === "textarea" || el.localName === "select" || el.isContentEditable;
}

/** The keys that ask the parent for something: [message, data]. */
const ONE_KEYS: Record<string, [string, unknown?]> = {
  H: ["vim:back"],
  L: ["vim:forward"],
  r: ["vim:reload"],
  x: ["vim:closeTab"],
  X: ["vim:reopen"],
  J: ["vim:tab", { to: "previous" }],
  K: ["vim:tab", { to: "next" }],
  t: ["vim:command"],
  o: ["vim:address"],
};
/** The same after a `g` (gg scrolls, in the child). */
const G_KEYS: Record<string, [string, unknown]> = {
  t: ["vim:tab", { to: "next" }],
  T: ["vim:tab", { to: "previous" }],
  "0": ["vim:tab", { to: "first" }],
  $: ["vim:tab", { to: "last" }],
  s: ["vim:space", { delta: 1 }],
  S: ["vim:space", { delta: -1 }],
};

/** What the child hears on the tab's chrome event handler, in the capture phase. */
const EVENTS = ["keydown", "keypress", "keyup", "mousedown", "mouseover", "scroll", "pagehide"];

export class WebAiOsVimChild extends JSWindowActorChild {
  private on = false;
  private prefix = "";
  private prefixTimer: unknown;
  /** The codes of keys taken on keydown: their keyup is taken too. */
  private taken = new Set<string>();
  private listening: { target: any; listener: (e: Event) => void } | null = null;
  /** The link hints shown: their host in the page, each label's link, what was typed, F or f. */
  private hints: { host: HTMLElement; box: HTMLElement; items: { label: string; link: HTMLAnchorElement; el: HTMLElement }[]; typed: string; newTab: boolean } | null = null;
  /** The last element clicked or hovered: j/k scroll its scrolling box when the window cannot move (Vimium's). */
  private pointed: Element | null = null;

  // DOMWindowCreated: a new document; pageshow: one back from the bfcache may have missed a change of the setting.
  handleEvent(e: Event): void {
    if (e.target !== this.document || !e.isTrusted) return;
    if (!this.listening) {
      // The chrome event handler is the tab's: every document of the tab hears these keys (see `mine`).
      const target = this.docShell.chromeEventHandler;
      const listener = (e: Event) => this.event(e);
      for (const type of EVENTS) target.addEventListener(type, listener, true);
      this.listening = { target, listener };
    }
    this.sendQuery("vim:state").then(
      (on) => (this.on = on === true),
      () => {},
    );
  }

  receiveMessage(m: { name: string; data?: { on?: unknown } }): void {
    if (m.name === "vim:mode") this.on = m.data?.on === true;
  }

  didDestroy(): void {
    clearTimeout(this.prefixTimer);
    this.hideHints(true);
    if (!this.listening) return;
    for (const type of EVENTS) this.listening.target.removeEventListener(type, this.listening.listener, true);
    this.listening = null;
  }

  private event(e: Event): void {
    if (e.type.startsWith("key")) return this.key(e as KeyboardEvent);
    if (!this.on || !e.isTrusted) return;
    if (e.type === "scroll" || e.type === "pagehide") return this.hideHints(e.type === "pagehide");
    const target = e.composedPath()[0] as Element | undefined;
    try {
      if (target?.nodeType === 1 && target.ownerDocument === this.document) this.pointed = target;
    } catch {
      // A page left in the bfcache: its actor no longer has a document.
    }
  }

  private key(e: KeyboardEvent): void {
    if (!e.isTrusted) return;
    if (e.type !== "keydown") {
      // The keypress (if any) and keyup of a taken key are taken too.
      if (this.taken.has(e.code)) {
        if (e.type === "keyup") this.taken.delete(e.code);
        this.swallow(e);
      }
      return;
    }
    if (!this.on || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const target = e.composedPath()[0];
    // The tab's chrome event handler hears every document of the tab: a frame's keys, or a page left in the bfcache's
    // actor, are not this one's.
    let doc: Document | null = null;
    try {
      doc = this.document;
    } catch {
      return;
    }
    if (((target as Node | undefined)?.ownerDocument ?? target) !== doc || editable(target)) return;
    if (this.run(e.key, e.repeat)) {
      this.taken.add(e.code);
      this.swallow(e);
    }
  }

  private swallow(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** Runs vim key `key`; false: not a vim key, the page gets it. */
  private run(key: string, repeat: boolean): boolean {
    if (this.hints) return this.hintKey(key);
    const prefix = this.prefix;
    this.setPrefix("");
    if (prefix === "y" && key === "y") {
      this.sendAsyncMessage("vim:copyUrl");
      return true;
    }
    if (prefix === "g" && key === "g") {
      this.scrollTo(false);
      return true;
    }
    if (prefix === "g" && Object.hasOwn(G_KEYS, key)) {
      if (!repeat) this.sendAsyncMessage(...G_KEYS[key]!);
      return true;
    }
    if (key === "Escape") return !!prefix;
    switch (key) {
      case "j":
        return this.scroll(0, LINE);
      case "k":
        return this.scroll(0, -LINE);
      case "l":
        return this.scroll(LINE, 0);
      case "h":
        return this.scroll(-LINE, 0);
      case "d":
        return this.scroll(0, 1, true);
      case "u":
        return this.scroll(0, -1, true);
      case "G":
        this.scrollTo(true);
        return true;
      case "f":
      case "F":
        if (!repeat) this.showHints(key === "F");
        return true;
      case "/":
        if (!repeat) this.sendAsyncMessage("vim:find");
        return true;
      case "g":
      case "y":
        if (!repeat) this.setPrefix(key);
        return true;
    }
    const message = Object.hasOwn(ONE_KEYS, key) ? ONE_KEYS[key] : undefined;
    if (!message) return false;
    // A held key repeats: one tab closed, one step back, not ten.
    if (!repeat) this.sendAsyncMessage(message[0], message[1]);
    return true;
  }

  private setPrefix(key: string): void {
    clearTimeout(this.prefixTimer);
    this.prefix = key;
    if (key) this.prefixTimer = setTimeout(() => (this.prefix = ""), PREFIX_MS);
  }

  private behavior(): ScrollBehavior {
    return this.contentWindow.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
  }

  /**
   * What a scroll by (dx, dy) moves, as Vimium chooses: the window when it can move that way; else the scrolling box
   * around the last element clicked or hovered; else the largest visible scrolling box (a web app's main column).
   */
  private scroller(dx: number, dy: number): Window | Element {
    // scrollMaxX / scrollMaxY: Gecko's own, how far the window can scroll.
    const win = this.contentWindow as Window & { scrollMaxX: number; scrollMaxY: number };
    if (movable(win.scrollX, win.scrollMaxX, dx) || movable(win.scrollY, win.scrollMaxY, dy)) return win;
    for (let el: Element | null = this.pointed?.isConnected ? this.pointed : null; el; el = el.parentElement ?? ((el.parentNode as ShadowRoot | null)?.host ?? null))
      if (scrollable(el, dx, dy)) return el;
    let best: Element = win as unknown as Element;
    let area = 0;
    for (const el of this.document.querySelectorAll("*")) {
      if (!scrollable(el, dx, dy)) continue;
      const r = el.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
      if (a > area) [best, area] = [el, a];
    }
    return best;
  }

  /** Scrolls by (dx, dy), or by half the box's height in dy's direction when `half` (d / u). */
  private scroll(dx: number, dy: number, half = false): true {
    const t = this.scroller(dx, dy);
    const top = half ? (dy * ("innerHeight" in t ? t.innerHeight : t.clientHeight)) / 2 : dy;
    t.scrollBy({ left: dx, top, behavior: this.behavior() });
    return true;
  }

  /** G (bottom) or gg (top). */
  private scrollTo(bottom: boolean): void {
    const t = this.scroller(0, bottom ? 1 : -1);
    const height = "innerHeight" in t ? (this.document.scrollingElement ?? this.document.documentElement).scrollHeight : t.scrollHeight;
    t.scrollTo({ top: bottom ? height : 0, behavior: this.behavior() });
  }

  /** f / F: a label on each link in view; none, and nothing happens. */
  private showHints(newTab: boolean): void {
    const doc = this.document;
    const win = this.contentWindow;
    // shortcut: a link clipped by a scrolling box or covered by another element still gets a label; add an elementFromPoint test if that misleads.
    const links = [...doc.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .filter((a) => a.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      .map((link) => ({ link, rect: [...link.getClientRects()].find((r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < win.innerWidth && r.top < win.innerHeight) }))
      .filter((x) => x.rect);
    if (!links.length) return;
    const host = doc.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    // A constructed sheet: the page's CSP (style-src) blocks a <style> element, even the actor's.
    const sheet = new (win as unknown as typeof globalThis).CSSStyleSheet();
    sheet.replaceSync(HINTS_CSS);
    root.adoptedStyleSheets = [sheet];
    const box = doc.createElement("div");
    box.className = "hints";
    root.append(box);
    const items = hintLabels(links.length).map((label, i) => {
      const { link, rect } = links[i]!;
      const el = doc.createElement("span");
      el.className = "hint";
      el.style.left = `${Math.max(0, rect!.left)}px`;
      el.style.top = `${Math.max(0, rect!.top)}px`;
      el.textContent = label;
      box.append(el);
      return { label, link, el };
    });
    this.hints = { host, box, items, typed: "", newTab };
    // Shown once the window's tokens are there (no flash of unstyled labels); letters typed meanwhile already count.
    this.sendQuery("vim:style").then(
      (tokens) => {
        if (this.hints?.host !== host) return;
        for (const [k, v] of Object.entries((tokens ?? {}) as Record<string, string>)) if (HINT_TOKENS.includes(k)) box.style.setProperty(k, v);
        doc.documentElement.append(host);
      },
      () => {},
    );
  }

  /** A key while the labels show: a letter narrows them (a whole label follows its link), Backspace undoes one, Escape quits. */
  private hintKey(key: string): boolean {
    const h = this.hints!;
    if (key === "Shift") return false;
    if (key === "Escape") {
      this.hideHints();
      return true;
    }
    const typed = key === "Backspace" ? h.typed.slice(0, -1) : h.typed + key.toLowerCase();
    if (key !== "Backspace" && (key.length !== 1 || !HINT_KEYS.includes(key.toLowerCase()))) {
      // Any other key quits the labels and does its own job.
      this.hideHints();
      return this.run(key, false);
    }
    const hit = h.items.find((i) => i.label === typed);
    if (hit) {
      this.hideHints();
      if (!h.newTab) hit.link.click();
      else this.sendAsyncMessage("vim:openTab", { url: hit.link.href });
      return true;
    }
    // A letter no label continues is ignored.
    if (!h.items.some((i) => i.label.startsWith(typed))) return true;
    h.typed = typed;
    for (const i of h.items) {
      const on = i.label.startsWith(typed);
      i.el.classList.toggle("gone", !on);
      if (!on) continue;
      // The typed letters, dimmed.
      const b = this.document.createElement("b");
      b.textContent = typed;
      i.el.replaceChildren(b, i.label.slice(typed.length));
    }
    return true;
  }

  /** Removes the labels: a fade out, or at once (`now`, or reduced motion). */
  private hideHints(now = false): void {
    const h = this.hints;
    if (!h) return;
    this.hints = null;
    if (now || this.behavior() === "instant") return void h.host.remove();
    h.box.classList.add("out");
    setTimeout(() => h.host.remove(), FADE_MS);
  }
}

/** A position in [0, max] can move by d's sign. */
function movable(position: number, max: number, d: number): boolean {
  return d > 0 ? position < max - 0.5 : d < 0 ? position > 0.5 : false;
}

/** `el` is a scrolling box that can move by (dx, dy)'s sign. */
function scrollable(el: Element, dx: number, dy: number): boolean {
  const y = dy !== 0 && el.scrollHeight > el.clientHeight && movable(el.scrollTop, el.scrollHeight - el.clientHeight, dy);
  const x = dx !== 0 && el.scrollWidth > el.clientWidth && movable(el.scrollLeft, el.scrollWidth - el.clientWidth, dx);
  if (!x && !y) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
  const open = (o: string | undefined) => o === "auto" || o === "scroll" || o === "overlay";
  return (y && open(style?.overflowY)) || (x && open(style?.overflowX));
}
