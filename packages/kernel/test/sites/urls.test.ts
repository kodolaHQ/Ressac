import { describe, expect, it } from "vitest";
import {
  startUrl, relativeUrl, urlOnDomain, matchesPattern, effectiveDomains, hostInSite, tweaksFor,
  findUrl, type UrlState,
} from "../../src/sites/urls.js";
import type { DeclarationSite } from "../../src/sites/schemas.js";

const decl: DeclarationSite = {
  name: "Vidola", description: "", url: "https://www.vidola-a.example/accueil", domains: ["vidola-a.example"],
  login: [], tweaks: [
    { matches: ["/series/*"], js: ["a.js"], css: [], frames: false },
    { matches: ["/film/*"], js: [], css: ["b.css"], frames: ["https://*.clipsy.*/*"] },
  ], resume: false,
};
const state: UrlState = { current: "vidola-b.example", previous: ["vidola-a.example"], since: null };

describe("hostInSite", () => {
  it("exact, subdomain, case-insensitive, trailing dot", () => {
    expect(hostInSite("www.vidola-a.example", ["vidola-a.example"])).toBe(true);
    expect(hostInSite("vidola-a.example.evil.com", ["vidola-a.example"])).toBe(false);
    expect(hostInSite("VIDOLA-A.EXAMPLE.", ["vidola-a.example"])).toBe(true);
    expect(hostInSite("xvidola-a.example", ["vidola-a.example"])).toBe(false);
  });
});

describe("effective domains and start", () => {
  it("union without duplicates", () => {
    expect(effectiveDomains(decl, null)).toEqual(["vidola-a.example"]);
    expect(effectiveDomains(decl, state)).toEqual(["vidola-a.example", "vidola-b.example"]);
  });
  it("start: host replaced by the current one when it changed", () => {
    expect(startUrl(decl, null)).toBe("https://www.vidola-a.example/accueil");
    expect(startUrl(decl, state)).toBe("https://vidola-b.example/accueil");
    expect(startUrl(decl, { current: "vidola-a.example", previous: [], since: null })).toBe("https://www.vidola-a.example/accueil");
  });
});

describe("relativeUrl", () => {
  it("path + query without #", () => {
    expect(relativeUrl("https://www.vidola-a.example/serie/the-bear?s=2#t", ["vidola-a.example"])).toBe("/serie/the-bear?s=2");
    expect(relativeUrl("https://pub.example/x", ["vidola-a.example"])).toBeNull();
    expect(relativeUrl("pas une url", ["vidola-a.example"])).toBeNull();
  });
});

describe("urlOnDomain", () => {
  const dom = ["vidola-a.example", "vidola-b.example"];
  const start = "https://vidola-b.example/accueil";
  const o = { localAddresses: false };
  it("a current one in numeric notation of a local address keeps the start's host", () => {
    expect(urlOnDomain("/x", "0x7f.1", dom, start, o)).toBe("https://vidola-b.example/x");
    expect(urlOnDomain("/x", "2130706433", dom, start, o)).toBe("https://vidola-b.example/x");
  });
  it("relative returned on the current domain", () => {
    expect(urlOnDomain("/serie/x", "vidola-b.example", dom, start, o)).toBe("https://vidola-b.example/serie/x");
  });
  it("absolute on the old domain moves to the current one", () => {
    expect(urlOnDomain("https://www.vidola-a.example/serie/x?a=1", "vidola-b.example", dom, start, o)).toBe("https://vidola-b.example/serie/x?a=1");
  });
  it("the rest is refused", () => {
    for (const a of ["javascript:alert(1)", "//pub.example/x", "https://pub.example/", "/\\pub.example", "http://vidola-a.example/x", "https://u:p@vidola-a.example/", "", "x"])
      expect(urlOnDomain(a, "vidola-b.example", dom, start, o)).toBeNull();
  });
  it("non-local http refused even in test; invalid current: start's host", () => {
    const t = { localAddresses: true };
    expect(urlOnDomain("http://vidola-a.example/x", "vidola-b.example", dom, "http://vidola-b.example/", t)).toBeNull();
    expect(urlOnDomain("/x", "evil.com/@x", dom, start, o)).toBe("https://vidola-b.example/x");
    expect(urlOnDomain("/x", "127.0.0.1", dom, start, o)).toBe("https://vidola-b.example/x");
    expect(urlOnDomain("/x", "", dom, start, o)).toBe("https://vidola-b.example/x");
  });
  it("keeps the start's scheme and port (tests)", () => {
    const d = "http://vidola-b.localhost:4321/";
    expect(urlOnDomain("http://vidola-a.localhost:9/s", "vidola-b.localhost", ["vidola-a.localhost", "vidola-b.localhost"], d, { localAddresses: true }))
      .toBe("http://vidola-b.localhost:4321/s");
  });
});

describe("matchesPattern", () => {
  it("anchored wildcard", () => {
    expect(matchesPattern("/series/*", "/series/the-bear?e=4")).toBe(true);
    expect(matchesPattern("/series/*", "/x/series/a")).toBe(false);
    expect(matchesPattern("/a.b", "/axb")).toBe(false);
    expect(matchesPattern("https://*.clipsy.*/*", "https://www.clipsy.io/embed-1")).toBe(true);
    expect(matchesPattern("https://*.clipsy.*/*", "https://clipsy.io.evil.com/")).toBe(false);
    expect(matchesPattern("https://*.clipsy.*/*", "https://x.clipsy.evil.com/")).toBe(true);
  });
  it("case-sensitive except the host", () => {
    expect(matchesPattern("/Series/*", "/series/a")).toBe(false);
    expect(matchesPattern("https://Lecteur.Example/*", "https://lecteur.example/A")).toBe(true);
  });
});

describe("matchesPattern, cas hostiles", () => {
  const m = "https://*.clipsy.*/*";
  it("the host's wildcard does not pass / ? @ :", () => {
    expect(matchesPattern(m, "https://evil.com/a.clipsy.b/z")).toBe(false);
    expect(matchesPattern(m, "https://evil.com/?r=.clipsy.x/")).toBe(false);
    expect(matchesPattern(m, "https://x.clipsy.io@evil.com/")).toBe(false);
    expect(matchesPattern(m, "https://u:p@x.clipsy.io/")).toBe(false);
    expect(matchesPattern(m, "http://x.clipsy.io/")).toBe(false);
  });
  it("multiple wildcards without catastrophic backtracking", () => {
    const t0 = performance.now();
    expect(matchesPattern("*a".repeat(8) + "b", "a".repeat(60))).toBe(false);
    expect(matchesPattern("https://" + "*a".repeat(8) + "b/*", "https://" + "a".repeat(60) + "/")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("domaines Unicode", () => {
  it("normalized to punycode", () => {
    expect(hostInSite("www.xn--bcher-kva.example", ["bücher.example"])).toBe(true);
    expect(hostInSite("www.bücher.example", ["bücher.example"])).toBe(true);
    expect(effectiveDomains({ ...decl, domains: ["Bücher.example"] }, null)).toEqual(["xn--bcher-kva.example"]);
  });
});

describe("tweaksFor", () => {
  const dom = ["vidola-a.example", "vidola-b.example"];
  it("main: path pattern on any effective domain", () => {
    expect(tweaksFor(decl, { url: "https://vidola-a.example/series/x", main: true }, dom)).toEqual([decl.tweaks[0]]);
    expect(tweaksFor(decl, { url: "https://vidola-b.example/film/1?a=2", main: true }, dom)).toEqual([decl.tweaks[1]]);
    expect(tweaksFor(decl, { url: "https://pub.example/series/x", main: true }, dom)).toEqual([]);
    expect(tweaksFor(decl, { url: "https://vidola-a.example/autre", main: true }, dom)).toEqual([]);
  });
  it("refuse http (hors test local), identifiants", () => {
    expect(tweaksFor(decl, { url: "http://vidola-a.example/series/x", main: true }, dom)).toEqual([]);
    expect(tweaksFor(decl, { url: "https://u:p@vidola-a.example/series/x", main: true }, dom)).toEqual([]);
    expect(tweaksFor(decl, { url: "http://x.clipsy.io/e", main: false }, dom)).toEqual([]);
    const loc = { ...decl, domains: ["a.localhost"] };
    expect(tweaksFor(loc, { url: "http://a.localhost:5/series/x", main: true }, ["a.localhost"], { localAddresses: true })).toEqual([decl.tweaks[0]]);
    expect(tweaksFor(loc, { url: "http://a.localhost:5/series/x", main: true }, ["a.localhost"])).toEqual([]);
  });
  it("subframe: only with frames", () => {
    expect(tweaksFor(decl, { url: "https://www.clipsy.io/embed-1", main: false }, dom)).toEqual([decl.tweaks[1]]);
    expect(tweaksFor(decl, { url: "https://lecteur.example/x", main: false }, dom)).toEqual([]);
    expect(tweaksFor(decl, { url: "https://vidola-a.example/series/x", main: false }, dom)).toEqual([]);
  });
});

describe("findUrl: a real domain name", () => {
  const o = { page: "https://adresses.example/", pattern: "vidola", localAddresses: false };
  it("without a dot (intranet) or whose last label is numeric: refused, as in site.json", () => {
    for (const link of ["https://vidola/", "https://vidola-box/", "https://vidola.1/", "https://vidola.12/"]) {
      expect(findUrl([link], o), link).toBeNull();
    }
    expect(findUrl(["https://vidola-b.example/"], o)?.hostname).toBe("vidola-b.example");
  });
  it("in test mode, vidola-b.localhost stays allowed, vidola alone does not", () => {
    const t = { ...o, localAddresses: true };
    expect(findUrl(["http://vidola-b.localhost:80/"], t)?.hostname).toBe("vidola-b.localhost");
    expect(findUrl(["http://vidola/"], t)).toBeNull();
  });
});

describe("findUrl", () => {
  const o = { page: "https://ww1.vidola-adresses.example/", pattern: "vidola", localAddresses: false };
  it("first safe link whose host contains the pattern", () => {
    expect(findUrl([
      "/contact", "https://ww1.vidola-adresses.example/a", "https://sous.ww1.vidola-adresses.example/b", "http://vidola.voyage",
      "https://127.0.0.1/vidola", "https://tiers.example/vidola", "javascript:vidola", "https://u:p@vidola.fr/", "https://VIDOLA.voyage/accueil",
    ], o)).toEqual({ hostname: "vidola.voyage", origin: "https://vidola.voyage/", port: null });
  });
  it("no candidate", () => {
    expect(findUrl(["/x", "https://tiers.example/vidola"], o)).toBeNull();
    expect(findUrl([], o)).toBeNull();
    expect(findUrl(["https://x.example/"], { ...o, page: "pas une url" })).toBeNull();
  });
  it("excludes the page's parent domain; own hostname, without port or trailing dot", () => {
    expect(findUrl(["https://vidola-adresses.example/"], o)).toBeNull();
    expect(findUrl(["https://vidola.voyage.:8443/x"], o)).toEqual({ hostname: "vidola.voyage", origin: "https://vidola.voyage/", port: null });
    expect(findUrl(["/\\vidola.voyage", "//vidola.voyage/"], o)).toBeNull();
  });
  it("adresses locales seulement en test", () => {
    expect(findUrl(["https://vidola-b.localhost/"], o)).toBeNull();
    expect(findUrl(["http://vidola-b.localhost:8/x"], { ...o, page: "http://adresses.localhost:8/", localAddresses: true })).toEqual({ hostname: "vidola-b.localhost", origin: "http://vidola-b.localhost:8/", port: "8" });
  });
});
