import { expect, test } from "vitest";
import { rankLinks, unwrapLink, withoutTracking, isGoogleGoto } from "../../src/mcp/links.js";

test("unwrapLink decodes DuckDuckGo and Google result redirects, nothing else", () => {
  expect(unwrapLink("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fex.fr%2Fa&rut=x")).toBe("https://ex.fr/a");
  expect(unwrapLink("https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fex.fr%2Fa")).toBe("https://ex.fr/a");
  expect(unwrapLink("https://www.google.fr/url?q=https%3A%2F%2Fex.fr%2Fb&sa=U")).toBe("https://ex.fr/b");
  expect(unwrapLink("https://google.com/url?q=https%3A%2F%2Fex.fr%2Fb")).toBe("https://ex.fr/b");
  // Google's current result shape: the target in `url=`, `q=` empty or absent.
  expect(unwrapLink("https://www.google.com/url?sa=t&q=&url=https%3A%2F%2Fex.fr%2Fc&ved=2ahUKEwj&usg=AOvVaw")).toBe("https://ex.fr/c");
  expect(unwrapLink("https://www.google.com/url?sa=t&source=web&url=https%3A%2F%2Fex.fr%2Fc")).toBe("https://ex.fr/c");
  for (const h of ["www.google.fr", "www.google.co.uk", "www.google.com.br", "google.de"]) {
    expect(unwrapLink(`https://${h}/url?q=https%3A%2F%2Fex.fr%2Fb`)).toBe("https://ex.fr/b");
  }
  for (const u of [
    "https://google.abc.de/url?q=https%3A%2F%2Fex.fr%2Fb",
    "https://www.google.evil.fr/url?q=https%3A%2F%2Fex.fr%2Fb",
    "https://google.com.evil.fr/url?q=https%3A%2F%2Fex.fr%2Fb",
    "https://evil.fr/l/?uddg=https%3A%2F%2Fex.fr",
    "https://duckduckgo.com.evil.fr/l/?uddg=https%3A%2F%2Fex.fr",
    "https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)",
    "https://www.google.fr/search?q=x",
    "https://www.google.fr/url?url=javascript%3Aalert(1)",
    "https://www.google.fr/search?url=https%3A%2F%2Fex.fr",
  ])
    expect(unwrapLink(u)).toBe(u);
});

test("rankLinks: main first, then other, nav, footer; document order within a zone", () => {
  const r = rankLinks(
    [
      { text: "Mentions", url: "https://ex.fr/legal", zone: "footer" },
      { text: "Accueil", url: "https://ex.fr/", zone: "nav" },
      { text: "Article", url: "https://ex.fr/art", zone: "main" },
      { text: "Ailleurs", url: "https://ex.fr/x" },
      { text: "Suite", url: "https://ex.fr/suite", zone: "main" },
    ],
    "https://ex.fr/page",
  );
  expect(r.map((l) => l.text)).toEqual(["Article", "Suite", "Ailleurs", "Accueil", "Mentions"]);
});

test("rankLinks: copies of one address collapse to one, at their best zone; self and empty links go", () => {
  const wrapped = `https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://ex.fr/a")}`;
  const r = rankLinks(
    [
      { text: "Menu A", url: "https://ex.fr/a", zone: "nav" },
      { text: "Lire A", url: wrapped, zone: "main" },
      { text: "Commentaires", url: "https://ex.fr/a#comments", zone: "main" },
      { text: "Ici", url: "https://ex.fr/page#top", zone: "main" },
      { text: "  ", url: "https://ex.fr/b", zone: "main" },
    ],
    "https://ex.fr/page",
  );
  expect(r).toEqual([{ text: "Lire A", url: "https://ex.fr/a", zone: "main" }]);
});

test("rankLinks: copies of one address keep the photo of either", () => {
  const links = [
    { text: "Yuba", url: "https://ex.fr/a", zone: "main" as const },
    { text: "Photo de Yuba", url: "https://ex.fr/a", zone: "main" as const, image: "https://img.fr/a.jpg" },
    { text: "Tern", url: "https://ex.fr/b", zone: "nav" as const, image: "https://img.fr/b.jpg" },
    { text: "Tern", url: "https://ex.fr/b", zone: "main" as const },
  ];
  expect(rankLinks(links, "https://ex.fr/")).toEqual([
    { text: "Yuba", url: "https://ex.fr/a", zone: "main", image: "https://img.fr/a.jpg" },
    { text: "Tern", url: "https://ex.fr/b", zone: "main", image: "https://img.fr/b.jpg" },
  ]);
});

test("tracking parameters are dropped from a link (Google's srsltid, utm_*…), every other parameter kept", () => {
  expect(unwrapLink("https://getressac.app/?srsltid=AfmBOooTx4pV9yP8vX3kQwZ2mN7bH5cRfL1sJ6dG0eYtU")).toBe("https://getressac.app/");
  expect(unwrapLink("https://ex.fr/a?id=42&utm_source=x&UTM_Medium=y&fbclid=z#top")).toBe("https://ex.fr/a?id=42#top");
  expect(unwrapLink("https://www.google.com/url?q=https%3A%2F%2Fex.fr%2Fb%3Fgclid%3Dabc%26p%3D1")).toBe("https://ex.fr/b?p=1");
  // A look-alike name is no tracker; an address without any stays the same string.
  expect(withoutTracking("https://ex.fr/?utmost=1&source=2")).toBe("https://ex.fr/?utmost=1&source=2");
  expect(withoutTracking("pas une adresse")).toBe("pas une adresse");
  expect(rankLinks([{ text: "Ressac", url: "https://getressac.app/?srsltid=abc" }], "https://www.google.com/search?q=ressac").map((l) => l.url)).toEqual(["https://getressac.app/"]);
  // A page opened with trackers is still itself: its link to itself stays out.
  expect(rankLinks([{ text: "Accueil", url: "https://ex.fr/" }], "https://ex.fr/?utm_source=a")).toEqual([]);
});

test("isGoogleGoto: Google's own https /goto link only, never a look-alike", () => {
  expect(isGoogleGoto(new URL("https://www.google.com/goto?url=CAES&gsessionid=x"))).toBe(true);
  for (const u of ["https://google.com@evil.test/goto?url=x", "http://www.google.com/goto?url=x", "https://www.google.com/goto/?url=x", "https://www.google.com/GOTO?url=x", "https://www.google.com.evil.test/goto?url=x", "https://www.google.com/goto?q=x"])
    expect(isGoogleGoto(new URL(u)), u).toBe(false);
});
