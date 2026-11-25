import { cleanOrigin, type PassportEntry } from "../shims/kernel";
import { format, type Locale } from "../../shared/i18n";
import { siteOf } from "../../shared/model";
import { drafts, fieldsToProposal, valid, type Draft } from "./import-choice";
import { twinOf, type AddManyResult, type PassportSettings } from "./settings";
import type { LoadResult } from "./store";
import type { PassportSuggestApi } from "../../shared/api";
import { cutFrameNetwork } from "../window/frame-network";

export type SuggestionContext = {
  agentReached: boolean | undefined;
  privateSpace: boolean;
  https: boolean;
  siteApp: boolean;
  passportReadable: boolean;
  suggest: boolean;
  siteMuted: boolean;
  known: (d: Draft) => boolean;
};

/**
 * What a sent address form offers the passport (design § 5): only the values the user typed (`typed`, the page's
 * actor's word, which only narrows), on a tab the agent never reached, outside a private space or a site app, on an
 * https page, with the passport readable and suggestions on for this site. Values already there are left out; null
 * when nothing is left.
 */
export function suggestion(record: Record<string, string>, typed: ReadonlySet<string>, ctx: SuggestionContext): Draft[] | null {
  if (ctx.agentReached !== false || ctx.privateSpace || !ctx.https || ctx.siteApp || !ctx.passportReadable || !ctx.suggest || ctx.siteMuted) return null;
  const t = (k: string) => {
    const v = typeof record[k] === "string" ? record[k].trim() : "";
    return v && typed.has(v) ? v : "";
  };
  // Firefox reads a labels-only French form as given-name + name (« Nom ») and address-line1 (« Adresse »).
  const given = t("given-name"), full = t("name");
  const family = t("family-name") || (given && full ? (full.startsWith(given) ? full.slice(given.length).trim() : full) : "");
  const street = t("street-address") || ["address-line1", "address-line2", "address-line3"].map(t).filter(Boolean).join(" ");
  const raw = fieldsToProposal({ given, family, full, street, postcode: t("postal-code"), city: t("address-level2"), tel: t("tel"), email: t("email") });
  const all = drafts({ key: "", ...raw, ticked: true, other: false }, "me");
  // Only what the passport accepts: the bubble shows exactly what « Ajouter » writes.
  const fresh = all.filter((d) => valid(d) && !ctx.known(d));
  return fresh.length ? fresh : null;
}

/** The bubble's last word on « Ajouter »: what was added, then what was not; never a success that hides a refusal. */
export function doneText(r: AddManyResult, l: (id: string, args?: Record<string, string | number>) => string): string {
  if (!r.ok) return l("settings-passport-import-error");
  const said = [r.added + r.variants ? l("settings-passport-import-done", { n: r.added + r.variants }) : "", r.full ? l("settings-passport-import-full", { n: r.full }) : "", r.invalid ? l("settings-passport-import-invalid", { n: r.invalid }) : ""].filter(Boolean);
  return said.length ? said.join(" ") : l("settings-passport-import-nothing");
}

/** A draft as addMany would write it, for its twin lookup. */
const entryOf = (d: Draft): PassportEntry => ({ id: "", ...d, variants: [], origins: [], how: "form", created: "", updated: "" });
const shown = (d: Draft) => ("given" in d.value ? `${d.value.given} ${d.value.family}`.trim() : d.value.text.replace(/\s*\n\s*/g, ", "));
const MUTED = "ressac.passport.suggestMuted";
const PATCHED = Symbol.for("ressac.formCapture");
const XHTML = "http://www.w3.org/1999/xhtml";
/** After « Ajouter », the done text stays this long, then the bubble fades out. */
const DONE_MS = 5000;
/** The bubble's exit fade (150 ms) plays before its frame is hidden. */
const EXIT_MS = 200;

type SuggestFrame = HTMLIFrameElement & { ressacPassportSuggest?: { api: PassportSuggestApi }; ressacExit?: ReturnType<typeof setTimeout> };
/** A tab's bubble. `persist`: the navigations it still outlives. */
type Entry = { profile: string; host: string; docId: number; found: Draft[]; remember: boolean; phase: "offer" | "busy" | "done"; done?: string; failed?: boolean; persist: number; timer?: ReturnType<typeof setTimeout>; show(): void };

/**
 * Firefox's address capture goes to the passport instead (design § 9.1): FormAutofillParent's `_onAddressSubmit` is
 * replaced, once, by Ressac's bubble over the page, and always answers false: no Firefox prompt, nothing in Firefox's store (in clear).
 * Credit cards are untouched.
 */
export function installFormCapture(o: {
  /** The tab facts of a <browser>: null when it is no tab of a Ressac window. */
  about(browser: any): { profile: string; agentReached: boolean | undefined; privateSpace: boolean; siteApp: boolean } | null;
  /** What the user typed in a document (typed-actor.ts), from its WindowGlobalParent. */
  typedOf(wgp: any): Promise<string[]>;
  load(profile: string): Promise<LoadResult>;
  addMany: PassportSettings["addMany"];
  locale(): Locale;
}): void {
  let proto: any;
  try {
    proto = ChromeUtils.importESModule("resource://autofill/FormAutofillParent.sys.mjs").FormAutofillParent?.prototype;
  } catch (e) {
    console.error("[passport] Firefox's form autofill did not load:", (e as Error)?.name);
  }
  if (typeof proto?._onAddressSubmit !== "function") {
    // The pref ressac.js sets keeps Firefox from saving addresses: only Ressac's bubble is lost.
    console.error("[passport] Firefox's address capture moved: no passport suggestion");
    return;
  }
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;
  proto._onAddressSubmit = async function (this: any, address: any, browser: any) {
    try {
      await offer(this.manager, address?.record, browser);
    } catch (e) {
      console.error("[passport] form suggestion failed:", (e as Error)?.name);
    }
    return false;
  };

  /** Per <browser>, its open bubble: another section of the same send adds its new values to it. */
  const open = new WeakMap<object, Entry>();
  /** Documents (innerWindowId) whose bubble was refused or closed: never offered again. */
  const declined = new Set<number>();
  const decline = (doc: number) => {
    declined.add(doc);
    for (const k of declined) if (declined.size > 256) declined.delete(k);
  };

  async function offer(wgp: any, raw: unknown, browser: any) {
    // shortcut: a form in a frame is never offered (the site would be the frame's); upgrade if address forms in frames matter.
    if (!wgp || wgp.browsingContext?.parent || !browser || !raw || typeof raw !== "object" || declined.has(wgp.innerWindowId)) return;
    const facts = o.about(browser);
    if (!facts) return;
    const record = Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
    // The submitting document's own principal: the tab may have moved on since.
    const p = wgp.documentPrincipal;
    const origin: string | null = p?.isContentPrincipal && p.schemeIs("https") ? p.originNoSuffix : null;
    const host = origin === null ? null : cleanOrigin(origin);
    const muted = Services.prefs.getCharPref(MUTED, "").split(",").map((h: string) => h.trim());
    const typed = new Set(await o.typedOf(wgp));
    const ctx = { ...facts, https: host !== null, suggest: Services.prefs.getBoolPref("ressac.passport.suggest", true), siteMuted: !!host && muted.includes(host) };
    // The cheap gates first: no passport is read for an agent's, a private or a muted page.
    if (!suggestion(record, typed, { ...ctx, passportReadable: true, known: () => false })) return;
    const loaded = await o.load(facts.profile);
    const found = suggestion(record, typed, { ...ctx, passportReadable: loaded.state === "ok", known: (d) => !!twinOf(loaded.entries, entryOf(d)) });
    if (found && host && !declined.has(wgp.innerWindowId)) bubble(browser, found, facts.profile, host, wgp.innerWindowId);
  }

  /** Per window, the one frame that shows the selected tab's bubble (made at the first bubble of that window). */
  const frames = new WeakMap<Window, { frame: SuggestFrame; listeners: Set<() => void> }>();
  const l = (id: string, args?: Record<string, string | number>) => format(o.locale(), id, args);

  function bubble(browser: any, found: Draft[], profile: string, host: string, docId: number) {
    // One bubble per tab: a second section (billing after shipping) adds what is new to it, or is dropped.
    const cur = open.get(browser);
    if (cur) {
      if (cur.phase === "offer" && cur.profile === profile && cur.host === host) {
        cur.found.push(...found.filter((d) => !twinOf(cur.found.map(entryOf), entryOf(d))));
        cur.show();
      }
      return;
    }
    // Not ownerGlobal: undefined from the store module (see load-guard.ts tabIdOf).
    const win: Window | null | undefined = browser.ownerDocument?.defaultView;
    const w = win && frameOf(win);
    if (!w) return;
    // The send's own navigation may already be done: the bubble outlives only the one it causes (the bar's persistence 1).
    const persist = browser.browsingContext?.currentWindowGlobal?.innerWindowId === docId ? 1 : 0;
    const entry: Entry = { profile, host, docId, found: [...found], remember: false, phase: "offer", persist, show: () => changed(win) };
    open.set(browser, entry);
    changed(win);
  }

  function remove(browser: any, e: Entry) {
    clearTimeout(e.timer);
    if (open.get(browser) !== e) return;
    open.delete(browser);
    const win = browser.ownerDocument?.defaultView;
    if (!win || win.closed) return;
    // Answered from the keyboard or a click: the keyboard goes back to the page, as « Cacher pour l'agent » does.
    if (win.document.activeElement === frames.get(win)?.frame && browser === (win as any).gBrowser?.selectedBrowser) browser.focus();
    changed(win);
  }

  /** The window's frame and its listeners, made once: tab switches, closes and navigations drive every bubble of it. */
  function frameOf(win: Window): { frame: SuggestFrame; listeners: Set<() => void> } | null {
    const had = frames.get(win);
    if (had?.frame.isConnected) return had;
    const doc = win.document;
    const host = doc.getElementById("browser");
    const gb = (win as any).gBrowser;
    if (!host || !gb) return null;
    const frame = doc.createElementNS(XHTML, "iframe") as SuggestFrame;
    frame.id = "ressac-passport-suggest";
    // Out of the flow before it is appended (spike S8); the frame's document sizes it to the bubble.
    frame.style.cssText = "position: fixed; z-index: 4; border: 0; background: transparent; display: none; width: 0; height: 0";
    host.append(frame);
    const mayLoad = cutFrameNetwork(frame);
    const listeners = new Set<() => void>();
    const selectedEntry = () => open.get(gb.selectedBrowser) ?? null;
    const act = (f: (b: any, e: Entry) => void) => () => {
      const b = gb.selectedBrowser, e = open.get(b);
      if (e) f(b, e);
    };
    const api: PassportSuggestApi = {
      context() {
        const e = selectedEntry();
        if (!e) return null;
        const values = e.found.map((d) => l("chrome-passport-suggest-value", { kind: l(`settings-passport-field-${d.field}`), value: shown(d) }));
        return { values, site: siteOf(`https://${e.host}`), remember: e.remember, phase: e.phase, ...(e.done !== undefined ? { done: e.done, failed: !!e.failed } : {}), locale: o.locale() };
      },
      remember: (on) => act((_b, e) => e.phase === "offer" && ((e.remember = on), changed(win)))(),
      add: act((b, e) => {
        if (e.phase !== "offer") return;
        e.phase = "busy";
        changed(win);
        const origin = e.remember ? `https://${e.host}` : null;
        void o
          .addMany({ profile: e.profile, drafts: e.found, how: "form", from: e.host, origin, reason: l("settings-passport-touchid-import") })
          .catch((err): AddManyResult => (console.error("[passport] form add failed:", (err as Error)?.name), { ok: false, error: "write" }))
          .then((r) => {
            if (open.get(b) !== e) return;
            // Touch ID refused: back to the offer, nothing written.
            if (!r.ok && r.error === "cancelled") e.phase = "offer";
            else Object.assign(e, { phase: "done", done: doneText(r, l), failed: !r.ok, timer: setTimeout(() => remove(b, e), DONE_MS) });
            changed(win);
          });
      }),
      // « Non » or ✕: this document is never offered again (after « Ajouter » it only closes).
      no: act((b, e) => {
        if (e.phase === "busy") return;
        if (e.phase === "offer") decline(e.docId);
        remove(b, e);
      }),
      mute: (where) =>
        act((b, e) => {
          if (e.phase !== "offer") return;
          if (where === "all") Services.prefs.setBoolPref("ressac.passport.suggest", false);
          else {
            const now = Services.prefs.getCharPref(MUTED, "").split(",").filter(Boolean);
            if (!now.includes(e.host)) Services.prefs.setCharPref(MUTED, [...now, e.host].join(","));
          }
          remove(b, e);
        })(),
      onChange(cb) {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    };
    frame.ressacPassportSuggest = { api };
    if (mayLoad) frame.src = "chrome://browser/content/ressac/sidebar.html?passport-suggest";
    const made = { frame, listeners };
    frames.set(win, made);
    // Once per window: a frame made again (removed by something else) keeps these.
    if (!had) {
      gb.tabContainer.addEventListener("TabSelect", () => changed(win));
      gb.tabContainer.addEventListener("TabClose", (ev: any) => {
        const b = ev.target?.linkedBrowser, e = b && open.get(b);
        if (e) remove(b, e);
      });
      gb.addTabsProgressListener({
        onLocationChange(b: any, wp: any, _req: unknown, _loc: unknown, flags: number) {
          const e = open.get(b);
          if (!e || !wp?.isTopLevel || flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) return;
          if (e.persist-- <= 0) remove(b, e);
        },
      });
      win.addEventListener("resize", () => place(win));
    }
    return made;
  }

  /** The frame over the selected page's top right corner, or hidden after the bubble's exit fade. */
  function place(win: Window) {
    const w = frames.get(win);
    if (!w) return;
    const { frame } = w;
    clearTimeout(frame.ressacExit);
    const b = (win as any).gBrowser?.selectedBrowser;
    if (!b || !open.get(b)) {
      frame.ressacExit = setTimeout(() => {
        if (!open.get((win as any).gBrowser?.selectedBrowser)) frame.style.display = "none";
      }, EXIT_MS);
      return;
    }
    // In the page area only: the selected <browser>'s box never covers Ressac's sidebar.
    // shortcut: placed again only on a change, a tab switch or a window resize; upgrade if the sidebar's width moves under a shown bubble.
    const a = b.getBoundingClientRect();
    Object.assign(frame.style, { display: "", top: `${a.top + 12}px`, right: `${win.innerWidth - a.right + 12}px` });
  }

  function changed(win: Window) {
    place(win);
    for (const cb of frames.get(win)?.listeners ?? [])
      try {
        cb();
      } catch (e) {
        console.error("[passport] suggestion listener failed:", (e as Error)?.name);
      }
  }
}
