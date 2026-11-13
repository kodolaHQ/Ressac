import { expect, test } from "vitest";
import type { PageBlock, TabRead } from "../../src/mcp/bridge.js";
import { pageState, reducedPage, stateLine, structuredPairs } from "../../src/mcp/reduce.js";

const body = (text: string, zone: PageBlock["zone"] = "main"): PageBlock => ({ text, h: 0, zone });
const page = (blocks: PageBlock[], more: Partial<TabRead> = {}): TabRead => ({ text: blocks.map((b) => b.text).join("\n"), blocks, status: 200, ...more });

test("pageState from the status, the content type and what the page shows", () => {
  const url = "https://ex.fr/p";
  expect(pageState(page([body("x".repeat(100))], { status: 404 }), url)).toBe("introuvable");
  expect(pageState(page([body("x".repeat(100))], { status: 410 }), url)).toBe("introuvable");
  expect(pageState(page([body("x".repeat(100))], { status: 403 }), url)).toBe("bloquée");
  expect(pageState(page([body("x".repeat(100))], { status: 429 }), url)).toBe("bloquée");
  expect(pageState(page([body("Vérifiez que vous êtes humain avant de continuer. " + "x".repeat(700))]), url)).toBe("bloquée");
  const captchas = page([body("Les captcha et les pages access denied expliqués. " + "y".repeat(20_000))]);
  expect(pageState(captchas, url)).toBe("ok");
  expect(pageState(page([body("Identifiez-vous pour continuer. " + "z".repeat(100))], { passwords: 1 }), url)).toBe("connexion demandée");
  expect(pageState(page([body("Bienvenue " + "z".repeat(100))], { redirects: ["https://ex.fr/compte"] }), "https://ex.fr/login?next=/compte")).toBe("connexion demandée");
  expect(pageState(page([body("Rechercher sur le site. Connexion. " + "z".repeat(200))]), url)).toBe("ok");
  expect(pageState({ text: "Rapport 2025 …", contentType: "application/pdf", status: 200 }, url)).toBe("pdf");
  expect(pageState(page([body("Rien")]), url)).toBe("vide");
});

test("a short results page with a result about captchas is a page of links, not a check", () => {
  const links = Array.from({ length: 12 }, (_, i) => ({ text: i === 3 ? "Les captchas expliqués" : `Résultat ${i}`, url: `https://ex.fr/${i}` }));
  expect(pageState(page([body("Résultats pour captcha. Les captchas expliqués. Résultat 1. Résultat 2.")], { links }), "https://duckduckgo.com/html?q=captcha")).toBe("ok");
});

test("a login path must be a whole path segment, on a short page", () => {
  const p = page([body("Notre offre fibre en détail. " + "z".repeat(100))], { redirects: ["http://ex.fr/connexion-internet-fibre"] });
  expect(pageState(p, "https://ex.fr/connexion-internet-fibre")).toBe("ok");
  expect(pageState(p, "https://ex.fr/login-tips")).toBe("ok");
  expect(pageState(p, "https://ex.fr/auth/")).toBe("connexion demandée");
  expect(pageState(page([body("Un long article. " + "z".repeat(5000))], { redirects: ["https://ex.fr/a"] }), "https://ex.fr/login")).toBe("ok");
});

test("stateLine names the state and the status when known", () => {
  expect(stateLine(page([body("x".repeat(100))], { status: 403 }), "https://ex.fr/")).toBe("État : bloquée (403)");
  expect(stateLine({ text: "x".repeat(100) }, "https://ex.fr/")).toBe("État : ok");
});

test("structuredPairs flattens a product's JSON-LD, drops images and context, keeps 20 pairs", () => {
  const pairs = structuredPairs([{ "@context": "https://schema.org", "@type": "Product", name: "Lampe Orbe", image: "https://ex.fr/i.jpg", offers: { price: "49.90", priceCurrency: "EUR" } }]);
  expect(pairs).toContain("name : Lampe Orbe");
  expect(pairs).toContain("offers.price : 49.90");
  expect(pairs.join("\n")).not.toMatch(/image|@context/);
  expect(structuredPairs(Array.from({ length: 500 }, (_, i) => ({ [`k${i}`]: "v" })))).toHaveLength(20);
  expect(structuredPairs([{ long: "x".repeat(1000) }])).toEqual([]);
});

test("reducedPage keeps the lead and the passages that share words with the question, in page order, within the budget", () => {
  const blocks: PageBlock[] = [];
  for (let i = 0; i < 30; i++) {
    blocks.push({ text: `Section ${i}`, h: 2, zone: "main" });
    blocks.push(body(i === 17 ? "La lampe Orbe coûte 49,90 € en boutique. " + "w".repeat(400) : `Paragraphe sans rapport numéro ${i}. ` + "v".repeat(400)));
  }
  const r = reducedPage(page(blocks, { structured: [{ "@type": "Product", name: "Lampe Orbe" }] }), "prix de la lampe orbe", 3000);
  expect(r.text.length).toBeLessThanOrEqual(3000);
  expect(r.text.startsWith("Données structurées :\nname : Lampe Orbe")).toBe(true);
  expect(r.text).toContain("## Section 0");
  expect(r.text).toContain("49,90 €");
  expect(r.text.indexOf("## Section 0")).toBeLessThan(r.text.indexOf("49,90 €"));
  expect(r.total).toBe(30);
  expect(r.shown).toBeLessThan(30);
});

test("reducedPage gives a short page whole; reader text keeps the main blocks, else nav, footer, header and lang go", () => {
  const blocks = [body("Accueil Produits Contact", "nav"), body("Le texte de l'article, assez long pour compter. " + "a".repeat(600)), body("Mentions légales", "footer")];
  const plain = reducedPage(page(blocks), "article", 8000);
  expect(plain.text).toContain("Le texte de l'article");
  expect(plain.text).not.toContain("Mentions légales");
  expect(plain.text).not.toContain("Accueil Produits");
  const read = reducedPage(page(blocks, { reader: "Le texte de l'article, assez long pour compter. " + "a".repeat(900) }), "article", 8000);
  expect(read.text).toContain("Le texte de l'article");
  expect(read.text).not.toContain("Mentions légales");
  // Menus only: dropping them would leave nothing, they stay.
  expect(reducedPage(page([body("Accueil Produits Contact", "nav")]), "x", 8000).text).toContain("Accueil");
});

test("reducedPage without blocks (a PDF, an older browser) reads the text by paragraphs", () => {
  const r = reducedPage({ text: "Rapport annuel\n\nLa coopérative compte 1 284 membres.\n\nLe chiffre d'affaires atteint 3,7 millions.", contentType: "application/pdf" }, "membres", 8000);
  expect(r.text).toContain("1 284 membres");
  expect(r.text).toContain("3,7 millions");
});
