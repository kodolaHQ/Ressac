import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extraireResultats, urlRecherche } from "../../src/workflows/duckduckgo.js";

const page = (nom: string) => readFileSync(new URL(`./fixtures/duckduckgo/${nom}`, import.meta.url), "utf8");

describe("extraireResultats", () => {
  it("resultats.html : 9 résultats dans l'ordre, l'annonce écartée, javascript: écarté, uddg décodé, entités décodées", () => {
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

  it("nombre 3 : les 3 premiers", () => {
    const tous = extraireResultats(page("resultats.html"), 20);
    const trois = extraireResultats(page("resultats.html"), 3);
    if (!("resultats" in tous) || !("resultats" in trois)) throw new Error("attendu");
    expect(trois.resultats).toEqual(tous.resultats.slice(0, 3));
  });

  it("aucun-resultat.html : liste vide", () => {
    expect(extraireResultats(page("aucun-resultat.html"), 5)).toEqual({ resultats: [] });
  });

  it("verification.html : refus", () => {
    expect(extraireResultats(page("verification.html"), 5)).toEqual({ refus: true });
  });

  it("changee.html : illisible", () => {
    expect(extraireResultats(page("changee.html"), 5)).toEqual({ illisible: true });
  });

  it("les doublons d'url sont écartés", () => {
    const bloc = (u: string) => `<div class="result"><a class="result__a" href="${u}">T</a><a class="result__snippet">E</a></div>`;
    const r = extraireResultats(bloc("https://a.example/") + bloc("https://a.example/") + bloc("https://b.example/"), 5);
    if (!("resultats" in r)) throw new Error("attendu");
    expect(r.resultats.map((x) => x.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("un titre de 5 000 caractères est coupé à 300", () => {
    const html = `<div class="result results_links"><a class="result__a" href="https://x.example/">${"a".repeat(5000)}</a>
      <a class="result__snippet" href="#">${"b".repeat(3000)}</a></div>`;
    const r = extraireResultats(html, 5);
    if (!("resultats" in r)) throw new Error("attendu");
    expect(r.resultats[0]!.titre.length).toBe(300);
    expect(r.resultats[0]!.extrait.length).toBe(1000);
  });
});

describe("extraireResultats : pages hostiles et cas limites", () => {
  const bloc = (titre: string, href = "https://a.example/", extrait = "E") =>
    `<div class="result"><a class="result__a" href="${href}">${titre}</a><a class="result__snippet">${extrait}</a></div>`;
  const rapide = (html: string) => {
    const t = Date.now();
    const r = extraireResultats(html, 5);
    expect(Date.now() - t).toBeLessThan(200);
    return r;
  };

  it("24 Ko de « <div class=\" » répétés après un résultat : rapide", () => {
    rapide(bloc("T") + '<div class="'.repeat(2000));
  });
  it("54 Ko de balises result__snippet non fermées : rapide", () => {
    rapide('<div class="result"><a class="result__a" href="https://a.example/">T</a>' + '<p class="result__snippet" '.repeat(2000));
    rapide('<div class="result"><a class="result__a" href="https://a.example/">T</a>' + '<p class="result__snippet">'.repeat(2000));
  });
  it("une page de 5 Mo est lue sans figer", () => {
    rapide("<".repeat(5 * 1024 * 1024));
    rapide(bloc("T") + "<a ".repeat(1_000_000));
  });
  it("« anomaly-modal » dans un titre ou un extrait n'est pas un refus", () => {
    const r = extraireResultats(bloc("anomaly-modal challenge-form /anomaly.js", "https://a.example/", "challenge-form"), 5);
    expect(r).toMatchObject({ resultats: [{ url: "https://a.example/" }] });
  });
  it("de vrais résultats l'emportent sur un marqueur no-results ; no-results exact seulement", () => {
    expect(extraireResultats('<div class="no-results"></div>' + bloc("T"), 5)).toMatchObject({ resultats: [{ titre: "T" }] });
    expect(extraireResultats('<div class="not-no-results"></div>', 5)).toEqual({ illisible: true });
  });
  it("l'url est normalisée : contrôles retirés, non http(s) et identifiants refusés", () => {
    const u = (v: string) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(v)}`;
    const r = extraireResultats(
      bloc("a", u("https://x.fr/a%0Ab")) + bloc("b", u("ftp://x.fr/")) + bloc("c", u("https://u:p@x.fr/")) + bloc("d", "//exemple.fr/"),
      9,
    );
    expect(r).toEqual({ resultats: [{ titre: "a", url: "https://x.fr/a%0Ab", extrait: "E" }] });
  });
  it("titre et extrait : contrôles, bidi et demi-paires retirés", () => {
    const r = extraireResultats(bloc("A&#8238;B&#x0;C&#xD800;D&#10;E", "https://a.example/", "x&#x202E;y"), 5);
    expect(r).toMatchObject({ resultats: [{ titre: "A BCD E", extrait: "x y" }] });
  });
  it("un extrait avec une balise de même nom imbriquée n'est pas coupé", () => {
    const html = '<div class="result"><a class="result__a" href="https://a.example/">T</a><span class="result__snippet">un <span>deux</span> trois</span></div>';
    expect(extraireResultats(html, 5)).toMatchObject({ resultats: [{ extrait: "un deux trois" }] });
  });
});

describe("urlRecherche", () => {
  it("encode « fiabilité Clio 4 »", () => {
    expect(urlRecherche("fiabilité Clio 4")).toBe("https://html.duckduckgo.com/html/?q=fiabilit%C3%A9%20Clio%204");
    expect(urlRecherche("a b", "http://127.0.0.1:1/")).toBe("http://127.0.0.1:1/?q=a%20b");
  });
});
