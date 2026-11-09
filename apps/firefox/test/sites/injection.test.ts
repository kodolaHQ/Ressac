import { expect, test } from "vitest";
import { grantCovers, grantNeeded, DeclarationSite, type TweaksRead } from "@webaios/noyau";
import { CONSOLE_TWEAKS_TOTAL, type InjectionCadre } from "../../shared/sites";
import { addTweakConsole, injectionPour, repriseDansCadre, type OpenableSite } from "../../core/sites/injection";

const GUARD = "/* garde */";
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
const site: OpenableSite = {
  id: "vidola",
  declaration,
  aAccueil: false,
  // vidola-a: the old domain; vidola-b: the current one (the profile's adresse.json).
  domaines: ["vidola-a.example", "vidola-b.example"],
  depart: "https://vidola-b.example/",
  accordRequis: false,
};
const tweaks: TweaksRead = { js: { "a.js": "window.a = 1", "lecteur.js": "window.l = 1" }, css: { "a.css": ".shorts{display:none}" } };
const updateEntry = (granted = true) => ({ site, retouches: tweaks, accorde: granted, garde: GUARD });
/** The view's main page, on the site: the sub-frames'. */
const PAGE = "https://vidola-b.example/series/x";

test("without a grant: null", () => {
  expect(injectionPour(updateEntry(false), { url: "https://vidola-b.example/series/x", principal: true })).toBeNull();
  expect(injectionPour(updateEntry(false), { url: "https://www.lecteur.example/v", principal: false, page: PAGE })).toBeNull();
});

test("main frame on /series/x: the tweak's js and css, bridge true, hosts of the effective domains", () => {
  const i = injectionPour(updateEntry(), { url: "https://vidola-b.example/series/x", principal: true });
  expect(i).toEqual({
    css: [".shorts{display:none}"],
    js: [{ code: "window.a = 1", nom: "webaios-retouche://vidola/a.js" }],
    garde: GUARD,
    hotes: ["https://*.vidola-a.example/*", "https://vidola-a.example/*", "https://*.vidola-b.example/*", "https://vidola-b.example/*"],
    pont: true,
    reprise: true,
  } satisfies InjectionCadre);
});

test("main frame on the old domain: same tweaks", () => {
  const current = injectionPour(updateEntry(), { url: "https://vidola-b.example/series/x", principal: true });
  const old = injectionPour(updateEntry(), { url: "https://www.vidola-a.example/series/x", principal: true });
  expect(old).toEqual(current);
});

test("main frame on a page without tweaks: neither guard nor script, the bridge stays", () => {
  const i = injectionPour(updateEntry(), { url: "https://vidola-b.example/films", principal: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
  expect(i.garde).toBeNull();
  expect(i.reprise).toBe(true);
});

test("lecteur.localhost sub-frame outside the declared frame patterns: nothing, not even the resume", () => {
  const i = injectionPour(updateEntry(), { url: "https://lecteur.localhost/v", principal: false, page: PAGE });
  expect(i).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
  const sansReprise = injectionPour({ ...updateEntry(), site: { ...site, declaration: { ...declaration, reprise: false } } }, { url: "https://lecteur.localhost/v", principal: false, page: PAGE });
  expect(sansReprise?.reprise).toBe(false);
});

test("sub-frame matching cadres: js, bridge false", () => {
  const i = injectionPour(updateEntry(), { url: "https://www.lecteur.example/v/1", principal: false, page: PAGE })!;
  expect(i.js).toEqual([{ code: "window.l = 1", nom: "webaios-retouche://vidola/lecteur.js" }]);
  expect(i.garde).toBe(GUARD);
  expect(i.pont).toBe(false);
  expect(i.hotes).toEqual(["https://www.lecteur.example/*"]);
  // The main page's pattern never applies to a sub-frame (even on the site).
  expect(injectionPour(updateEntry(), { url: "https://vidola-b.example/series/x", principal: false, page: PAGE })?.js).toEqual([]);
});

test("tests only: a local http sub-frame matches the https patterns (the test server has no TLS)", () => {
  const motif = { ...declaration, retouches: [{ correspond: ["/rien"], js: ["lecteur.js"], css: [], cadres: ["https://lecteur.localhost:8080/*"] }] };
  const o = { ...updateEntry(), site: { ...site, declaration: motif } };
  const cadre = { url: "http://lecteur.localhost:8080/v", principal: false, page: PAGE };
  expect(injectionPour({ ...o, adressesLocales: true }, cadre)?.js).toHaveLength(1);
  expect(injectionPour(o, cadre)?.js ?? []).toEqual([]);
});

test("page outside the site (sign-in): no tweak", () => {
  const i = injectionPour(updateEntry(), { url: "https://compte.example/series/x", principal: true });
  expect(i).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
  for (const url of ["about:blank", "javascript:alert(1)", "https://pub.example/series/x", ""]) {
    expect(injectionPour(updateEntry(), { url, principal: true })?.js ?? []).toEqual([]);
    expect(injectionPour(updateEntry(), { url, principal: true })?.pont ?? false).toBe(false);
  }
});

test("main page on a sign-in domain: its sub-frames receive nothing (neither tweak nor resume), even those of the frame patterns", () => {
  const reader = { url: "https://www.lecteur.example/v/1", principal: false };
  expect(injectionPour(updateEntry(), { ...reader, page: "https://vidola-b.example/series/x" })!.js).toHaveLength(1);
  for (const page of ["https://compte.example/connexion", "https://pub.example/", null]) {
    expect(injectionPour(updateEntry(), { ...reader, page })).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
  }
});

test("a file cited but absent from the cache is not injected", () => {
  const i = injectionPour({ ...updateEntry(), retouches: { js: {}, css: {} } }, { url: "https://vidola-b.example/series/x", principal: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
});

test("a grant covering fewer rights than the declaration (frames added): no injection", () => {
  const plus = DeclarationSite.parse({ ...declaration, retouches: [...declaration.retouches, { correspond: ["/x"], cadres: ["https://*.autre.example/*"] }] });
  const accord = { domaines: ["vidola-a.example"], connexion: ["compte.example"], cadres: ["https://*.lecteur.example/*"], reprise: true };
  // What the service does: accorde = !accordRequis, accordRequis = accordNecessaire && !accordCouvre.
  const required = grantNeeded(plus) && !grantCovers(accord, plus);
  expect(required).toBe(true);
  const o = { ...updateEntry(!required), site: { ...site, declaration: plus, accordRequis: required } };
  expect(injectionPour(o, { url: "https://vidola-b.example/series/x", principal: true })).toBeNull();
  expect(injectionPour(o, { url: "https://www.lecteur.example/v", principal: false, page: PAGE })).toBeNull();
  // With the old declaration, the same grant is enough.
  expect(grantCovers(accord, declaration)).toBe(true);
});

test("tweaks console: text truncated to 2000 characters, source to 500, total bounded, 50 at most, never verified", () => {
  const l: ReturnType<typeof addTweakConsole> = [];
  addTweakConsole(l, { texte: "a".repeat(10_000), source: "webaios-retouche://vidola/" + "b".repeat(1000) }, "t");
  expect(l[0]!.texte).toHaveLength(2000);
  expect(l[0]!.source).toHaveLength(500);
  expect(l[0]!.sourceVerifiee).toBe(false);
  for (let n = 0; n < 100; n++) addTweakConsole(l, { texte: `${n}`.padEnd(2000, "x"), source: "s" }, "t");
  expect(l.reduce((t, e) => t + e.texte.length, 0)).toBeLessThanOrEqual(CONSOLE_TWEAKS_TOTAL);
  expect(l.at(-1)!.texte.startsWith("99")).toBe(true);
  const petits: ReturnType<typeof addTweakConsole> = [];
  for (let n = 0; n < 80; n++) addTweakConsole(petits, { texte: `${n}`, source: "s" }, "t");
  expect(petits).toHaveLength(50);
  expect(petits[0]!.texte).toBe("30");
});

test("declared frame patterns: the resume only goes into the main frame and the frames matching them; without a pattern, everywhere", () => {
  const withFrames = injectionPour(updateEntry(), { url: "https://www.lecteur.example/v", principal: false, page: PAGE })!;
  expect(withFrames.reprise).toBe(true);
  expect(injectionPour(updateEntry(), { url: "https://ads.pub.example/v", principal: false, page: PAGE })!.reprise).toBe(false);
  expect(injectionPour(updateEntry(), { url: "https://vidola-b.example/episode/4", principal: true })!.reprise).toBe(true);
  expect(repriseDansCadre(declaration, { url: "https://ads.pub.example/v", principal: false })).toBe(false);
  const sansCadres = DeclarationSite.parse({ ...declaration, retouches: [{ correspond: ["/series/*"], js: ["a.js"] }] });
  expect(repriseDansCadre(sansCadres, { url: "https://ads.pub.example/v", principal: false })).toBe(true);
  expect(repriseDansCadre({ ...sansCadres, reprise: false }, { url: "https://vidola-b.example/", principal: true })).toBe(false);
  // Tests: a local host's http player compared as in https.
  const local = DeclarationSite.parse({ ...declaration, retouches: [{ correspond: ["/x"], cadres: ["https://lecteur.localhost:*/*"] }] });
  expect(repriseDansCadre(local, { url: "http://lecteur.localhost:4000/v", principal: false }, true)).toBe(true);
  expect(repriseDansCadre(local, { url: "http://pub.localhost:4000/v", principal: false }, true)).toBe(false);
});
