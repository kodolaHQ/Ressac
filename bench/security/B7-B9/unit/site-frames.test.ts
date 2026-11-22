// B7 C7.6 F5: the parent's decisions for a site app's frames, with fake WindowGlobalParents (pure functions of chrome/store/site-frames.ts).
import { writeFileSync } from "node:fs";
test("frame decisions", async () => {
  const sf = await import("../../../../apps/firefox/chrome/store/site-frames.ts");
  const rows: { id: string; input: string; outcome: string }[] = [];
  const viewBc = { currentWindowGlobal: { documentURI: { spec: "https://app.example/page" } } };
  const view = { browsingContext: viewBc };
  const site = (grantRequired = false) => ({ site: { id: "app", domains: ["app.example"], grantRequired, declaration: {}, request: {} }, tweaks: { tweaks: [] }, view, errors: [] }) as any;
  const wgp = (url: string, main: boolean) => ({ documentURI: { spec: url }, browsingContext: main ? viewBc : { id: 7 }, innerWindowId: 1 });
  const asked: object[] = [];
  const request = async (p: object) => (asked.push(p), { ok: true } as any);
  const mem = async (label: string, w: any, s: any, req: unknown = { op: "set", key: "k", value: "v" }) => {
    const n = asked.length;
    const r = await sf.frameMemory(w, s, req, request);
    rows.push({ id: "F5", input: label, outcome: asked.length > n ? `passed to the host: ${JSON.stringify(asked.at(-1))}` : `denied (${JSON.stringify(r).slice(0, 60)})` });
  };
  await mem("main document on the app's domain, granted", wgp("https://app.example/page", true), site());
  await mem("an iframe of the app page (same domain)", wgp("https://app.example/frame", false), site());
  await mem("an iframe on another domain", wgp("https://evil.test/", false), site());
  await mem("main document off the domains (a sign-in page)", wgp("https://login.example/oauth", true), site());
  await mem("main document, look-alike domain", wgp("https://app.example.evil.test/", true), site());
  await mem("main document, grant still required", wgp("https://app.example/page", true), site(true));
  await mem("no open app for this frame (a tab, a sign-in window)", wgp("https://app.example/page", true), undefined);
  await mem("main document, about:blank", wgp("about:blank", true), site());
  await mem("main document, data: document", wgp("data:text/html,x", true), site());
  await mem("request that names another app's id and address", wgp("https://app.example/page", true), site(), { op: "set", key: "k", value: "v", id: "other-app", url: "/other" });
  await mem("request not an object", wgp("https://app.example/page", true), site(), "set");
  const other = { ...site(), view: { browsingContext: {} } };
  rows.push({ id: "F2", input: "siteOfFrame: a frame whose top <browser> is not the app's view", outcome: String(sf.siteOfFrame({ browsingContext: { top: { embedderElement: {} } } }, [site(), other]) === undefined ? "no app" : "AN APP") });
  rows.push({ id: "F2", input: "siteOfFrame: a throwing WindowGlobalParent", outcome: String(sf.siteOfFrame({ get browsingContext() { throw new Error("dead"); } }, [site()]) === undefined ? "no app" : "AN APP") });
  const s = site();
  for (const [label, e] of [["own tweak source", { text: "boom", source: "ressac-tweak://app/x.js", line: 3 }], ["another app's tweak source", { text: "boom", source: "ressac-tweak://other/x.js", line: 3 }], ["a look-alike id (app2)", { text: "boom", source: "ressac-tweak://app2/x.js" }], ["a web source", { text: "boom", source: "https://app.example/x.js" }], ["a 1 MB text", { text: "x".repeat(1e6), source: "ressac-tweak://app/x.js" }]] as const) {
    const n = s.errors.length;
    sf.frameError(s, e);
    rows.push({ id: "F4", input: `console message from ${label}`, outcome: s.errors.length > n ? `kept (${String(s.errors.at(-1).text).length} chars)` : "dropped" });
  }
  writeFileSync(new URL("./results/site-frames.json", import.meta.url), JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(r.id, r.input.padEnd(62), r.outcome);
});
