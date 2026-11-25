import { cleanOrigin, type PassportEntry } from "../shims/kernel";
import { format, type Locale } from "../../shared/i18n";
import { siteOf } from "../../shared/model";
import { drafts, splitName, valid, type Draft } from "./import-choice";
import { twinOf, type AddManyResult, type PassportSettings } from "./settings";
import type { LoadResult } from "./store";

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
  const named = t("given-name") || t("family-name") ? { given: t("given-name"), family: t("family-name") } : splitName(t("name"));
  // shortcut: a street split over address-line1/2 fields is not offered; upgrade by joining them if such forms matter.
  const street = t("street-address"), rest = [t("postal-code"), t("address-level2")].filter(Boolean).join(" ");
  const all = drafts({ key: "", ...named, address: street && rest ? `${street}\n${rest}` : "", tel: t("tel"), email: t("email"), ticked: true, other: false }, "me");
  // Only what the passport accepts: the bar shows exactly what « Ajouter » writes.
  const fresh = all.filter((d) => valid(d) && !ctx.known(d));
  return fresh.length ? fresh : null;
}

/** The bar's last word on « Ajouter »: what was added, then what was not; never a success that hides a refusal. */
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
let bars = 0;

/**
 * Firefox's address capture goes to the passport instead (design § 9.1): FormAutofillParent's `_onAddressSubmit` is
 * replaced, once, by Ressac's bar, and always answers false: no Firefox prompt, nothing in Firefox's store (in clear).
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
    // The pref ressac.js sets keeps Firefox from saving addresses: only Ressac's bar is lost.
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

  /** Per <browser>, its open bar: another section of the same send adds its new values to it. */
  const open = new WeakMap<object, { profile: string; host: string; found: Draft[]; show(): void }>();
  /** Documents (innerWindowId) whose bar was refused or closed: never offered again. */
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
    if (found && host && !declined.has(wgp.innerWindowId)) await bar(browser, found, facts.profile, host, wgp.innerWindowId);
  }

  async function bar(browser: any, found: Draft[], profile: string, host: string, docId: number) {
    const l = (id: string, args?: Record<string, string | number>) => format(o.locale(), id, args);
    // One bar per tab: a second section (billing after shipping) adds what is new to it, or is dropped.
    const cur = open.get(browser);
    if (cur) {
      if (cur.profile === profile && cur.host === host) {
        cur.found.push(...found.filter((d) => !twinOf(cur.found.map(entryOf), entryOf(d))));
        cur.show();
      }
      return;
    }
    const win = browser.ownerGlobal;
    const box = win?.gBrowser?.getNotificationBox?.(browser);
    if (!box) return;
    const doc = win.document;
    const site = siteOf(`https://${host}`);
    // Frozen at the send: exactly what « Ajouter » writes, each value with the kind it is stored as.
    const values = doc.createElementNS(XHTML, "strong");
    const entry = { profile, host, found: [...found], show: () => (values.textContent = entry.found.map((d) => l("chrome-passport-suggest-value", { kind: l(`settings-passport-field-${d.field}`), value: shown(d) })).join(" · ")) };
    entry.show();
    open.set(browser, entry);
    const label = doc.createDocumentFragment();
    const remember = doc.createElementNS(XHTML, "input") as HTMLInputElement;
    remember.type = "checkbox";
    const keep = doc.createElementNS(XHTML, "label");
    keep.append(remember, ` ${l("chrome-passport-suggest-remember", { site })}`);
    label.append(`${l("chrome-passport-suggest")} `, values, " ", keep);
    const id = ++bars;
    // « Ne plus proposer ▾ »: its own popup, gone with the bar.
    const popup = doc.createXULElement("menupopup");
    popup.id = `ressac-passport-mute-${id}`;
    const item = (key: string, act: () => void) => {
      const m = doc.createXULElement("menuitem");
      m.setAttribute("label", l(key));
      m.addEventListener("command", () => {
        act();
        box.removeNotification(n);
      });
      popup.append(m);
    };
    item("chrome-passport-suggest-mute-site", () => {
      const now = Services.prefs.getCharPref(MUTED, "").split(",").filter(Boolean);
      if (!now.includes(host)) Services.prefs.setCharPref(MUTED, [...now, host].join(","));
    });
    item("chrome-passport-suggest-mute-all", () => Services.prefs.setBoolPref("ressac.passport.suggest", false));
    let n: any;
    try {
      n = await box.appendNotification(
        `ressac-passport-suggest-${id}`,
        {
          label,
          priority: box.PRIORITY_INFO_HIGH,
          eventCallback: (e: string) => {
            if (e === "dismissed") decline(docId);
            if (e !== "removed") return;
            popup.remove();
            if (open.get(browser) === entry) open.delete(browser);
          },
        },
        [
          { label: l("chrome-passport-suggest-mute"), popup: popup.id },
          { label: l("chrome-passport-suggest-no"), callback: () => decline(docId) },
          {
            label: l("chrome-passport-suggest-add"),
            callback: () => {
              const origin = remember.checked ? `https://${host}` : null;
              void o
                .addMany({ profile, drafts: entry.found, how: "form", from: host, origin, reason: l("settings-passport-touchid-import") })
                .catch((e): AddManyResult => (console.error("[passport] form add failed:", (e as Error)?.name), { ok: false, error: "write" }))
                .then((r) => {
                  if (r.ok || r.error !== "cancelled") void box.appendNotification(`ressac-passport-suggest-done-${id}`, { label: doneText(r, l), priority: box.PRIORITY_INFO_MEDIUM }, []);
                });
            },
          },
        ],
      );
    } catch (e) {
      if (open.get(browser) === entry) open.delete(browser);
      throw e;
    }
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(popup);
    // The send often navigates: the bar outlives that one location change.
    n.persistence = 1;
  }
}
