import { expect, test } from "vitest";
import { PontFactice } from "../../src/mcp/pont-factice.js";

test("lecture.html returns the URL's HTML and records the call", async () => {
  const pont = new PontFactice([], {
    actif: null,
    autoriser: false,
    lecture: { pages: [], html: { "https://html.duckduckgo.com/html/?q=a": "<html>résultats</html>" } },
  });
  expect(await pont.lireHtmlInvisible!("https://html.duckduckgo.com/html/?q=a", {})).toEqual({
    url: "https://html.duckduckgo.com/html/?q=a",
    html: "<html>résultats</html>",
  });
  expect(await pont.lireHtmlInvisible!("https://autre.test/", { adressesLocales: true })).toEqual({ url: "https://autre.test/", html: "" });
  expect(pont.appels.filter((a) => a.methode === "lireHtmlInvisible").map((a) => a.args)).toEqual([
    ["https://html.duckduckgo.com/html/?q=a", {}],
    ["https://autre.test/", { adressesLocales: true }],
  ]);
});
