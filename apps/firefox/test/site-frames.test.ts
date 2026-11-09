import { describe, expect, it, vi } from "vitest";
import { DeclarationSite, type TweaksRead } from "../../../packages/kernel/src/index";
import { CONSOLE_TWEAKS_TOTAL, MAX_TWEAK_ERRORS, type FrameInjection } from "../shared/sites";
import type { TweakError } from "../core/sites/injection";
import { MEMORY_DENIAL } from "../host/site-memory";
import type { SiteChrome } from "../host/sites";

const { frameError, framePosition, frameResume, frameInjection, frameMemory, siteOfFrame } = await import("../chrome/store/site-frames");

// The sender rules on Firefox's WindowGlobalParent: what a frame gets
// is decided from its browsing context and the view's <browser>, never from what it says.

const declaration = DeclarationSite.parse({
  name: "Vidola",
  url: "https://vidola-b.example/",
  domains: ["vidola-a.example"],
  login: ["compte.example"],
  tweaks: [
    { matches: ["/series/*"], js: ["a.js"], css: ["a.css"] },
    { matches: ["/rien"], js: ["lecteur.js"], frames: ["https://*.lecteur.example/*"] },
  ],
  resume: true,
});
const tweaks: TweaksRead = { js: { "a.js": "window.a = 1", "lecteur.js": "window.l = 1" }, css: { "a.css": ".shorts{display:none}" } };
const PAGE = "https://vidola-b.example/series/x";

/** A <browser> whose top document is at `url`, and a frame of it. */
function browser(url: string) {
  const el: { browsingContext?: unknown } = {};
  const bc: Record<string, unknown> = { embedderElement: el, currentWindowGlobal: { documentURI: { spec: url } } };
  bc.top = bc;
  el.browsingContext = bc;
  return { el, main: { browsingContext: bc, documentURI: { spec: url } }, frame: (u: string) => ({ browsingContext: { top: bc }, documentURI: { spec: u } }) };
}

function app(o: { grantRequired?: boolean; id?: string; url?: string } = {}) {
  const v = browser(o.url ?? PAGE);
  const site = { id: o.id ?? "vidola", declaration, hasHome: false, domains: ["vidola-a.example", "vidola-b.example"], start: "https://vidola-b.example/", grantRequired: o.grantRequired ?? false } as SiteChrome;
  return { v, s: { site, tweaks: tweaks, view: v.el, errors: [] as TweakError[] } };
}

describe("frameInjection", () => {
  it("the view's main frame gets its tweaks and webaiosSite; a sub-frame only what `cadres` gives, without it", () => {
    const { v, s } = app();
    const i = frameInjection(v.main, siteOfFrame(v.main, [s]), false)!;
    expect(i).toMatchObject({ css: [".shorts{display:none}"], js: [{ code: "window.a = 1", name: "webaios-tweak://vidola/a.js" }], bridge: true });
    expect(i.guard).toContain("__webaiosScope");
    const reader = v.frame("https://www.lecteur.example/v");
    expect(frameInjection(reader, siteOfFrame(reader, [s]), false)).toMatchObject({ js: [{ code: "window.l = 1" }], bridge: false, hosts: ["https://www.lecteur.example/*"] });
    const pub = v.frame("https://pub.example/x");
    expect(frameInjection(pub, siteOfFrame(pub, [s]), false)).toMatchObject({ css: [], js: [], guard: null, bridge: false });
  });

  it("the sign-in window (same container, another <browser>) and an ordinary tab get nothing", () => {
    const { s } = app();
    const small = browser(PAGE);
    expect(siteOfFrame(small.main, [s])).toBeUndefined();
    expect(frameInjection(small.main, siteOfFrame(small.main, [s]), false)).toBeNull();
    expect(frameInjection(small.frame("https://www.lecteur.example/v"), siteOfFrame(small.frame("x"), [s]), false)).toBeNull();
  });

  it("without the grant: null; about:blank and about:srcdoc get nothing; a page off the site gives its frames nothing", () => {
    const { v, s } = app({ grantRequired: true });
    expect(frameInjection(v.main, siteOfFrame(v.main, [s]), false)).toBeNull();
    const ok = app();
    for (const u of ["about:blank", "about:srcdoc"]) {
      const f = ok.v.frame(u);
      expect(frameInjection(f, siteOfFrame(f, [ok.s]), false)).toEqual({ css: [], js: [], guard: null, hosts: [], bridge: false, resume: false } satisfies FrameInjection);
    }
    const login = app({ url: "https://compte.example/" });
    const f = login.v.frame("https://www.lecteur.example/v");
    expect(frameInjection(f, siteOfFrame(f, [login.s]), false)).toMatchObject({ js: [], resume: false });
  });

  it("an about:srcdoc player frame of an app page gets the resume when the app declares no cadres, never the tweaks", () => {
    const without = app();
    const free = { ...without.s, site: { ...without.s.site, declaration: DeclarationSite.parse({ ...declaration, tweaks: [{ matches: ["/series/*"], js: ["a.js"] }] }) } };
    const f = without.v.frame("about:srcdoc");
    expect(frameInjection(f, siteOfFrame(f, [free]), false)).toEqual({ css: [], js: [], guard: null, hosts: [], bridge: false, resume: true });
    // With `cadres` patterns, a frame without an address of its own matches none; on a sign-in page, nothing.
    expect(frameInjection(f, siteOfFrame(f, [without.s]), false)?.resume).toBe(false);
    const login = app({ url: "https://compte.example/" });
    const g = login.v.frame("about:srcdoc");
    expect(frameInjection(g, siteOfFrame(g, [{ ...login.s, site: free.site }]), false)?.resume).toBe(false);
  });

  it("a gone frame (its documentURI throws) gets nothing", () => {
    const { v, s } = app();
    const gone = { browsingContext: v.main.browsingContext, get documentURI(): never { throw new Error("dead"); } };
    expect(frameInjection(gone, s, false)).toBeNull();
  });
});

describe("frameMemory", () => {
  const req = { op: "remember", key: "k", value: 1 };

  it("the view's main page: relayed with the app's id and the page's relative address", async () => {
    const { v, s } = app({ url: "https://vidola-b.example/serie/the-bear?e=4" });
    const request = vi.fn(async () => ({ ok: true as const }));
    expect(await frameMemory(v.main, siteOfFrame(v.main, [s]), req, request)).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({ id: "vidola", url: "/serie/the-bear?e=4", op: "remember", key: "k", value: 1 });
  });

  it("refused to a sub-frame, the sign-in window, a page off the site, without the grant, and a non-object request", async () => {
    const request = vi.fn(async () => ({ ok: true as const }));
    const { v, s } = app();
    const denial = { ok: false, error: MEMORY_DENIAL };
    const sub = v.frame(PAGE);
    expect(await frameMemory(sub, siteOfFrame(sub, [s]), req, request)).toEqual(denial);
    const small = browser(PAGE);
    expect(await frameMemory(small.main, siteOfFrame(small.main, [s]), req, request)).toEqual(denial);
    const login = app({ url: "https://compte.example/" });
    expect(await frameMemory(login.v.main, login.s, req, request)).toEqual(denial);
    const without = app({ grantRequired: true });
    expect(await frameMemory(without.v.main, without.s, req, request)).toEqual(denial);
    expect(await frameMemory(v.main, s, "x", request)).toEqual(denial);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("the tweaks' console", () => {
  const err = (source: string, text = "boum") => ({ text: text, source, line: 3 });

  it("keeps the app's tweak errors relayed from its view, never another app's nor the sign-in window's", () => {
    const a = app();
    const b = app({ id: "autre" });
    const small = browser(PAGE);
    const both = [a.s, b.s];
    frameError(siteOfFrame(a.v.main, both), err("webaios-tweak://vidola/a.js"));
    frameError(siteOfFrame(b.v.frame("https://www.lecteur.example/v"), both), err("webaios-tweak://autre/b.js"));
    // B's page names its code as A's tweak; the sign-in window too; an ordinary source; malformed relays.
    frameError(siteOfFrame(b.v.main, both), err("webaios-tweak://vidola/x.js"));
    frameError(siteOfFrame(small.main, both), err("webaios-tweak://vidola/x.js"));
    frameError(siteOfFrame(a.v.main, both), err("https://vidola-b.example/app.js"));
    for (const bad of [null, "x", { text: 1, source: "webaios-tweak://vidola/a.js" }, { text: "t" }]) frameError(a.s, bad);
    expect(a.s.errors).toEqual([{ when: expect.any(String), text: "boum", source: "webaios-tweak://vidola/a.js:3", sourceVerified: false }]);
    expect(b.s.errors.map((e) => e.source)).toEqual(["webaios-tweak://autre/b.js:3"]);
  });

  it("is bounded: 50 messages at most, the total text bounded", () => {
    const { s } = app();
    for (let i = 0; i < MAX_TWEAK_ERRORS + 10; i++) frameError(s, err("webaios-tweak://vidola/a.js", `e${i}`));
    expect(s.errors).toHaveLength(MAX_TWEAK_ERRORS);
    expect(s.errors[0]!.text).toBe("e10");
    for (let i = 0; i < 40; i++) frameError(s, err("webaios-tweak://vidola/a.js", "x".repeat(5000)));
    expect(s.errors.reduce((t, e) => t + e.text.length, 0)).toBeLessThanOrEqual(CONSOLE_TWEAKS_TOTAL);
  });
});

// The resume rules (position and reprise refusals), on WindowGlobalParents.
describe("framePosition and frameResume", () => {
  /** A frame with the ids the step key is made of. */
  const withIds = <F extends { browsingContext: object }>(f: F, id: number, inner: number) => {
    // The main frame's context is the view's own object (that identity makes it the main frame): its id is set in place.
    if ((f.browsingContext as { top?: unknown }).top === f.browsingContext) Object.assign(f.browsingContext, { id });
    return { ...f, browsingContext: (f.browsingContext as { top?: unknown }).top === f.browsingContext ? f.browsingContext : { ...f.browsingContext, id }, innerWindowId: inner };
  };
  const note = (v: ReturnType<typeof app>["v"], s: ReturnType<typeof app>["s"], f: any, p: unknown, local = false) => {
    const sent: object[] = [];
    framePosition(f, siteOfFrame(f, [s]), p, local, (q) => sent.push(q));
    return sent;
  };
  const READER = "https://www.lecteur.example/embed/9";

  it("a position from the player is sent with the page's address and the frame's step key; from the main page too", () => {
    const { v, s } = app({ url: "https://vidola-b.example/episode/4?s=1" });
    const reader = withIds(v.frame(READER), 5, 77);
    expect(note(v, s, reader, { t: 70, duration: 90 })).toEqual([{ id: "vidola", url: "/episode/4?s=1", frame: "5:77", t: 70, duration: 90, end: false }]);
    const main = withIds(v.main, 2, 11);
    expect(note(v, s, main, { t: 72, duration: 90, end: true })).toEqual([{ id: "vidola", url: "/episode/4?s=1", frame: "2:11", t: 72, duration: 90, end: true }]);
  });

  it("refused without grant, for a frame the resume does not go into, outside the view, off the site, or a malformed message", () => {
    const { v, s } = app();
    const reader = withIds(v.frame(READER), 5, 77);
    expect(note(v, { ...s, site: { ...s.site, grantRequired: true } } as never, reader, { t: 70, duration: 90 })).toEqual([]);
    // reprise false in the declaration
    const without = { ...s, site: { ...s.site, declaration: { ...declaration, resume: false } } } as never;
    expect(note(v, without, reader, { t: 70, duration: 90 })).toEqual([]);
    // an advert does not match the `cadres` patterns
    expect(note(v, s, withIds(v.frame("https://ads.pub.example/v"), 6, 78), { t: 70, duration: 90 })).toEqual([]);
    // the sign-in window (another <browser>)
    const small = browser(PAGE);
    expect(note(small, s, withIds(small.main, 9, 1), { t: 70, duration: 90 })).toEqual([]);
    // a sign-in page and its frames
    const login = app({ url: "https://compte.example/connexion" });
    expect(note(login.v, login.s, withIds(login.v.frame(READER), 5, 77), { t: 70, duration: 90 })).toEqual([]);
    expect(note(login.v, login.s, withIds(login.v.main, 2, 11), { t: 70, duration: 90 })).toEqual([]);
    for (const p of [null, "x", undefined]) expect(note(v, s, reader, p)).toEqual([]);
  });

  it("the address is read at each message (a pushState to another episode counts)", () => {
    const { v, s } = app({ url: "https://vidola-b.example/episode/4" });
    const reader = withIds(v.frame(READER), 5, 77);
    expect((note(v, s, reader, { t: 1, duration: 90 })[0] as { url: string }).url).toBe("/episode/4");
    (v.main.browsingContext as any).currentWindowGlobal = { documentURI: { spec: "https://vidola-b.example/episode/5" } };
    expect((note(v, s, reader, { t: 1, duration: 90 })[0] as { url: string }).url).toBe("/episode/5");
  });

  it("frameResume asks the host with the page's address; nothing for a refused frame or a malformed duration", async () => {
    const { v, s } = app({ url: "https://vidola-b.example/episode/4" });
    const asked: object[] = [];
    const ask = async (p: object) => (asked.push(p), 70);
    const reader = withIds(v.frame(READER), 5, 77);
    expect(await frameResume(reader, siteOfFrame(reader, [s]), { duration: 90 }, false, ask)).toBe(70);
    expect(asked).toEqual([{ id: "vidola", url: "/episode/4", duration: 90 }]);
    for (const d of [undefined, null, {}, { duration: "90" }]) expect(await frameResume(reader, siteOfFrame(reader, [s]), d, false, ask)).toBeNull();
    const ad = withIds(v.frame("https://ads.pub.example/v"), 6, 78);
    expect(await frameResume(ad, siteOfFrame(ad, [s]), { duration: 90 }, false, ask)).toBeNull();
    const small = browser(PAGE);
    expect(await frameResume(small.main, siteOfFrame(small.main, [s]), { duration: 90 }, false, ask)).toBeNull();
    expect(asked).toHaveLength(1);
  });
});
