import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extraireResultats, urlRecherche } from "../../src/workflows/duckduckgo.js";

const page = (nom: string) => readFileSync(new URL(`./fixtures/duckduckgo/${nom}`, import.meta.url), "utf8");

describe("extraireResultats", () => {
  it("resultats.html: 9 results in order, the ad dropped, javascript: dropped, uddg decoded, entities decoded", () => {
    const r = extraireResultats(page("resultats.html"), 20);
    if (!("resultats" in r)) throw new Error("attendu : des résultats");
    expect(r.resultats).toHaveLength(9);
    expect(r.resultats.map((x) => x.url)).not.toContain("https://annonce.example/pub");
    expect(r.resultats.some((x) => x.url.startsWith("javascript:"))).toBe(false);
    expect(r.resultats[0]).toEqual({
      titre: "Fiabilité Clio 4 : avis et défauts",
      url: "https://www.example.fr/clio-4/fiabilite?a=1&b=2",
      extrait: "Tous les avis sur la fiabilité de la Clio 4, moteur par moteur.",
    });
    expect(r.resultats[1]!.titre).toBe(`Clio 4 <dCi> & "essais" l'avis`);
    expect(r.resultats[2]!.url).toBe("https://direct.example.org/page");
    expect(r.resultats[3]!.titre).toBe("Quatrième résultat");
    expect(new Set(r.resultats.map((x) => x.url)).size).toBe(9);
  });

  it("nombre 3: the first 3", () => {
    const tous = extraireResultats(page("resultats.html"), 20);
    const trois = extraireResultats(page("resultats.html"), 3);
    if (!("resultats" in tous) || !("resultats" in trois)) throw new Error("attendu");
    expect(trois.resultats).toEqual(tous.resultats.slice(0, 3));
  });

  it("aucun-resultat.html: empty list", () => {
    expect(extraireResultats(page("aucun-resultat.html"), 5)).toEqual({ resultats: [] });
  });

  it("verification.html : refus", () => {
    expect(extraireResultats(page("verification.html"), 5)).toEqual({ refus: true });
  });

  it("changee.html : illisible", () => {
    expect(extraireResultats(page("changee.html"), 5)).toEqual({ illisible: true });
  });

  it("duplicate urls are dropped", () => {
    const bloc = (u: string) => `<div class="result"><a class="result__a" href="${u}">T</a><a class="result__snippet">E</a></div>`;
    const r = extraireResultats(bloc("https://a.example/") + bloc("https://a.example/") + bloc("https://b.example/"), 5);
    if (!("resultats" in r)) throw new Error("attendu");
    expect(r.resultats.map((x) => x.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("a 5,000-character title is cut to 300", () => {
    const html = `<div class="result results_links"><a class="result__a" href="https://x.example/">${"a".repeat(5000)}</a>
      <a class="result__snippet" href="#">${"b".repeat(3000)}</a></div>`;
    const r = extraireResultats(html, 5);
    if (!("resultats" in r)) throw new Error("attendu");
    expect(r.resultats[0]!.titre.length).toBe(300);
    expect(r.resultats[0]!.extrait.length).toBe(1000);
  });
});

describe("extraireResultats: hostile pages and edge cases", () => {
  const bloc = (titre: string, href = "https://a.example/", extrait = "E") =>
    `<div class="result"><a class="result__a" href="${href}">${titre}</a><a class="result__snippet">${extrait}</a></div>`;
  const rapide = (html: string) => {
    const t = Date.now();
    const r = extraireResultats(html, 5);
    expect(Date.now() - t).toBeLessThan(200);
    return r;
  };

  it("24 KB of « <div class=\" » repeated after a result: fast", () => {
    rapide(bloc("T") + '<div class="'.repeat(2000));
  });
  it("54 KB of unclosed result__snippet tags: fast", () => {
    rapide('<div class="result"><a class="result__a" href="https://a.example/">T</a>' + '<p class="result__snippet" '.repeat(2000));
    rapide('<div class="result"><a class="result__a" href="https://a.example/">T</a>' + '<p class="result__snippet">'.repeat(2000));
  });
  it("a 5 MB page is read without freezing", () => {
    rapide("<".repeat(5 * 1024 * 1024));
    rapide(bloc("T") + "<a ".repeat(1_000_000));
  });
  it("« anomaly-modal » in a title or an excerpt is not a refusal", () => {
    const r = extraireResultats(bloc("anomaly-modal challenge-form /anomaly.js", "https://a.example/", "challenge-form"), 5);
    expect(r).toMatchObject({ resultats: [{ url: "https://a.example/" }] });
  });
  it("real results win over a no-results marker; exact no-results only", () => {
    expect(extraireResultats('<div class="no-results"></div>' + bloc("T"), 5)).toMatchObject({ resultats: [{ titre: "T" }] });
    expect(extraireResultats('<div class="not-no-results"></div>', 5)).toEqual({ illisible: true });
  });
  it("the url is normalized: controls removed, non-http(s) and credentials refused", () => {
    const u = (v: string) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(v)}`;
    const r = extraireResultats(
      bloc("a", u("https://x.fr/a%0Ab")) + bloc("b", u("ftp://x.fr/")) + bloc("c", u("https://u:p@x.fr/")) + bloc("d", "//exemple.fr/"),
      9,
    );
    expect(r).toEqual({ resultats: [{ titre: "a", url: "https://x.fr/a%0Ab", extrait: "E" }] });
  });
  it("title and excerpt: controls, bidi and half-pairs removed", () => {
    const r = extraireResultats(bloc("A&#8238;B&#x0;C&#xD800;D&#10;E", "https://a.example/", "x&#x202E;y"), 5);
    expect(r).toMatchObject({ resultats: [{ titre: "A BCD E", extrait: "x y" }] });
  });
  it("an excerpt with a nested tag of the same name is not cut", () => {
    const html = '<div class="result"><a class="result__a" href="https://a.example/">T</a><span class="result__snippet">un <span>deux</span> trois</span></div>';
    expect(extraireResultats(html, 5)).toMatchObject({ resultats: [{ extrait: "un deux trois" }] });
  });
});

describe("urlRecherche", () => {
  it("encodes « fiabilité Clio 4 »", () => {
    expect(urlRecherche("fiabilité Clio 4")).toBe("https://html.duckduckgo.com/html/?q=fiabilit%C3%A9%20Clio%204");
    expect(urlRecherche("a b", "http://127.0.0.1:1/")).toBe("http://127.0.0.1:1/?q=a%20b");
  });
});
