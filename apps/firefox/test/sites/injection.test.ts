import { expect, test } from "vitest";
import { grantCovers, grantNeeded, DeclarationSite, type TweaksRead } from "@webaios/kernel";
import { CONSOLE_TWEAKS_TOTAL, type FrameInjection } from "../../shared/sites";
import { addTweakConsole, injectionFor, resumeInFrame, type OpenableSite } from "../../core/sites/injection";

const GUARD = "/* garde */";
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
const site: OpenableSite = {
  id: "vidola",
  declaration,
  hasHome: false,
  // vidola-a: the old domain; vidola-b: the current one (the profile's url.json).
  domains: ["vidola-a.example", "vidola-b.example"],
  start: "https://vidola-b.example/",
  grantRequired: false,
};
const tweaks: TweaksRead = { js: { "a.js": "window.a = 1", "lecteur.js": "window.l = 1" }, css: { "a.css": ".shorts{display:none}" } };
const updateEntry = (granted = true) => ({ site, tweaks: tweaks, granted: granted, guard: GUARD });
/** The view's main page, on the site: the sub-frames'. */
const PAGE = "https://vidola-b.example/series/x";

test("without a grant: null", () => {
  expect(injectionFor(updateEntry(false), { url: "https://vidola-b.example/series/x", main: true })).toBeNull();
  expect(injectionFor(updateEntry(false), { url: "https://www.lecteur.example/v", main: false, page: PAGE })).toBeNull();
});

test("main frame on /series/x: the tweak's js and css, bridge true, hosts of the effective domains", () => {
  const i = injectionFor(updateEntry(), { url: "https://vidola-b.example/series/x", main: true });
  expect(i).toEqual({
    css: [".shorts{display:none}"],
    js: [{ code: "window.a = 1", name: "webaios-tweak://vidola/a.js" }],
    guard: GUARD,
    hosts: ["https://*.vidola-a.example/*", "https://vidola-a.example/*", "https://*.vidola-b.example/*", "https://vidola-b.example/*"],
    bridge: true,
    resume: true,
  } satisfies FrameInjection);
});

test("main frame on the old domain: same tweaks", () => {
  const current = injectionFor(updateEntry(), { url: "https://vidola-b.example/series/x", main: true });
  const old = injectionFor(updateEntry(), { url: "https://www.vidola-a.example/series/x", main: true });
  expect(old).toEqual(current);
});

test("main frame on a page without tweaks: neither guard nor script, the bridge stays", () => {
  const i = injectionFor(updateEntry(), { url: "https://vidola-b.example/films", main: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
  expect(i.guard).toBeNull();
  expect(i.resume).toBe(true);
});

test("lecteur.localhost sub-frame outside the declared frame patterns: nothing, not even the resume", () => {
  const i = injectionFor(updateEntry(), { url: "https://lecteur.localhost/v", main: false, page: PAGE });
  expect(i).toEqual({ css: [], js: [], guard: null, hosts: [], bridge: false, resume: false });
  const withoutResume = injectionFor({ ...updateEntry(), site: { ...site, declaration: { ...declaration, resume: false } } }, { url: "https://lecteur.localhost/v", main: false, page: PAGE });
  expect(withoutResume?.resume).toBe(false);
});

test("sub-frame matching frames: js, bridge false", () => {
  const i = injectionFor(updateEntry(), { url: "https://www.lecteur.example/v/1", main: false, page: PAGE })!;
  expect(i.js).toEqual([{ code: "window.l = 1", name: "webaios-tweak://vidola/lecteur.js" }]);
  expect(i.guard).toBe(GUARD);
  expect(i.bridge).toBe(false);
  expect(i.hosts).toEqual(["https://www.lecteur.example/*"]);
  // The main page's pattern never applies to a sub-frame (even on the site).
  expect(injectionFor(updateEntry(), { url: "https://vidola-b.example/series/x", main: false, page: PAGE })?.js).toEqual([]);
});

test("tests only: a local http sub-frame matches the https patterns (the test server has no TLS)", () => {
  const pattern = { ...declaration, tweaks: [{ matches: ["/rien"], js: ["lecteur.js"], css: [], frames: ["https://lecteur.localhost:8080/*"] }] };
  const o = { ...updateEntry(), site: { ...site, declaration: pattern } };
  const frame = { url: "http://lecteur.localhost:8080/v", main: false, page: PAGE };
  expect(injectionFor({ ...o, localAddresses: true }, frame)?.js).toHaveLength(1);
  expect(injectionFor(o, frame)?.js ?? []).toEqual([]);
});

test("page outside the site (sign-in): no tweak", () => {
  const i = injectionFor(updateEntry(), { url: "https://compte.example/series/x", main: true });
  expect(i).toEqual({ css: [], js: [], guard: null, hosts: [], bridge: false, resume: false });
  for (const url of ["about:blank", "javascript:alert(1)", "https://pub.example/series/x", ""]) {
    expect(injectionFor(updateEntry(), { url, main: true })?.js ?? []).toEqual([]);
    expect(injectionFor(updateEntry(), { url, main: true })?.bridge ?? false).toBe(false);
  }
});

test("main page on a sign-in domain: its sub-frames receive nothing (neither tweak nor resume), even those of the frame patterns", () => {
  const reader = { url: "https://www.lecteur.example/v/1", main: false };
  expect(injectionFor(updateEntry(), { ...reader, page: "https://vidola-b.example/series/x" })!.js).toHaveLength(1);
  for (const page of ["https://compte.example/connexion", "https://pub.example/", null]) {
    expect(injectionFor(updateEntry(), { ...reader, page })).toEqual({ css: [], js: [], guard: null, hosts: [], bridge: false, resume: false });
  }
});

test("a file cited but absent from the cache is not injected", () => {
  const i = injectionFor({ ...updateEntry(), tweaks: { js: {}, css: {} } }, { url: "https://vidola-b.example/series/x", main: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
});

test("a grant covering fewer rights than the declaration (frames added): no injection", () => {
  const extra = DeclarationSite.parse({ ...declaration, tweaks: [...declaration.tweaks, { matches: ["/x"], frames: ["https://*.autre.example/*"] }] });
  const grant = { domains: ["vidola-a.example"], login: ["compte.example"], frames: ["https://*.lecteur.example/*"], resume: true };
  // What the service does: granted = !grantRequired, grantRequired = grantNeeded && !grantCovers.
  const required = grantNeeded(extra) && !grantCovers(grant, extra);
  expect(required).toBe(true);
  const o = { ...updateEntry(!required), site: { ...site, declaration: extra, grantRequired: required } };
  expect(injectionFor(o, { url: "https://vidola-b.example/series/x", main: true })).toBeNull();
  expect(injectionFor(o, { url: "https://www.lecteur.example/v", main: false, page: PAGE })).toBeNull();
  // With the old declaration, the same grant is enough.
  expect(grantCovers(grant, declaration)).toBe(true);
});

test("tweaks console: text truncated to 2000 characters, source to 500, total bounded, 50 at most, never verified", () => {
  const l: ReturnType<typeof addTweakConsole> = [];
  addTweakConsole(l, { text: "a".repeat(10_000), source: "webaios-tweak://vidola/" + "b".repeat(1000) }, "t");
  expect(l[0]!.text).toHaveLength(2000);
  expect(l[0]!.source).toHaveLength(500);
  expect(l[0]!.sourceVerified).toBe(false);
  for (let n = 0; n < 100; n++) addTweakConsole(l, { text: `${n}`.padEnd(2000, "x"), source: "s" }, "t");
  expect(l.reduce((t, e) => t + e.text.length, 0)).toBeLessThanOrEqual(CONSOLE_TWEAKS_TOTAL);
  expect(l.at(-1)!.text.startsWith("99")).toBe(true);
  const small: ReturnType<typeof addTweakConsole> = [];
  for (let n = 0; n < 80; n++) addTweakConsole(small, { text: `${n}`, source: "s" }, "t");
  expect(small).toHaveLength(50);
  expect(small[0]!.text).toBe("30");
});

test("declared frame patterns: the resume only goes into the main frame and the frames matching them; without a pattern, everywhere", () => {
  const withFrames = injectionFor(updateEntry(), { url: "https://www.lecteur.example/v", main: false, page: PAGE })!;
  expect(withFrames.resume).toBe(true);
  expect(injectionFor(updateEntry(), { url: "https://ads.pub.example/v", main: false, page: PAGE })!.resume).toBe(false);
  expect(injectionFor(updateEntry(), { url: "https://vidola-b.example/episode/4", main: true })!.resume).toBe(true);
  expect(resumeInFrame(declaration, { url: "https://ads.pub.example/v", main: false })).toBe(false);
  const withoutFrames = DeclarationSite.parse({ ...declaration, tweaks: [{ matches: ["/series/*"], js: ["a.js"] }] });
  expect(resumeInFrame(withoutFrames, { url: "https://ads.pub.example/v", main: false })).toBe(true);
  expect(resumeInFrame({ ...withoutFrames, resume: false }, { url: "https://vidola-b.example/", main: true })).toBe(false);
  // Tests: a local host's http player compared as in https.
  const local = DeclarationSite.parse({ ...declaration, tweaks: [{ matches: ["/x"], frames: ["https://lecteur.localhost:*/*"] }] });
  expect(resumeInFrame(local, { url: "http://lecteur.localhost:4000/v", main: false }, true)).toBe(true);
  expect(resumeInFrame(local, { url: "http://pub.localhost:4000/v", main: false }, true)).toBe(false);
});
