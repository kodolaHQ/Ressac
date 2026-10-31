import { expect, test } from "vitest";
import {
  ADRESSE_HORS_DOMAINES,
  CADRES_MOTIFS,
  CORRESPOND_CHEMIN,
  DeclarationSite,
  HTTPS_SEULEMENT,
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

test("l'exemple Vidola (domaines, suiviAdresse, retouches avec cadres, reprise) est accepté", () => {
  const r = DeclarationSite.safeParse(vidola);
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.connexion).toEqual([]);
});

test("l'exemple YouTube (connexion, retouche css qui cache les Shorts) est accepté", () => {
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
  expect(messages({ ...vidola, retouches: [{ correspond: ["series/*"] }] })).toContain(CORRESPOND_CHEMIN);
});

test("un chemin de retouche avec .. ou absolu est refusé", () => {
  for (const js of ["../x.js", "a/../x.js", "/x.js"]) {
    expect(DeclarationSite.safeParse({ ...vidola, retouches: [{ correspond: ["/*"], js: [js] }] }).success, js).toBe(false);
  }
  expect(DeclarationSite.safeParse({ ...vidola, retouches: [{ correspond: ["/*"], js: ["x.txt"] }] }).success).toBe(false);
});

test("une clé inconnue (permissions) est refusée", () => {
  expect(DeclarationSite.safeParse({ ...vidola, permissions: ["tout"] }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, suiviAdresse: { page: "https://a.example/", motif: "ab", x: 1 } }).success).toBe(false);
});

test('21 domaines, "*.x.com", "X.com:443", un schéma refusés', () => {
  const vingtEtUn = Array.from({ length: 21 }, (_, i) => `s${i}.example`);
  expect(DeclarationSite.safeParse({ ...vidola, domaines: vingtEtUn }).success).toBe(false);
  for (const d of ["*.x.com", "X.com:443", "https://x.com", "x.com/", ""]) {
    expect(DeclarationSite.safeParse({ ...vidola, domaines: [d] }).success, d).toBe(false);
  }
  expect(DeclarationSite.safeParse({ ...vidola, domaines: [] }).success).toBe(false);
});

test("nom, motif de suivi, icône", () => {
  expect(DeclarationSite.safeParse({ ...vidola, nom: "" }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, nom: "x".repeat(61) }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, suiviAdresse: { page: "https://a.example/", motif: "a" } }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, icone: "icone.png" }).success).toBe(true);
  expect(DeclarationSite.safeParse({ ...vidola, icone: "../icone.png" }).success).toBe(false);
  expect(DeclarationSite.safeParse({ ...vidola, icone: "icone.gif" }).success).toBe(false);
});

const decl = (patch: Record<string, unknown>) => DeclarationSite.parse({ ...vidola, ...patch });
const strict = { adressesLocales: false };

test("verifierDeclarationSite : https seulement, jamais une adresse locale", () => {
  expect(verifierDeclarationSite(decl({}), strict)).toBeNull();
  expect(verifierDeclarationSite(decl({ adresse: "http://vidola-a.example/" }), strict)).toBe(HTTPS_SEULEMENT);
  expect(verifierDeclarationSite(decl({ adresse: "https://192.168.1.2/", domaines: ["192.168.1.2"] }), strict)).toBe(HTTPS_SEULEMENT);
  expect(verifierDeclarationSite(decl({ suiviAdresse: { page: "http://adresses.example/", motif: "vidola" } }), strict)).toBe(HTTPS_SEULEMENT);
  expect(verifierDeclarationSite(decl({ suiviAdresse: { page: "https://127.0.0.1/", motif: "vidola" } }), strict)).toBe(HTTPS_SEULEMENT);
});

test("verifierDeclarationSite : avec adressesLocales, http d'un hôte local est permis", () => {
  const d = decl({ adresse: "http://vidola-a.localhost:5000/", domaines: ["vidola-a.localhost"], suiviAdresse: { page: "http://adresses.localhost:5001/", motif: "vidola" } });
  expect(verifierDeclarationSite(d, { adressesLocales: true })).toBeNull();
  expect(verifierDeclarationSite(d, strict)).toBe(HTTPS_SEULEMENT);
  // http d'un hôte public reste refusé.
  expect(verifierDeclarationSite(decl({ adresse: "http://vidola-a.example/" }), { adressesLocales: true })).toBe(HTTPS_SEULEMENT);
});

test("verifierDeclarationSite : domaine de l'adresse", () => {
  expect(verifierDeclarationSite(decl({ adresse: "https://autre.example/" }), strict)).toBe(ADRESSE_HORS_DOMAINES);
  expect(verifierDeclarationSite(decl({ adresse: "https://www.vidola-a.example/" }), strict)).toBeNull();
  expect(verifierDeclarationSite(decl({ adresse: "https://xvidola-a.example/" }), strict)).toBe(ADRESSE_HORS_DOMAINES);
});
