import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { callTool } from "./mcp";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { waitUi } from "./ui";

// The agent's read goes through shadow roots, slots, same-origin frames and PDFs; links come ranked by zone.
let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const html = (body: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
};
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/sommaire.html": html(`<title>Sommaire</title><a href="/ombre.html">Ombre</a><a href="/cadre.html">Cadre</a><a href="/rapport.pdf">Rapport</a><a href="/longue.html">Longue</a>`),
      "/ombre.html": html(`<title>Ombre</title>
<nav><a href="/menu.html">Menu du site</a></nav>
<p>Avant</p><p>Après</p>
<div id="o"></div><div id="c"></div><x-boite>Contenu placé</x-boite>
<div style="display:none">Texte caché display</div><span style="visibility:hidden">Texte caché visibility</span>
<main><a href="/article.html">Article principal</a></main>
<footer><a href="/mentions.html">Mentions légales</a></footer>
<script>
document.getElementById("o").attachShadow({ mode: "open" }).innerHTML = '<p>Texte ombre ouverte</p><a href="/ouverte.html">Lien ombre ouverte</a>';
document.getElementById("c").attachShadow({ mode: "closed" }).innerHTML = '<p>Texte ombre fermée</p><a href="/fermee.html">Lien ombre fermée</a>';
customElements.define("x-boite", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<div>Boîte : <slot></slot></div>"; } });
</script>`),
      "/cadre.html": (req, res) =>
        html(`<title>Cadres</title><p>Page à cadres</p><iframe src="/interne.html"></iframe><iframe src="${server.url.replace("127.0.0.1", "localhost")}/externe.html"></iframe>`)(req, res),
      "/interne.html": html(`<p>Texte cadre interne</p><a href="/interne-lien.html">Lien cadre interne</a>`),
      "/externe.html": html(`<p>Texte cadre externe</p><a href="/externe-lien.html">Lien cadre externe</a>`),
      "/rapport.pdf": (_req, res) => {
        res.setHeader("content-type", "application/pdf");
        res.end(readFileSync(join(import.meta.dirname, "pages", "rapport.pdf")));
      },
      // 5,000 sections, one in ten inside three nested shadow roots: far over the text bound.
      "/longue.html": html(`<title>Longue</title><a href="/article.html">Article</a><div id="r"></div><script>
const r = document.getElementById("r");
for (let i = 0; i < 5000; i++) {
  const s = document.createElement("section");
  const p = "<h2>Section " + i + "</h2><p>" + "Un texte de remplissage assez long pour la page. ".repeat(4) + "</p>";
  if (i % 10) s.innerHTML = p;
  else {
    let root = s.attachShadow({ mode: "open" });
    for (let d = 0; d < 2; d++) { const x = document.createElement("div"); root.append(x); root = x.attachShadow({ mode: "open" }); }
    root.innerHTML = p;
  }
  r.append(s);
}
</script>`),
    },
  });
});
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs({ env: { WEBAIOS_MEMORY_LOOP: "1", WEBAIOS_TEST_SEARCH_URL: `${server.url}/sommaire.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
});
afterEach(() => w?.close());

/** Opens `path` in the search tab (a link of the summary page) and reads it with its links. */
async function read(path: string): Promise<string> {
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "lire" })).text)![1]!;
  expect((await callTool(w.dataDir, "navigate", { id, url: `${server.url}${path}` })).text).toBe(`Onglet ${id} → ${server.url}${path}`);
  return (await callTool(w.dataDir, "read_tab", { id, links: true })).text;
}

it("reads open and closed shadow roots and slotted content, not what is hidden; main links first, blocks apart", async () => {
  const r = await read("/ombre.html");
  for (const s of ["Texte ombre ouverte", "Texte ombre fermée", "Lien ombre ouverte", "Lien ombre fermée", "Contenu placé", "Avant\nAprès"]) expect(r).toContain(s);
  expect(r).not.toContain("Texte caché");
  const list = r.slice(r.indexOf("Liens (numérotés"));
  const at = (s: string) => list.indexOf(s);
  expect(r).toContain(`0. Article principal — ${server.url}/article.html`);
  expect(at("Lien ombre fermée")).toBeLessThan(at("Menu du site"));
  expect(at("Menu du site")).toBeLessThan(at("Mentions légales"));
});

it("reads a same-origin frame, never a frame of another origin", async () => {
  const r = await read("/cadre.html");
  expect(r).toContain("Texte cadre interne");
  expect(r).toContain(`Lien cadre interne — ${server.url}/interne-lien.html`);
  expect(r).not.toContain("cadre externe");
});

it("reads a PDF's text", async () => {
  const r = await read("/rapport.pdf");
  expect(r).toContain("la cooperative compte 1 284 membres");
});

it("a huge page with nested shadow roots is read quickly and bounded", async () => {
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "lire" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/longue.html` });
  const t = Date.now();
  const r = (await callTool(w.dataDir, "read_tab", { id })).text;
  expect(Date.now() - t).toBeLessThan(3000);
  expect(r).toContain("Section 0");
  expect(r).toContain("Section 1\n");
  expect(r.length).toBeLessThan(100_000 + 1_000);
});
