// B7 C7.9 I1: isBlockedAddress, the text rule of the UI's network guard (chrome globals stubbed: the module registers nothing at import).
import { writeFileSync } from "node:fs";
test("isBlockedAddress", async () => {
  const g = globalThis as any;
  g.Components = { ID: (x: string) => x };
  g.ChromeUtils = { generateQI: () => () => null };
  const ui = await import("../../../../apps/firefox/chrome/store/ui-network.ts");
  const rows = ["http://x/", "https://x/", "HTTPS://x/", "ws://x/", "wss://x/", "view-source:https://x/", "view-source:view-source:http://x/", "VIEW-SOURCE:https://x/", "jar:https://x/a.zip!/b", "moz-remote-image://?url=https%3A%2F%2Fx%2F", "about:reader?url=https%3A%2F%2Fx%2F", "page-icon:https://x/", "moz-page-thumb://thumbnails/?url=https%3A%2F%2Fx", "cached-favicon:https://x/favicon.ico", "blob:https://x/uuid", "data:text/html,<img src=https://x/>", "ftp://x/", "file:///etc/hosts", "mailto:a@b.c", "resource://gre/", "chrome://browser/content/", "moz-extension://uuid/x", " https://x/", "feed:https://x/"]
    .map((u) => ({ id: "I1", input: u, outcome: ui.isBlockedAddress(u) ? "blocked" : "passes" }));
  writeFileSync(new URL("./results/ui-address.json", import.meta.url), JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(r.input.padEnd(60), r.outcome);
});
