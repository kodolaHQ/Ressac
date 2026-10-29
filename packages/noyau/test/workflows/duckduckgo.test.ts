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

describe("urlRecherche", () => {
  it("encode « fiabilité Clio 4 »", () => {
    expect(urlRecherche("fiabilité Clio 4")).toBe("https://html.duckduckgo.com/html/?q=fiabilit%C3%A9%20Clio%204");
    expect(urlRecherche("a b", "http://127.0.0.1:1/")).toBe("http://127.0.0.1:1/?q=a%20b");
  });
});
