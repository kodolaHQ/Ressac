import { describe, expect, it, vi } from "vitest";
import { DeclarationSite, type RetouchesLues } from "../../../packages/noyau/src/index";
import { CONSOLE_RETOUCHES_TOTAL, ERREURS_RETOUCHES_MAX, type InjectionCadre } from "../../navigateur/src/commun/sites";
import type { ErreurRetouche } from "../../navigateur/src/main/sites/fenetres";
import { REFUS_MEMOIRE } from "../noyau/site-memory";
import type { SiteChrome } from "../noyau/sites";

vi.mock("electron", () => ({ ipcMain: undefined }));
const { frameError, frameInjection, frameMemory, siteOfFrame } = await import("../chrome/store/site-frames");

// Electron's sender rules (test/sites/injection.test.ts, IPC part) on Firefox's WindowGlobalParent: what a frame gets
// is decided from its browsing context and the view's <browser>, never from what it says.

const declaration = DeclarationSite.parse({
  nom: "Vidola",
  adresse: "https://vidola-b.example/",
  domaines: ["vidola-a.example"],
  connexion: ["compte.example"],
  retouches: [
    { correspond: ["/series/*"], js: ["a.js"], css: ["a.css"] },
    { correspond: ["/rien"], js: ["lecteur.js"], cadres: ["https://*.lecteur.example/*"] },
  ],
  reprise: true,
});
const retouches: RetouchesLues = { js: { "a.js": "window.a = 1", "lecteur.js": "window.l = 1" }, css: { "a.css": ".shorts{display:none}" } };
const PAGE = "https://vidola-b.example/series/x";

/** A <browser> whose top document is at `url`, and a frame of it. */
function browser(url: string) {
  const el: { browsingContext?: unknown } = {};
  const bc: Record<string, unknown> = { embedderElement: el, currentWindowGlobal: { documentURI: { spec: url } } };
  bc.top = bc;
  el.browsingContext = bc;
  return { el, main: { browsingContext: bc, documentURI: { spec: url } }, frame: (u: string) => ({ browsingContext: { top: bc }, documentURI: { spec: u } }) };
}

function app(o: { accordRequis?: boolean; id?: string; url?: string } = {}) {
  const v = browser(o.url ?? PAGE);
  const site = { id: o.id ?? "vidola", declaration, aAccueil: false, domaines: ["vidola-a.example", "vidola-b.example"], depart: "https://vidola-b.example/", accordRequis: o.accordRequis ?? false } as SiteChrome;
  return { v, s: { site, retouches, view: v.el, erreurs: [] as ErreurRetouche[] } };
}

describe("frameInjection", () => {
  it("the view's main frame gets its retouches and webaiosSite; a sub-frame only what `cadres` gives, without it", () => {
    const { v, s } = app();
    const i = frameInjection(v.main, siteOfFrame(v.main, [s]), false)!;
    expect(i).toMatchObject({ css: [".shorts{display:none}"], js: [{ code: "window.a = 1", nom: "webaios-retouche://vidola/a.js" }], pont: true });
    expect(i.garde).toContain("__webaiosPortee");
    const lecteur = v.frame("https://www.lecteur.example/v");
    expect(frameInjection(lecteur, siteOfFrame(lecteur, [s]), false)).toMatchObject({ js: [{ code: "window.l = 1" }], pont: false, hotes: ["https://www.lecteur.example/*"] });
    const pub = v.frame("https://pub.example/x");
    expect(frameInjection(pub, siteOfFrame(pub, [s]), false)).toMatchObject({ css: [], js: [], garde: null, pont: false });
  });

  it("the sign-in window (same container, another <browser>) and an ordinary tab get nothing", () => {
    const { s } = app();
    const small = browser(PAGE);
    expect(siteOfFrame(small.main, [s])).toBeUndefined();
    expect(frameInjection(small.main, siteOfFrame(small.main, [s]), false)).toBeNull();
    expect(frameInjection(small.frame("https://www.lecteur.example/v"), siteOfFrame(small.frame("x"), [s]), false)).toBeNull();
  });

  it("without the accord: null; about:blank and about:srcdoc get nothing; a page off the site gives its frames nothing", () => {
    const { v, s } = app({ accordRequis: true });
    expect(frameInjection(v.main, siteOfFrame(v.main, [s]), false)).toBeNull();
    const ok = app();
    for (const u of ["about:blank", "about:srcdoc"]) {
      const f = ok.v.frame(u);
      expect(frameInjection(f, siteOfFrame(f, [ok.s]), false)).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false } satisfies InjectionCadre);
    }
    const login = app({ url: "https://compte.example/" });
    const f = login.v.frame("https://www.lecteur.example/v");
    expect(frameInjection(f, siteOfFrame(f, [login.s]), false)).toMatchObject({ js: [], reprise: false });
  });

  it("a gone frame (its documentURI throws) gets nothing", () => {
    const { v, s } = app();
    const gone = { browsingContext: v.main.browsingContext, get documentURI(): never { throw new Error("dead"); } };
    expect(frameInjection(gone, s, false)).toBeNull();
  });
});

describe("frameMemory", () => {
  const demande = { op: "retenir", cle: "k", valeur: 1 };

  it("the view's main page: relayed with the app's id and the page's relative address", async () => {
    const { v, s } = app({ url: "https://vidola-b.example/serie/the-bear?e=4" });
    const request = vi.fn(async () => ({ ok: true as const }));
    expect(await frameMemory(v.main, siteOfFrame(v.main, [s]), demande, request)).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({ id: "vidola", adresse: "/serie/the-bear?e=4", op: "retenir", cle: "k", valeur: 1 });
  });

  it("refused to a sub-frame, the sign-in window, a page off the site, without the accord, and a non-object request", async () => {
    const request = vi.fn(async () => ({ ok: true as const }));
    const { v, s } = app();
    const refus = { ok: false, erreur: REFUS_MEMOIRE };
    const sub = v.frame(PAGE);
    expect(await frameMemory(sub, siteOfFrame(sub, [s]), demande, request)).toEqual(refus);
    const small = browser(PAGE);
    expect(await frameMemory(small.main, siteOfFrame(small.main, [s]), demande, request)).toEqual(refus);
    const login = app({ url: "https://compte.example/" });
    expect(await frameMemory(login.v.main, login.s, demande, request)).toEqual(refus);
    const sans = app({ accordRequis: true });
    expect(await frameMemory(sans.v.main, sans.s, demande, request)).toEqual(refus);
    expect(await frameMemory(v.main, s, "x", request)).toEqual(refus);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("the retouches' console", () => {
  const err = (source: string, texte = "boum") => ({ texte, source, ligne: 3 });

  it("keeps the app's retouche errors relayed from its view, never another app's nor the sign-in window's", () => {
    const a = app();
    const b = app({ id: "autre" });
    const small = browser(PAGE);
    const both = [a.s, b.s];
    frameError(siteOfFrame(a.v.main, both), err("webaios-retouche://vidola/a.js"));
    frameError(siteOfFrame(b.v.frame("https://www.lecteur.example/v"), both), err("webaios-retouche://autre/b.js"));
    // B's page names its code as A's retouche; the sign-in window too; an ordinary source; malformed relays.
    frameError(siteOfFrame(b.v.main, both), err("webaios-retouche://vidola/x.js"));
    frameError(siteOfFrame(small.main, both), err("webaios-retouche://vidola/x.js"));
    frameError(siteOfFrame(a.v.main, both), err("https://vidola-b.example/app.js"));
    for (const bad of [null, "x", { texte: 1, source: "webaios-retouche://vidola/a.js" }, { texte: "t" }]) frameError(a.s, bad);
    expect(a.s.erreurs).toEqual([{ quand: expect.any(String), texte: "boum", source: "webaios-retouche://vidola/a.js:3", sourceVerifiee: false }]);
    expect(b.s.erreurs.map((e) => e.source)).toEqual(["webaios-retouche://autre/b.js:3"]);
  });

  it("is bounded: 50 messages at most, the total text bounded", () => {
    const { s } = app();
    for (let i = 0; i < ERREURS_RETOUCHES_MAX + 10; i++) frameError(s, err("webaios-retouche://vidola/a.js", `e${i}`));
    expect(s.erreurs).toHaveLength(ERREURS_RETOUCHES_MAX);
    expect(s.erreurs[0]!.texte).toBe("e10");
    for (let i = 0; i < 40; i++) frameError(s, err("webaios-retouche://vidola/a.js", "x".repeat(5000)));
    expect(s.erreurs.reduce((t, e) => t + e.texte.length, 0)).toBeLessThanOrEqual(CONSOLE_RETOUCHES_TOTAL);
  });
});
