import { expect, test } from "vitest";
import { accordCouvre, accordNecessaire, DeclarationSite, type RetouchesLues } from "@webaios/noyau";
import { CONSOLE_RETOUCHES_TOTAL, type InjectionCadre } from "../../src/commun/sites";
import { ajouterConsoleRetouche, injectionPour, repriseDansCadre, type SiteOuvrable } from "../../src/main/sites/injection";

const GARDE = "/* garde */";
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
const site: SiteOuvrable = {
  id: "vidola",
  declaration,
  aAccueil: false,
  // vidola-a : l'ancien domaine ; vidola-b : l'actuel (adresse.json du profil).
  domaines: ["vidola-a.example", "vidola-b.example"],
  depart: "https://vidola-b.example/",
  accordRequis: false,
};
const retouches: RetouchesLues = { js: { "a.js": "window.a = 1", "lecteur.js": "window.l = 1" }, css: { "a.css": ".shorts{display:none}" } };
const avec = (accorde = true) => ({ site, retouches, accorde, garde: GARDE });
/** La page principale de la vue, sur le site : celle des sous-cadres. */
const PAGE = "https://vidola-b.example/series/x";

test("sans accord : null", () => {
  expect(injectionPour(avec(false), { url: "https://vidola-b.example/series/x", principal: true })).toBeNull();
  expect(injectionPour(avec(false), { url: "https://www.lecteur.example/v", principal: false, page: PAGE })).toBeNull();
});

test("cadre principal sur /series/x : js et css de la retouche, pont vrai, hotes des domaines effectifs", () => {
  const i = injectionPour(avec(), { url: "https://vidola-b.example/series/x", principal: true });
  expect(i).toEqual({
    css: [".shorts{display:none}"],
    js: [{ code: "window.a = 1", nom: "webaios-retouche://vidola/a.js" }],
    garde: GARDE,
    hotes: ["https://*.vidola-a.example/*", "https://vidola-a.example/*", "https://*.vidola-b.example/*", "https://vidola-b.example/*"],
    pont: true,
    reprise: true,
  } satisfies InjectionCadre);
});

test("cadre principal sur l'ancien domaine : mêmes retouches", () => {
  const actuel = injectionPour(avec(), { url: "https://vidola-b.example/series/x", principal: true });
  const ancien = injectionPour(avec(), { url: "https://www.vidola-a.example/series/x", principal: true });
  expect(ancien).toEqual(actuel);
});

test("cadre principal sur une page sans retouche : ni garde ni script, le pont reste", () => {
  const i = injectionPour(avec(), { url: "https://vidola-b.example/films", principal: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
  expect(i.garde).toBeNull();
  expect(i.reprise).toBe(true);
});

test("sous-cadre lecteur.localhost hors des motifs cadres déclarés : rien, pas même la reprise", () => {
  const i = injectionPour(avec(), { url: "https://lecteur.localhost/v", principal: false, page: PAGE });
  expect(i).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
  const sansReprise = injectionPour({ ...avec(), site: { ...site, declaration: { ...declaration, reprise: false } } }, { url: "https://lecteur.localhost/v", principal: false, page: PAGE });
  expect(sansReprise?.reprise).toBe(false);
});

test("sous-cadre qui correspond à cadres : js, pont faux", () => {
  const i = injectionPour(avec(), { url: "https://www.lecteur.example/v/1", principal: false, page: PAGE })!;
  expect(i.js).toEqual([{ code: "window.l = 1", nom: "webaios-retouche://vidola/lecteur.js" }]);
  expect(i.garde).toBe(GARDE);
  expect(i.pont).toBe(false);
  expect(i.hotes).toEqual(["https://www.lecteur.example/*"]);
  // Le motif de la page principale ne vaut jamais pour un sous-cadre (même sur le site).
  expect(injectionPour(avec(), { url: "https://vidola-b.example/series/x", principal: false, page: PAGE })?.js).toEqual([]);
});

test("tests seulement : un sous-cadre http local correspond aux motifs https (le serveur de test n'a pas de TLS)", () => {
  const motif = { ...declaration, retouches: [{ correspond: ["/rien"], js: ["lecteur.js"], css: [], cadres: ["https://lecteur.localhost:8080/*"] }] };
  const o = { ...avec(), site: { ...site, declaration: motif } };
  const cadre = { url: "http://lecteur.localhost:8080/v", principal: false, page: PAGE };
  expect(injectionPour({ ...o, adressesLocales: true }, cadre)?.js).toHaveLength(1);
  expect(injectionPour(o, cadre)?.js ?? []).toEqual([]);
});

test("page hors site (connexion) : aucune retouche", () => {
  const i = injectionPour(avec(), { url: "https://compte.example/series/x", principal: true });
  expect(i).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
  for (const url of ["about:blank", "javascript:alert(1)", "https://pub.example/series/x", ""]) {
    expect(injectionPour(avec(), { url, principal: true })?.js ?? []).toEqual([]);
    expect(injectionPour(avec(), { url, principal: true })?.pont ?? false).toBe(false);
  }
});

test("page principale sur un domaine de connexion : ses sous-cadres ne reçoivent rien (ni retouche ni reprise), même ceux des motifs cadres", () => {
  const lecteur = { url: "https://www.lecteur.example/v/1", principal: false };
  expect(injectionPour(avec(), { ...lecteur, page: "https://vidola-b.example/series/x" })!.js).toHaveLength(1);
  for (const page of ["https://compte.example/connexion", "https://pub.example/", null]) {
    expect(injectionPour(avec(), { ...lecteur, page })).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
  }
});

test("un fichier cité mais absent du cache n'est pas injecté", () => {
  const i = injectionPour({ ...avec(), retouches: { js: {}, css: {} } }, { url: "https://vidola-b.example/series/x", principal: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
});

test("un accord qui couvre moins de droits que la déclaration (cadres ajoutés) : aucune injection", () => {
  const plus = DeclarationSite.parse({ ...declaration, retouches: [...declaration.retouches, { correspond: ["/x"], cadres: ["https://*.autre.example/*"] }] });
  const accord = { domaines: ["vidola-a.example"], connexion: ["compte.example"], cadres: ["https://*.lecteur.example/*"], reprise: true };
  // Ce que fait le service : accorde = !accordRequis, accordRequis = accordNecessaire && !accordCouvre.
  const requis = accordNecessaire(plus) && !accordCouvre(accord, plus);
  expect(requis).toBe(true);
  const o = { ...avec(!requis), site: { ...site, declaration: plus, accordRequis: requis } };
  expect(injectionPour(o, { url: "https://vidola-b.example/series/x", principal: true })).toBeNull();
  expect(injectionPour(o, { url: "https://www.lecteur.example/v", principal: false, page: PAGE })).toBeNull();
  // Avec l'ancienne déclaration, le même accord suffit.
  expect(accordCouvre(accord, declaration)).toBe(true);
});

test("console des retouches : texte tronqué à 2000 caractères, source à 500, total borné, 50 au plus, jamais vérifiée", () => {
  const l: ReturnType<typeof ajouterConsoleRetouche> = [];
  ajouterConsoleRetouche(l, { texte: "a".repeat(10_000), source: "webaios-retouche://vidola/" + "b".repeat(1000) }, "t");
  expect(l[0]!.texte).toHaveLength(2000);
  expect(l[0]!.source).toHaveLength(500);
  expect(l[0]!.sourceVerifiee).toBe(false);
  for (let n = 0; n < 100; n++) ajouterConsoleRetouche(l, { texte: `${n}`.padEnd(2000, "x"), source: "s" }, "t");
  expect(l.reduce((t, e) => t + e.texte.length, 0)).toBeLessThanOrEqual(CONSOLE_RETOUCHES_TOTAL);
  expect(l.at(-1)!.texte.startsWith("99")).toBe(true);
  const petits: ReturnType<typeof ajouterConsoleRetouche> = [];
  for (let n = 0; n < 80; n++) ajouterConsoleRetouche(petits, { texte: `${n}`, source: "s" }, "t");
  expect(petits).toHaveLength(50);
  expect(petits[0]!.texte).toBe("30");
});

test("motifs cadres déclarés : la reprise ne va que dans le cadre principal et les cadres qui leur correspondent ; sans motif, partout", () => {
  const avecCadres = injectionPour(avec(), { url: "https://www.lecteur.example/v", principal: false, page: PAGE })!;
  expect(avecCadres.reprise).toBe(true);
  expect(injectionPour(avec(), { url: "https://ads.pub.example/v", principal: false, page: PAGE })!.reprise).toBe(false);
  expect(injectionPour(avec(), { url: "https://vidola-b.example/episode/4", principal: true })!.reprise).toBe(true);
  expect(repriseDansCadre(declaration, { url: "https://ads.pub.example/v", principal: false })).toBe(false);
  const sansCadres = DeclarationSite.parse({ ...declaration, retouches: [{ correspond: ["/series/*"], js: ["a.js"] }] });
  expect(repriseDansCadre(sansCadres, { url: "https://ads.pub.example/v", principal: false })).toBe(true);
  expect(repriseDansCadre({ ...sansCadres, reprise: false }, { url: "https://vidola-b.example/", principal: true })).toBe(false);
  // Tests : un lecteur http d'un hôte local comparé comme en https.
  const local = DeclarationSite.parse({ ...declaration, retouches: [{ correspond: ["/x"], cadres: ["https://lecteur.localhost:*/*"] }] });
  expect(repriseDansCadre(local, { url: "http://lecteur.localhost:4000/v", principal: false }, true)).toBe(true);
  expect(repriseDansCadre(local, { url: "http://pub.localhost:4000/v", principal: false }, true)).toBe(false);
});
