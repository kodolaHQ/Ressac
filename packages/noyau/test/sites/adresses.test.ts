import { describe, expect, it } from "vitest";
import {
  adresseDeDepart, adresseRelative, adresseSurDomaine, correspondMotif, domainesEffectifs, hoteDansSite, retouchesPour,
  trouverAdresse, type EtatAdresse,
} from "../../src/sites/adresses.js";
import type { DeclarationSite } from "../../src/sites/schemas.js";

const decl: DeclarationSite = {
  nom: "Vidola", description: "", adresse: "https://www.vidola-a.example/accueil", domaines: ["vidola-a.example"],
  connexion: [], retouches: [
    { correspond: ["/series/*"], js: ["a.js"], css: [], cadres: false },
    { correspond: ["/film/*"], js: [], css: ["b.css"], cadres: ["https://*.clipsy.*/*"] },
  ], reprise: false,
};
const etat: EtatAdresse = { actuel: "vidola-b.example", anciens: ["vidola-a.example"], depuis: null };

describe("hoteDansSite", () => {
  it("exact, sous-domaine, sans casse, point final", () => {
    expect(hoteDansSite("www.vidola-a.example", ["vidola-a.example"])).toBe(true);
    expect(hoteDansSite("vidola-a.example.evil.com", ["vidola-a.example"])).toBe(false);
    expect(hoteDansSite("VIDOLA-A.EXAMPLE.", ["vidola-a.example"])).toBe(true);
    expect(hoteDansSite("xvidola-a.example", ["vidola-a.example"])).toBe(false);
  });
});

describe("domaines effectifs et départ", () => {
  it("union sans doublon", () => {
    expect(domainesEffectifs(decl, null)).toEqual(["vidola-a.example"]);
    expect(domainesEffectifs(decl, etat)).toEqual(["vidola-a.example", "vidola-b.example"]);
  });
  it("départ : hôte remplacé par l'actuel quand il a changé", () => {
    expect(adresseDeDepart(decl, null)).toBe("https://www.vidola-a.example/accueil");
    expect(adresseDeDepart(decl, etat)).toBe("https://vidola-b.example/accueil");
    expect(adresseDeDepart(decl, { actuel: "vidola-a.example", anciens: [], depuis: null })).toBe("https://www.vidola-a.example/accueil");
  });
});

describe("adresseRelative", () => {
  it("chemin + requête sans #", () => {
    expect(adresseRelative("https://www.vidola-a.example/serie/the-bear?s=2#t", ["vidola-a.example"])).toBe("/serie/the-bear?s=2");
    expect(adresseRelative("https://pub.example/x", ["vidola-a.example"])).toBeNull();
    expect(adresseRelative("pas une url", ["vidola-a.example"])).toBeNull();
  });
});

describe("adresseSurDomaine", () => {
  const dom = ["vidola-a.example", "vidola-b.example"];
  const depart = "https://vidola-b.example/accueil";
  const o = { adressesLocales: false };
  it("un actuel en écriture numérique d'une adresse locale garde l'hôte du départ", () => {
    expect(adresseSurDomaine("/x", "0x7f.1", dom, depart, o)).toBe("https://vidola-b.example/x");
    expect(adresseSurDomaine("/x", "2130706433", dom, depart, o)).toBe("https://vidola-b.example/x");
  });
  it("relative rendue sur le domaine actuel", () => {
    expect(adresseSurDomaine("/serie/x", "vidola-b.example", dom, depart, o)).toBe("https://vidola-b.example/serie/x");
  });
  it("absolue sur l'ancien domaine passe sur l'actuel", () => {
    expect(adresseSurDomaine("https://www.vidola-a.example/serie/x?a=1", "vidola-b.example", dom, depart, o)).toBe("https://vidola-b.example/serie/x?a=1");
  });
  it("le reste est refusé", () => {
    for (const a of ["javascript:alert(1)", "//pub.example/x", "https://pub.example/", "/\\pub.example", "http://vidola-a.example/x", "https://u:p@vidola-a.example/", "", "x"])
      expect(adresseSurDomaine(a, "vidola-b.example", dom, depart, o)).toBeNull();
  });
  it("http non local refusé même en test ; actuel invalide : hôte du départ", () => {
    const t = { adressesLocales: true };
    expect(adresseSurDomaine("http://vidola-a.example/x", "vidola-b.example", dom, "http://vidola-b.example/", t)).toBeNull();
    expect(adresseSurDomaine("/x", "evil.com/@x", dom, depart, o)).toBe("https://vidola-b.example/x");
    expect(adresseSurDomaine("/x", "127.0.0.1", dom, depart, o)).toBe("https://vidola-b.example/x");
    expect(adresseSurDomaine("/x", "", dom, depart, o)).toBe("https://vidola-b.example/x");
  });
  it("garde schéma et port du départ (tests)", () => {
    const d = "http://vidola-b.localhost:4321/";
    expect(adresseSurDomaine("http://vidola-a.localhost:9/s", "vidola-b.localhost", ["vidola-a.localhost", "vidola-b.localhost"], d, { adressesLocales: true }))
      .toBe("http://vidola-b.localhost:4321/s");
  });
});

describe("correspondMotif", () => {
  it("joker ancré", () => {
    expect(correspondMotif("/series/*", "/series/the-bear?e=4")).toBe(true);
    expect(correspondMotif("/series/*", "/x/series/a")).toBe(false);
    expect(correspondMotif("/a.b", "/axb")).toBe(false);
    expect(correspondMotif("https://*.clipsy.*/*", "https://www.clipsy.io/embed-1")).toBe(true);
    expect(correspondMotif("https://*.clipsy.*/*", "https://clipsy.io.evil.com/")).toBe(false);
    expect(correspondMotif("https://*.clipsy.*/*", "https://x.clipsy.evil.com/")).toBe(true);
  });
  it("sensible à la casse sauf l'hôte", () => {
    expect(correspondMotif("/Series/*", "/series/a")).toBe(false);
    expect(correspondMotif("https://Lecteur.Example/*", "https://lecteur.example/A")).toBe(true);
  });
});

describe("correspondMotif, cas hostiles", () => {
  const m = "https://*.clipsy.*/*";
  it("le joker de l'hôte ne passe ni / ? @ :", () => {
    expect(correspondMotif(m, "https://evil.com/a.clipsy.b/z")).toBe(false);
    expect(correspondMotif(m, "https://evil.com/?r=.clipsy.x/")).toBe(false);
    expect(correspondMotif(m, "https://x.clipsy.io@evil.com/")).toBe(false);
    expect(correspondMotif(m, "https://u:p@x.clipsy.io/")).toBe(false);
    expect(correspondMotif(m, "http://x.clipsy.io/")).toBe(false);
  });
  it("jokers multiples sans retour arrière catastrophique", () => {
    const t0 = performance.now();
    expect(correspondMotif("*a".repeat(8) + "b", "a".repeat(60))).toBe(false);
    expect(correspondMotif("https://" + "*a".repeat(8) + "b/*", "https://" + "a".repeat(60) + "/")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("domaines Unicode", () => {
  it("normalisés en punycode", () => {
    expect(hoteDansSite("www.xn--bcher-kva.example", ["bücher.example"])).toBe(true);
    expect(hoteDansSite("www.bücher.example", ["bücher.example"])).toBe(true);
    expect(domainesEffectifs({ ...decl, domaines: ["Bücher.example"] }, null)).toEqual(["xn--bcher-kva.example"]);
  });
});

describe("retouchesPour", () => {
  const dom = ["vidola-a.example", "vidola-b.example"];
  it("principal : motif de chemin sur tout domaine effectif", () => {
    expect(retouchesPour(decl, { url: "https://vidola-a.example/series/x", principal: true }, dom)).toEqual([decl.retouches[0]]);
    expect(retouchesPour(decl, { url: "https://vidola-b.example/film/1?a=2", principal: true }, dom)).toEqual([decl.retouches[1]]);
    expect(retouchesPour(decl, { url: "https://pub.example/series/x", principal: true }, dom)).toEqual([]);
    expect(retouchesPour(decl, { url: "https://vidola-a.example/autre", principal: true }, dom)).toEqual([]);
  });
  it("refuse http (hors test local), identifiants", () => {
    expect(retouchesPour(decl, { url: "http://vidola-a.example/series/x", principal: true }, dom)).toEqual([]);
    expect(retouchesPour(decl, { url: "https://u:p@vidola-a.example/series/x", principal: true }, dom)).toEqual([]);
    expect(retouchesPour(decl, { url: "http://x.clipsy.io/e", principal: false }, dom)).toEqual([]);
    const loc = { ...decl, domaines: ["a.localhost"] };
    expect(retouchesPour(loc, { url: "http://a.localhost:5/series/x", principal: true }, ["a.localhost"], { adressesLocales: true })).toEqual([decl.retouches[0]]);
    expect(retouchesPour(loc, { url: "http://a.localhost:5/series/x", principal: true }, ["a.localhost"])).toEqual([]);
  });
  it("sous-cadre : seulement avec cadres", () => {
    expect(retouchesPour(decl, { url: "https://www.clipsy.io/embed-1", principal: false }, dom)).toEqual([decl.retouches[1]]);
    expect(retouchesPour(decl, { url: "https://lecteur.example/x", principal: false }, dom)).toEqual([]);
    expect(retouchesPour(decl, { url: "https://vidola-a.example/series/x", principal: false }, dom)).toEqual([]);
  });
});

describe("trouverAdresse", () => {
  const o = { page: "https://ww1.vidola-adresses.example/", motif: "vidola", adressesLocales: false };
  it("premier lien sûr dont l'hôte contient le motif", () => {
    expect(trouverAdresse([
      "/contact", "https://ww1.vidola-adresses.example/a", "https://sous.ww1.vidola-adresses.example/b", "http://vidola.voyage",
      "https://127.0.0.1/vidola", "https://tiers.example/vidola", "javascript:vidola", "https://u:p@vidola.fr/", "https://VIDOLA.voyage/accueil",
    ], o)).toEqual({ hostname: "vidola.voyage", origine: "https://vidola.voyage/", port: null });
  });
  it("aucun candidat", () => {
    expect(trouverAdresse(["/x", "https://tiers.example/vidola"], o)).toBeNull();
    expect(trouverAdresse([], o)).toBeNull();
    expect(trouverAdresse(["https://x.example/"], { ...o, page: "pas une url" })).toBeNull();
  });
  it("exclut le domaine parent de la page ; hostname propre, sans port ni point final", () => {
    expect(trouverAdresse(["https://vidola-adresses.example/"], o)).toBeNull();
    expect(trouverAdresse(["https://vidola.voyage.:8443/x"], o)).toEqual({ hostname: "vidola.voyage", origine: "https://vidola.voyage/", port: null });
    expect(trouverAdresse(["/\\vidola.voyage", "//vidola.voyage/"], o)).toBeNull();
  });
  it("adresses locales seulement en test", () => {
    expect(trouverAdresse(["https://vidola-b.localhost/"], o)).toBeNull();
    expect(trouverAdresse(["http://vidola-b.localhost:8/x"], { ...o, page: "http://adresses.localhost:8/", adressesLocales: true })).toEqual({ hostname: "vidola-b.localhost", origine: "http://vidola-b.localhost:8/", port: "8" });
  });
});
