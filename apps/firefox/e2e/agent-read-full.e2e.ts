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
/** Same site as `server` (same address), another origin (another port): its frame shares the page's process. */
let other: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const html = (body: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
};
beforeAll(async () => {
  other = await startServer({ routes: { "/externe.html": html(`<p>Texte cadre autre port</p><a href="/autre-lien.html">Lien cadre autre port</a>`) } });
  server = await startServer({
    routes: {
      "/sommaire.html": html(`<title>Sommaire</title><a href="/ombre.html">Ombre</a><a href="/cadre.html">Cadre</a><a href="/rapport.pdf">Rapport</a><a href="/longue.html">Longue</a><a href="/faux-pdf.html">Faux</a><a href="/pdf-bloque.html">Bloque</a><a href="/menus.html">Menus</a><a href="/profonde.html">Profonde</a>`),
      "/ombre.html": html(`<title>Ombre</title>
<nav><a href="/menu.html">Menu du site</a></nav>
<p>Avant</p><p>Après</p>
<pre>ligne 1
  ligne 2</pre>
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
        html(`<title>Cadres</title><p>Page à cadres</p><iframe src="/interne.html"></iframe><iframe src="${server.url.replace("127.0.0.1", "localhost")}/externe.html"></iframe><iframe src="${other.url}/externe.html"></iframe>`)(req, res),
      "/interne.html": html(`<p>Texte cadre interne</p><a href="/interne-lien.html">Lien cadre interne</a>`),
      "/externe.html": html(`<p>Texte cadre externe</p><a href="/externe-lien.html">Lien cadre externe</a>`),
      // Pages pretending to be the PDF viewer: one would replace the text read, the other would never answer.
      "/faux-pdf.html": html(`<p>Texte réel</p><script>window.PDFViewerApplication = { pdfDocument: { numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "Texte falsifié" }] }) }) } };</script>`),
      "/pdf-bloque.html": html(`<p>Texte réel</p><script>window.PDFViewerApplication = { pdfDocument: { numPages: 1, getPage: () => new Promise(() => {}) } };</script>`),
      // A page-wide class that looks like a menu, then 600 header links before the content's.
      "/menus.html": html(`<title>Menus</title><body class="has-main-navigation"><header>${Array.from({ length: 600 }, (_, i) => `<a href="/m${i}.html">Menu ${i}</a>`).join("")}</header>
<div><a href="/contenu.html">Contenu libre</a></div><main><a href="/article.html">Article principal</a></main></body>`),
      // Far deeper than any real page: the read must still answer.
      "/profonde.html": html(`<p>Début profond</p><div id="d"></div><script>let e = document.getElementById("d"); for (let i = 0; i < 50000; i++) { const x = document.createElement("div"); e.append(x); e = x; } e.textContent = "Fond";</script>`),
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
afterAll(() => Promise.all([server?.close(), other?.close()]));
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
  for (const s of ["ligne 1\n  ligne 2", "Texte ombre ouverte", "Texte ombre fermée", "Lien ombre ouverte", "Lien ombre fermée", "Contenu placé", "Avant\nAprès"]) expect(r).toContain(s);
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
  expect(r).not.toContain("autre port");
});

it("reads a PDF's text", async () => {
  const r = await read("/rapport.pdf");
  expect(r).toContain("la cooperative compte 1 284 membres");
  // The read takes the PDF path only for a document of this type.
  expect(await m.execute("return gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec.endsWith('/rapport.pdf')).linkedBrowser.documentContentType")).toBe("application/pdf");
});

it("a page posing as the PDF viewer neither replaces the text read nor holds the read", async () => {
  expect(await read("/faux-pdf.html")).toContain("Texte réel");
  expect(await read("/faux-pdf.html")).not.toContain("falsifié");
  const t = Date.now();
  expect(await read("/pdf-bloque.html")).toContain("Texte réel");
  expect(Date.now() - t).toBeLessThan(15_000);
});

it("page-wide menu classes and 600 header links do not hide the content's links", async () => {
  const r = await read("/menus.html");
  expect(r).toContain(`0. Article principal — ${server.url}/article.html`);
  const list = r.slice(r.indexOf("Liens (numérotés"));
  expect(list.indexOf("Contenu libre")).toBeGreaterThan(0);
  expect(list.indexOf("Contenu libre")).toBeLessThan(list.indexOf("Menu 0"));
});

it("a page nested far too deep is still read", async () => {
  const r = await read("/profonde.html");
  expect(r).toContain("Début profond");
  expect(r).not.toContain("Erreur");
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
