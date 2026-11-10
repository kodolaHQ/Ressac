import { expect, test } from "vitest";
import {
  URL_OUTSIDE_DOMAINS,
  FRAME_PATTERNS,
  PATH_MATCHES,
  DeclarationSite,
  INVALID_DOMAIN,
  ID_SITE,
  HTTPS_ONLY,
  checkSiteDeclaration,
} from "../../src/sites/schemas.js";

const vidola = {
  name: "Vidola",
  description: "Séries et films",
  url: "https://vidola-a.example/",
  domains: ["vidola-a.example"],
  urlTracking: { page: "https://adresses.example/", pattern: "vidola" },
  tweaks: [{ matches: ["/series/*"], js: ["lecteur.js"], css: ["pub.css"], frames: ["https://*.clipsy.*/*"] }],
  resume: true,
};

const messages = (v: unknown) => {
  const r = DeclarationSite.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

test("the Vidola example (domains, addressTracking, tweaks with frames, reprise) is accepted", () => {
  const r = DeclarationSite.safeParse(vidola);
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.login).toEqual([]);
});

test("the YouTube example (login, css tweak that hides Shorts) is accepted", () => {
  const r = DeclarationSite.safeParse({
    name: "YouTube",
    url: "https://www.youtube.com/",
    domains: ["youtube.com"],
    login: ["accounts.google.com"],
    tweaks: [{ matches: ["/*"], css: ["sans-shorts.css"] }],
  });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.tweaks[0]).toMatchObject({ js: [], frames: false });
    expect(r.data.resume).toBe(false);
  }
});

test("cadres: true donne FRAME_PATTERNS", () => {
  const m = messages({ ...vidola, tweaks: [{ matches: ["/*"], frames: true }] });
  expect(m).toContain(FRAME_PATTERNS);
});

test('correspond "series/*" donne PATH_MATCHES', () => {
  expect(messages({ ...vidola, tweaks: [{ matches: ["series/*"] }] })).toContain(PATH_MATCHES);
});

test("a tweak path with .. or absolute is refused", () => {
  for (const js of ["../x.js", "a/../x.js", "/x.js"]) {
    expect(DeclarationSite.safeParse({ ...vidola, tweaks: [{ matches: ["/*"], js: [js] }] }).success, js).toBe(false);
  }
  expect(DeclarationSite.safeParse({ ...vidola, tweaks: [{ matches: ["/*"], js: ["x.txt"] }] }).success).toBe(false);
});

test("an unknown key (permissions) is refused", () => {
  expect(DeclarationSite.safeParse({ ...vidola, permissions: ["tout"] }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, urlTracking: { page: "https://a.example/", pattern: "ab", x: 1 } }).success).toBe(false);
});

test('21 domains, "*.x.com", "X.com:443", a scheme refused', () => {
  const twentyOne = Array.from({ length: 21 }, (_, i) => `s${i}.example`);
  expect(DeclarationSite.safeParse({ ...vidola, domains: twentyOne }).success).toBe(false);
  for (const d of ["*.x.com", "X.com:443", "https://x.com", "x.com/", ""]) {
    expect(DeclarationSite.safeParse({ ...vidola, domains: [d] }).success, d).toBe(false);
  }
  expect(DeclarationSite.safeParse({ ...vidola, domains: [] }).success).toBe(false);
});

test("name, tracking pattern, icon", () => {
  expect(DeclarationSite.safeParse({ ...vidola, name: "" }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, name: "x".repeat(61) }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, urlTracking: { page: "https://a.example/", pattern: "a" } }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, icon: "icone.png" }).success).toBe(true);
  expect(DeclarationSite.safeParse({ ...vidola, icon: "../icone.png" }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, icon: "icone.gif" }).success).toBe(false);
});

const decl = (patch: Record<string, unknown>) => DeclarationSite.parse({ ...vidola, ...patch });
const strict = { localAddresses: false };

test("checkSiteDeclaration: https only, never a local address", () => {
  expect(checkSiteDeclaration(decl({}), strict)).toBeNull();
  expect(checkSiteDeclaration(decl({ url: "http://vidola-a.example/" }), strict)).toBe(HTTPS_ONLY);
  expect(checkSiteDeclaration(decl({ url: "https://192.168.1.2/", domains: ["192.168.1.2"] }), strict)).toBe(HTTPS_ONLY);
  expect(checkSiteDeclaration(decl({ urlTracking: { page: "http://adresses.example/", pattern: "vidola" } }), strict)).toBe(HTTPS_ONLY);
  expect(checkSiteDeclaration(decl({ urlTracking: { page: "https://127.0.0.1/", pattern: "vidola" } }), strict)).toBe(HTTPS_ONLY);
});

test("checkSiteDeclaration: with localAddresses, http of a local host is allowed", () => {
  const d = decl({ url: "http://vidola-a.localhost:5000/", domains: ["vidola-a.localhost"], urlTracking: { page: "http://adresses.localhost:5001/", pattern: "vidola" } });
  expect(checkSiteDeclaration(d, { localAddresses: true })).toBeNull();
  expect(checkSiteDeclaration(d, strict)).toBe(HTTPS_ONLY);
  // http of a public host stays refused.
  expect(checkSiteDeclaration(decl({ url: "http://vidola-a.example/" }), { localAddresses: true })).toBe(HTTPS_ONLY);
});

test("checkSiteDeclaration : domaine de l'adresse", () => {
  expect(checkSiteDeclaration(decl({ url: "https://autre.example/" }), strict)).toBe(URL_OUTSIDE_DOMAINS);
  expect(checkSiteDeclaration(decl({ url: "https://www.vidola-a.example/" }), strict)).toBeNull();
  expect(checkSiteDeclaration(decl({ url: "https://xvidola-a.example/" }), strict)).toBe(URL_OUTSIDE_DOMAINS);
});

test("js accepts only .js and .mjs, css only .css; ./ and // refused", () => {
  const r = (tweak: object) => DeclarationSite.safeParse({ ...vidola, tweaks: [{ matches: ["/*"], ...tweak }] }).success;
  expect(r({ js: ["a.mjs"] })).toBe(true);
  expect(r({ js: ["a.css"] })).toBe(false);
  expect(r({ css: ["a.js"] })).toBe(false);
  for (const p of ["./a.js", "a//b.js", "/a.js"]) expect(r({ js: [p] }), p).toBe(false);
  expect(r({ css: ["./a.css"] })).toBe(false);
});

test("ID_SITE: lowercase, digits, dashes, 60 at most", () => {
  for (const ok of ["vidola", "a", "mon-site-2", "x".repeat(60)]) expect(ID_SITE.test(ok), ok).toBe(true);
  for (const ko of ["MonSite", "a_b", "a.b", "-a", "", "x".repeat(61), "a b"]) expect(ID_SITE.test(ko), ko).toBe(false);
});

test("checkSiteDeclaration: domains and login without IP, local address or dotless name", () => {
  for (const d of ["localhost", "127.0.0.1", "192.168.1.1", "com", "monsite", "intranet.local", "exemple.123"]) {
    expect(checkSiteDeclaration(decl({ domains: ["vidola-a.example", d] }), strict), d).toBe(INVALID_DOMAIN);
    expect(checkSiteDeclaration(decl({ login: [d] }), strict), d).toBe(INVALID_DOMAIN);
  }
  expect(checkSiteDeclaration(decl({ login: ["accounts.google.com"] }), strict)).toBeNull();
  const test_ = decl({ url: "http://vidola-a.localhost:5000/", domains: ["vidola-a.localhost"], urlTracking: undefined });
  expect(checkSiteDeclaration(test_, { localAddresses: true })).toBeNull();
  expect(checkSiteDeclaration(decl({ domains: ["vidola-a.example", "127.0.0.1"] }), { localAddresses: true })).toBe(INVALID_DOMAIN);
  expect(checkSiteDeclaration(decl({ domains: ["vidola-a.example", "localhost"] }), { localAddresses: true })).toBe(INVALID_DOMAIN);
});
