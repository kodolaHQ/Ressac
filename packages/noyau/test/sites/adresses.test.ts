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
  it("exact, subdomain, case-insensitive, trailing dot", () => {
    expect(hoteDansSite("www.vidola-a.example", ["vidola-a.example"])).toBe(true);
    expect(hoteDansSite("vidola-a.example.evil.com", ["vidola-a.example"])).toBe(false);
    expect(hoteDansSite("VIDOLA-A.EXAMPLE.", ["vidola-a.example"])).toBe(true);
    expect(hoteDansSite("xvidola-a.example", ["vidola-a.example"])).toBe(false);
  });
});

describe("effective domains and start", () => {
  it("union without duplicates", () => {
    expect(domainesEffectifs(decl, null)).toEqual(["vidola-a.example"]);
    expect(domainesEffectifs(decl, etat)).toEqual(["vidola-a.example", "vidola-b.example"]);
  });
  it("start: host replaced by the current one when it changed", () => {
    expect(adresseDeDepart(decl, null)).toBe("https://www.vidola-a.example/accueil");
    expect(adresseDeDepart(decl, etat)).toBe("https://vidola-b.example/accueil");
    expect(adresseDeDepart(decl, { actuel: "vidola-a.example", anciens: [], depuis: null })).toBe("https://www.vidola-a.example/accueil");
  });
});

describe("adresseRelative", () => {
  it("path + query without #", () => {
    expect(adresseRelative("https://www.vidola-a.example/serie/the-bear?s=2#t", ["vidola-a.example"])).toBe("/serie/the-bear?s=2");
    expect(adresseRelative("https://pub.example/x", ["vidola-a.example"])).toBeNull();
    expect(adresseRelative("pas une url", ["vidola-a.example"])).toBeNull();
  });
});

describe("adresseSurDomaine", () => {
  const dom = ["vidola-a.example", "vidola-b.example"];
  const depart = "https://vidola-b.example/accueil";
  const o = { adressesLocales: false };
  it("a current one in numeric notation of a local address keeps the start's host", () => {
    expect(adresseSurDomaine("/x", "0x7f.1", dom, depart, o)).toBe("https://vidola-b.example/x");
    expect(adresseSurDomaine("/x", "2130706433", dom, depart, o)).toBe("https://vidola-b.example/x");
  });
  it("relative returned on the current domain", () => {
    expect(adresseSurDomaine("/serie/x", "vidola-b.example", dom, depart, o)).toBe("https://vidola-b.example/serie/x");
  });
  it("absolute on the old domain moves to the current one", () => {
    expect(adresseSurDomaine("https://www.vidola-a.example/serie/x?a=1", "vidola-b.example", dom, depart, o)).toBe("https://vidola-b.example/serie/x?a=1");
  });
  it("the rest is refused", () => {
    for (const a of ["javascript:alert(1)", "//pub.example/x", "https://pub.example/", "/\\pub.example", "http://vidola-a.example/x", "https://u:p@vidola-a.example/", "", "x"])
      expect(adresseSurDomaine(a, "vidola-b.example", dom, depart, o)).toBeNull();
  });
  it("non-local http refused even in test; invalid current: start's host", () => {
    const t = { adressesLocales: true };
    expect(adresseSurDomaine("http://vidola-a.example/x", "vidola-b.example", dom, "http://vidola-b.example/", t)).toBeNull();
    expect(adresseSurDomaine("/x", "evil.com/@x", dom, depart, o)).toBe("https://vidola-b.example/x");
    expect(adresseSurDomaine("/x", "127.0.0.1", dom, depart, o)).toBe("https://vidola-b.example/x");
    expect(adresseSurDomaine("/x", "", dom, depart, o)).toBe("https://vidola-b.example/x");
  });
  it("keeps the start's scheme and port (tests)", () => {
    const d = "http://vidola-b.localhost:4321/";
    expect(adresseSurDomaine("http://vidola-a.localhost:9/s", "vidola-b.localhost", ["vidola-a.localhost", "vidola-b.localhost"], d, { adressesLocales: true }))
      .toBe("http://vidola-b.localhost:4321/s");
  });
});

describe("correspondMotif", () => {
  it("anchored wildcard", () => {
    expect(correspondMotif("/series/*", "/series/the-bear?e=4")).toBe(true);
    expect(correspondMotif("/series/*", "/x/series/a")).toBe(false);
    expect(correspondMotif("/a.b", "/axb")).toBe(false);
    expect(correspondMotif("https://*.clipsy.*/*", "https://www.clipsy.io/embed-1")).toBe(true);
    expect(correspondMotif("https://*.clipsy.*/*", "https://clipsy.io.evil.com/")).toBe(false);
    expect(correspondMotif("https://*.clipsy.*/*", "https://x.clipsy.evil.com/")).toBe(true);
  });
  it("case-sensitive except the host", () => {
    expect(correspondMotif("/Series/*", "/series/a")).toBe(false);
    expect(correspondMotif("https://Lecteur.Example/*", "https://lecteur.example/A")).toBe(true);
  });
});

describe("correspondMotif, cas hostiles", () => {
  const m = "https://*.clipsy.*/*";
  it("the host's wildcard does not pass / ? @ :", () => {
    expect(correspondMotif(m, "https://evil.com/a.clipsy.b/z")).toBe(false);
    expect(correspondMotif(m, "https://evil.com/?r=.clipsy.x/")).toBe(false);
    expect(correspondMotif(m, "https://x.clipsy.io@evil.com/")).toBe(false);
    expect(correspondMotif(m, "https://u:p@x.clipsy.io/")).toBe(false);
    expect(correspondMotif(m, "http://x.clipsy.io/")).toBe(false);
  });
  it("multiple wildcards without catastrophic backtracking", () => {
    const t0 = performance.now();
    expect(correspondMotif("*a".repeat(8) + "b", "a".repeat(60))).toBe(false);
    expect(correspondMotif("https://" + "*a".repeat(8) + "b/*", "https://" + "a".repeat(60) + "/")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("domaines Unicode", () => {
  it("normalized to punycode", () => {
    expect(hoteDansSite("www.xn--bcher-kva.example", ["bücher.example"])).toBe(true);
    expect(hoteDansSite("www.bücher.example", ["bücher.example"])).toBe(true);
    expect(domainesEffectifs({ ...decl, domaines: ["Bücher.example"] }, null)).toEqual(["xn--bcher-kva.example"]);
  });
});

describe("retouchesPour", () => {
  const dom = ["vidola-a.example", "vidola-b.example"];
  it("main: path pattern on any effective domain", () => {
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
  it("subframe: only with frames", () => {
    expect(retouchesPour(decl, { url: "https://www.clipsy.io/embed-1", principal: false }, dom)).toEqual([decl.retouches[1]]);
    expect(retouchesPour(decl, { url: "https://lecteur.example/x", principal: false }, dom)).toEqual([]);
    expect(retouchesPour(decl, { url: "https://vidola-a.example/series/x", principal: false }, dom)).toEqual([]);
  });
});

describe("trouverAdresse: a real domain name", () => {
  const o = { page: "https://adresses.example/", motif: "vidola", adressesLocales: false };
  it("without a dot (intranet) or whose last label is numeric: refused, as in site.json", () => {
    for (const lien of ["https://vidola/", "https://vidola-box/", "https://vidola.1/", "https://vidola.12/"]) {
      expect(trouverAdresse([lien], o), lien).toBeNull();
    }
    expect(trouverAdresse(["https://vidola-b.example/"], o)?.hostname).toBe("vidola-b.example");
  });
  it("in test mode, vidola-b.localhost stays allowed, vidola alone does not", () => {
    const t = { ...o, adressesLocales: true };
    expect(trouverAdresse(["http://vidola-b.localhost:80/"], t)?.hostname).toBe("vidola-b.localhost");
    expect(trouverAdresse(["http://vidola/"], t)).toBeNull();
  });
});

describe("trouverAdresse", () => {
  const o = { page: "https://ww1.vidola-adresses.example/", motif: "vidola", adressesLocales: false };
  it("first safe link whose host contains the pattern", () => {
    expect(trouverAdresse([
      "/contact", "https://ww1.vidola-adresses.example/a", "https://sous.ww1.vidola-adresses.example/b", "http://vidola.voyage",
      "https://127.0.0.1/vidola", "https://tiers.example/vidola", "javascript:vidola", "https://u:p@vidola.fr/", "https://VIDOLA.voyage/accueil",
    ], o)).toEqual({ hostname: "vidola.voyage", origine: "https://vidola.voyage/", port: null });
  });
  it("no candidate", () => {
    expect(trouverAdresse(["/x", "https://tiers.example/vidola"], o)).toBeNull();
    expect(trouverAdresse([], o)).toBeNull();
    expect(trouverAdresse(["https://x.example/"], { ...o, page: "pas une url" })).toBeNull();
  });
  it("excludes the page's parent domain; own hostname, without port or trailing dot", () => {
    expect(trouverAdresse(["https://vidola-adresses.example/"], o)).toBeNull();
    expect(trouverAdresse(["https://vidola.voyage.:8443/x"], o)).toEqual({ hostname: "vidola.voyage", origine: "https://vidola.voyage/", port: null });
    expect(trouverAdresse(["/\\vidola.voyage", "//vidola.voyage/"], o)).toBeNull();
  });
  it("adresses locales seulement en test", () => {
    expect(trouverAdresse(["https://vidola-b.localhost/"], o)).toBeNull();
    expect(trouverAdresse(["http://vidola-b.localhost:8/x"], { ...o, page: "http://adresses.localhost:8/", adressesLocales: true })).toEqual({ hostname: "vidola-b.localhost", origine: "http://vidola-b.localhost:8/", port: "8" });
  });
});
