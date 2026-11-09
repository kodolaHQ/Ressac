import { expect, test } from "vitest";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";

test("lecture.html returns the URL's HTML and records the call", async () => {
  const bridge = new FakeBridge([], {
    active: null,
    allow: false,
    read: { pages: [], html: { "https://html.duckduckgo.com/html/?q=a": "<html>résultats</html>" } },
  });
  expect(await bridge.readHtmlInvisible!("https://html.duckduckgo.com/html/?q=a", {})).toEqual({
    url: "https://html.duckduckgo.com/html/?q=a",
    html: "<html>résultats</html>",
  });
  expect(await bridge.readHtmlInvisible!("https://autre.test/", { localAddresses: true })).toEqual({ url: "https://autre.test/", html: "" });
  expect(bridge.calls.filter((a) => a.method === "lireHtmlInvisible").map((a) => a.args)).toEqual([
    ["https://html.duckduckgo.com/html/?q=a", {}],
    ["https://autre.test/", { localAddresses: true }],
  ]);
});
