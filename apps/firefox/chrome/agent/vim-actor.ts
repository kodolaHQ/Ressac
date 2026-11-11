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

  receiveMessage(m: { name: string }): boolean | null {
    const t = this.target();
    if (m.name === "vim:state") return !!t;
    if (!t) return null;
    // The same calls as ⌘[ / ⌘] / ⌘R and ⌘W (controller.ts), so the store stays in step.
    if (m.name === "vim:back") t.controller.command(t.tabId, "back");
    else if (m.name === "vim:forward") t.controller.command(t.tabId, "forward");
    else if (m.name === "vim:reload") t.controller.command(t.tabId, "reload");
    else if (m.name === "vim:closeTab") void t.controller.closeTab(t.tabId);
    else if (m.name === "vim:copyUrl") Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(t.browser.currentURI.spec);
    return null;
  }
}

/** The focus is somewhere typing goes: a field, a contenteditable (or inside one), a designMode document. */
function editable(t: EventTarget | undefined): boolean {
  const el = t as HTMLElement | undefined;
  if (!el || el.nodeType !== 1) return false;
  return el.localName === "input" || el.localName === "textarea" || el.localName === "select" || el.isContentEditable;
}

export class WebAiOsVimChild extends JSWindowActorChild {
  private on = false;
  private prefix = "";
  private prefixTimer: unknown;
  /** The codes of keys taken on keydown: their keyup is taken too. */
  private taken = new Set<string>();
  private listening: { target: any; listener: (e: KeyboardEvent) => void } | null = null;

  // DOMWindowCreated: a new document; pageshow: one back from the bfcache may have missed a change of the setting.
  handleEvent(e: Event): void {
    if (e.target !== this.document || !e.isTrusted) return;
    if (!this.listening) {
      // The chrome event handler is the tab's: every document of the tab hears these keys (see `mine`).
      const target = this.docShell.chromeEventHandler;
      const listener = (k: KeyboardEvent) => this.key(k);
      for (const type of ["keydown", "keypress", "keyup"]) target.addEventListener(type, listener, true);
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
    if (!this.listening) return;
    for (const type of ["keydown", "keypress", "keyup"]) this.listening.target.removeEventListener(type, this.listening.listener, true);
    this.listening = null;
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
    const prefix = this.prefix;
    this.setPrefix("");
    if (prefix && key === prefix) {
      if (key === "g") this.scrollTo(0);
      else this.sendAsyncMessage("vim:copyUrl");
      return true;
    }
    if (key === "Escape") return !!prefix;
    const win = this.contentWindow;
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
        return this.scroll(0, win.innerHeight / 2);
      case "u":
        return this.scroll(0, -win.innerHeight / 2);
      case "G":
        this.scrollTo((this.document.scrollingElement ?? this.document.documentElement).scrollHeight);
        return true;
      case "g":
      case "y":
        if (!repeat) this.setPrefix(key);
        return true;
    }
    const message = { H: "vim:back", L: "vim:forward", r: "vim:reload", x: "vim:closeTab" }[key];
    if (!message) return false;
    // A held key repeats: one tab closed, one step back, not ten.
    if (!repeat) this.sendAsyncMessage(message);
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

  // shortcut: scrolls the page's window only, not an inner scrolling element (some web apps); find the scrollable box if that matters.
  private scroll(left: number, top: number): true {
    this.contentWindow.scrollBy({ left, top, behavior: this.behavior() });
    return true;
  }

  private scrollTo(top: number): void {
    this.contentWindow.scrollTo({ top, behavior: this.behavior() });
  }
}
