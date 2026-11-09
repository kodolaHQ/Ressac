import { expect, test } from "vitest";
import {
  URL_OUTSIDE_DOMAINS,
  CADRES_MOTIFS,
  PATH_MATCHES,
  DeclarationSite,
  INVALID_DOMAIN,
  ID_SITE,
  HTTPS_ONLY,
  verifierDeclarationSite,
} from "../../src/sites/schemas.js";

const vidola = {
  nom: "Vidola",
  description: "Séries et films",
  adresse: "https://vidola-a.example/",
  domaines: ["vidola-a.example"],
  suiviAdresse: { page: "https://adresses.example/", motif: "vidola" },
  retouches: [{ correspond: ["/series/*"], js: ["lecteur.js"], css: ["pub.css"], cadres: ["https://*.clipsy.*/*"] }],
  reprise: true,
};

const messages = (v: unknown) => {
  const r = DeclarationSite.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

test("the Vidola example (domains, suiviAdresse, tweaks with frames, reprise) is accepted", () => {
  const r = DeclarationSite.safeParse(vidola);
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.connexion).toEqual([]);
});

test("the YouTube example (login, css tweak that hides Shorts) is accepted", () => {
  const r = DeclarationSite.safeParse({
    nom: "YouTube",
    adresse: "https://www.youtube.com/",
    domaines: ["youtube.com"],
    connexion: ["accounts.google.com"],
    retouches: [{ correspond: ["/*"], css: ["sans-shorts.css"] }],
  });
  expect(r.success).toBe(true);
  if (r.success) {
    expect(r.data.retouches[0]).toMatchObject({ js: [], cadres: false });
    expect(r.data.reprise).toBe(false);
  }
});

test("cadres: true donne CADRES_MOTIFS", () => {
  const m = messages({ ...vidola, retouches: [{ correspond: ["/*"], cadres: true }] });
  expect(m).toContain(CADRES_MOTIFS);
});

test('correspond "series/*" donne CORRESPOND_CHEMIN', () => {
  expect(messages({ ...vidola, retouches: [{ correspond: ["series/*"] }] })).toContain(PATH_MATCHES);
});

test("a tweak path with .. or absolute is refused", () => {
  for (const js of ["../x.js", "a/../x.js", "/x.js"]) {
    expect(DeclarationSite.safeParse({ ...vidola, retouches: [{ correspond: ["/*"], js: [js] }] }).success, js).toBe(false);
  }
  expect(DeclarationSite.safeParse({ ...vidola, retouches: [{ correspond: ["/*"], js: ["x.txt"] }] }).success).toBe(false);
});

test("an unknown key (permissions) is refused", () => {
  expect(DeclarationSite.safeParse({ ...vidola, permissions: ["tout"] }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, suiviAdresse: { page: "https://a.example/", motif: "ab", x: 1 } }).success).toBe(false);
});

test('21 domains, "*.x.com", "X.com:443", a scheme refused', () => {
  const vingtEtUn = Array.from({ length: 21 }, (_, i) => `s${i}.example`);
  expect(DeclarationSite.safeParse({ ...vidola, domaines: vingtEtUn }).success).toBe(false);
  for (const d of ["*.x.com", "X.com:443", "https://x.com", "x.com/", ""]) {
    expect(DeclarationSite.safeParse({ ...vidola, domaines: [d] }).success, d).toBe(false);
  }
  expect(DeclarationSite.safeParse({ ...vidola, domaines: [] }).success).toBe(false);
});

test("name, tracking pattern, icon", () => {
  expect(DeclarationSite.safeParse({ ...vidola, nom: "" }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, nom: "x".repeat(61) }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, suiviAdresse: { page: "https://a.example/", motif: "a" } }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, icone: "icone.png" }).success).toBe(true);
  expect(DeclarationSite.safeParse({ ...vidola, icone: "../icone.png" }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, icone: "icone.gif" }).success).toBe(false);
});

const decl = (patch: Record<string, unknown>) => DeclarationSite.parse({ ...vidola, ...patch });
const strict = { adressesLocales: false };

test("verifierDeclarationSite: https only, never a local address", () => {
  expect(verifierDeclarationSite(decl({}), strict)).toBeNull();
  expect(verifierDeclarationSite(decl({ adresse: "http://vidola-a.example/" }), strict)).toBe(HTTPS_ONLY);
  expect(verifierDeclarationSite(decl({ adresse: "https://192.168.1.2/", domaines: ["192.168.1.2"] }), strict)).toBe(HTTPS_ONLY);
  expect(verifierDeclarationSite(decl({ suiviAdresse: { page: "http://adresses.example/", motif: "vidola" } }), strict)).toBe(HTTPS_ONLY);
  expect(verifierDeclarationSite(decl({ suiviAdresse: { page: "https://127.0.0.1/", motif: "vidola" } }), strict)).toBe(HTTPS_ONLY);
});

test("verifierDeclarationSite: with adressesLocales, http of a local host is allowed", () => {
  const d = decl({ adresse: "http://vidola-a.localhost:5000/", domaines: ["vidola-a.localhost"], suiviAdresse: { page: "http://adresses.localhost:5001/", motif: "vidola" } });
  expect(verifierDeclarationSite(d, { adressesLocales: true })).toBeNull();
  expect(verifierDeclarationSite(d, strict)).toBe(HTTPS_ONLY);
  // http of a public host stays refused.
  expect(verifierDeclarationSite(decl({ adresse: "http://vidola-a.example/" }), { adressesLocales: true })).toBe(HTTPS_ONLY);
});

test("verifierDeclarationSite : domaine de l'adresse", () => {
  expect(verifierDeclarationSite(decl({ adresse: "https://autre.example/" }), strict)).toBe(URL_OUTSIDE_DOMAINS);
  expect(verifierDeclarationSite(decl({ adresse: "https://www.vidola-a.example/" }), strict)).toBeNull();
  expect(verifierDeclarationSite(decl({ adresse: "https://xvidola-a.example/" }), strict)).toBe(URL_OUTSIDE_DOMAINS);
});

test("js accepts only .js and .mjs, css only .css; ./ and // refused", () => {
  const r = (retouche: object) => DeclarationSite.safeParse({ ...vidola, retouches: [{ correspond: ["/*"], ...retouche }] }).success;
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

test("verifierDeclarationSite: domains and login without IP, local address or dotless name", () => {
  for (const d of ["localhost", "127.0.0.1", "192.168.1.1", "com", "monsite", "intranet.local", "exemple.123"]) {
    expect(verifierDeclarationSite(decl({ domaines: ["vidola-a.example", d] }), strict), d).toBe(INVALID_DOMAIN);
    expect(verifierDeclarationSite(decl({ connexion: [d] }), strict), d).toBe(INVALID_DOMAIN);
  }
  expect(verifierDeclarationSite(decl({ connexion: ["accounts.google.com"] }), strict)).toBeNull();
  const test_ = decl({ adresse: "http://vidola-a.localhost:5000/", domaines: ["vidola-a.localhost"], suiviAdresse: undefined });
  expect(verifierDeclarationSite(test_, { adressesLocales: true })).toBeNull();
  expect(verifierDeclarationSite(decl({ domaines: ["vidola-a.example", "127.0.0.1"] }), { adressesLocales: true })).toBe(INVALID_DOMAIN);
  expect(verifierDeclarationSite(decl({ domaines: ["vidola-a.example", "localhost"] }), { adressesLocales: true })).toBe(INVALID_DOMAIN);
});
