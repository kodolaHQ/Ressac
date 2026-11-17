import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { callTool } from "./mcp";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { agentPanelReady } from "./ui";

// The agent's read goes through shadow roots, slots, same-origin frames and PDFs; links come ranked by zone.
let server: Awaited<ReturnType<typeof startServer>>;
/** Same site as `server` (same address), another origin (another port): its frame shares the page's process. */
let other: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
/** /bloque.html answers 403 (a check page) until a test lets it through. */
let blocked = true;
const html = (body: string) => (_req: unknown, res: import("node:http").ServerResponse) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
};
beforeAll(async () => {
  other = await startServer({ routes: { "/externe.html": html(`<p>Texte cadre autre port</p><a href="/autre-lien.html">Lien cadre autre port</a>`) } });
  server = await startServer({
    routes: {
      "/sommaire.html": html(`<title>Sommaire</title><a href="/ombre.html">Ombre</a><a href="/cadre.html">Cadre</a><a href="/rapport.pdf">Rapport</a><a href="/longue.html">Longue</a><a href="/faux-pdf.html">Faux</a><a href="/pdf-bloque.html">Bloque</a><a href="/menus.html">Menus</a><a href="/profonde.html">Profonde</a><a href="/piege.html">Piège</a><a href="/produit.html">Produit</a><a href="/absente.html">Absente</a><a href="/bloque.html">Bloque</a><a href="/connexion.html">Connexion</a><a href="/captchas.html">Captchas</a><a href="/code.html">Code</a><a href="/invisibles.html">Invisibles</a><a href="/sombre.html">Sombre</a><a href="/liste.html">Liste</a>`),
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
      // Text a person cannot see: white on white and 1 px, off screen, 2 px.
      "/piege.html": html(`<title>Radio</title><main><h1>Radio</h1><p>La radio capte la FM et le DAB+.</p>
<p style="color:#fff;font-size:1px">Marqueur blanc minuscule.</p><div style="position:absolute;left:-9999px">Marqueur hors écran.</div><p style="font-size:2px">Marqueur deux pixels.</p>
<h2>Dimensions</h2><p>22 × 12 × 9 cm, 850 g.</p></main>`),
      "/produit.html": html(`<title>Lampe</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Lampe Orbe","offers":{"price":"49.90","priceCurrency":"EUR"}}</script><main><h1>Lampe Orbe</h1><p>Une lampe ronde en verre soufflé, pour le salon ou la chambre.</p></main>`),
      "/absente.html": (_req, res) => {
        res.statusCode = 404;
        html(`<title>Absente</title><p>Cette page n'existe pas ou plus, désolé pour la gêne.</p>`)(_req, res);
      },
      "/bloque.html": (_req, res) => {
        if (blocked) res.statusCode = 403;
        html(blocked ? `<title>Vérification</title><p>Vérifiez que vous êtes humain.</p>` : `<title>Débloquée</title><p>La page est enfin là, avec tout son texte utile.</p>`)(_req, res);
      },
      "/connexion.html": html(`<title>Compte</title><p>Identifiez-vous pour lire la suite de cet article.</p><form><input name="u"><input type="password" name="p"></form>`),
      "/captchas.html": html(`<title>Captchas</title><article><h1>Les captchas expliqués</h1>${"<p>Un captcha vérifie que vous êtes humain ; une page access denied refuse l'accès. Voici comment ils marchent.</p>".repeat(200)}</article>`),
      // Highlighted code: its spaces and line breaks are text nodes of their own, between the coloured pieces.
      "/code.html": html(`<title>Code</title><main><h2>Exemple<span class="mw-editsection"><a href="/modifier.html">modifier</a></span></h2>
<pre><span>public</span> <span>class</span> <span>A</span> {
  <span>// rien</span>
  <span>int</span> x;
}</pre><p><b>mot</b> <i>suivant</i></p><p><a href="/lie.html">Article lié</a></p></main>`),
      // Transparent text, links a person cannot see, microdata text; visible gradient text and white text on a dark gradient.
      "/invisibles.html": html(`<title>Invisibles</title><main><h1>Lecteur</h1><p>Un lecteur de musique pour la cuisine, simple et robuste.</p>
<p style="color:transparent">Marqueur transparent.</p>
<p style="background:linear-gradient(red,blue);background-clip:text;color:transparent">Titre dégradé visible</p>
<div style="background:linear-gradient(#000,#222)"><p style="color:#fff">Texte sur fond sombre</p></div>
<a href="/cache.html" style="color:#fff">Lien blanc caché</a><div style="opacity:0"><a href="/opaque.html">Lien opaque caché</a></div><a href="/visible.html">Lien visible</a>
<div itemscope><span itemprop="name" style="font-size:1px">Marqueur micro</span><meta itemprop="price" content="12.50"></div></main>`),
      "/sombre.html": html(`<title>Sombre</title><meta name="color-scheme" content="dark"><main><p style="color:#fff">Texte clair sur un thème sombre, assez long pour compter.</p></main>`),
      // A list page: 300 content links under 600 menu links.
      "/liste.html": html(`<title>Liste</title><header>${Array.from({ length: 600 }, (_, i) => `<a href="/m${i}.html">Menu ${i}</a>`).join("")}</header><main>${Array.from({ length: 300 }, (_, i) => `<a href="/s${i}.html">Sommet ${i}</a> `).join("")}</main>`),
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
  w = await launchRessac({ env: { RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_SEARCH_URL: `${server.url}/sommaire.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  await agentPanelReady(m);
});
afterEach(() => w?.close());

const BAND = '[data-testid="search-band"]';
const bandText = () => waitFor<string>(m, `const b = document.querySelector('${BAND}'); return b?.dataset.state === "yours" ? b.querySelector('[data-testid="search-band-text"]').textContent : ""`, (v) => !!v);
const press = (testid: string) => m.execute(`document.querySelector('${BAND} [data-testid="${testid}"]').click();`);

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

it("read_tab with full: true gives every content link of a list page; only the menus are capped", async () => {
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "lire" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/liste.html` });
  const r = (await callTool(w.dataDir, "read_tab", { id, links: true, full: true })).text;
  expect(r).toContain(`Sommet 299 — ${server.url}/s299.html`);
  expect(r).toContain(`Menu 149 — ${server.url}/m149.html`);
  expect(r).not.toContain(`Menu 150 — `);
});

it("a page nested far too deep is still read: whole with full: true, the reduced page holds no unchecked text", async () => {
  const r = await read("/profonde.html");
  expect(r).toContain("État : vide");
  expect(r).not.toContain("Erreur");
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "lire" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/profonde.html` });
  expect((await callTool(w.dataDir, "read_tab", { id, full: true })).text).toContain("Début profond");
});

it("transparent text, unseen links and microdata text stay out; gradient text and text on a dark background stay in", async () => {
  const r = await read("/invisibles.html");
  for (const s of ["Titre dégradé visible", "Texte sur fond sombre", "price : 12.50", `Lien visible — ${server.url}/visible.html`]) expect(r).toContain(s);
  for (const s of ["Marqueur", "Lien blanc caché", "Lien opaque caché"]) expect(r).not.toContain(s);
  expect(await read("/sombre.html")).toContain("Texte clair sur un thème sombre");
});

it("a huge page with nested shadow roots is read quickly and bounded", async () => {
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "lire" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/longue.html` });
  const t = Date.now();
  const r = (await callTool(w.dataDir, "read_tab", { id })).text;
  expect(Date.now() - t).toBeLessThan(6000);
  expect(r).toContain("Section 0");
  expect(r).toContain("Section 1\n");
  expect(r.length).toBeLessThan(100_000 + 1_000);
});

it("the reduced page never holds text a person cannot see; full: true still answers", async () => {
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "autonomie de la radio" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/piege.html` });
  const r = (await callTool(w.dataDir, "read_tab", { id })).text;
  expect(r).toContain("État : ok (200)");
  expect(r).toContain("capte la FM");
  expect(r).toContain("22 × 12 × 9 cm");
  expect(r).not.toContain("Marqueur");
  expect((await callTool(w.dataDir, "read_tab", { id, full: true })).text).toContain("capte la FM");
});

it("a product's structured data comes first; a missing page says so", async () => {
  const r = await read("/produit.html");
  expect(r).toContain("Données structurées :");
  expect(r).toContain("offers.price : 49.90");
  expect(await read("/absente.html")).toContain("État : introuvable (404)");
});

it("a long article about captchas is a page, not a check", async () => {
  expect(await read("/captchas.html")).toContain("État : ok (200)");
});

it("a check page is handed to the user; after Continuer the agent gets the page that came", async () => {
  blocked = true;
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "lire" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/bloque.html` });
  const reading = callTool(w.dataDir, "read_tab", { id });
  expect(await bandText()).toMatch(/^Bloqué par une vérification\. À vous : /);
  blocked = false;
  await m.execute(`const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]); t.linkedBrowser.reload();`, [id]);
  await waitFor(m, `return gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === ${JSON.stringify(id)}).linkedBrowser.contentTitle`, (v) => v === "Débloquée");
  await press("search-continue");
  const r = (await reading).text;
  expect(r).toContain("La page est de nouveau à toi (elle était bloquée).");
  expect(r).toContain("La page est enfin là");
});

it("a login page is handed to the user too; Arrêter stops the search", async () => {
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "lire" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/connexion.html` });
  const reading = callTool(w.dataDir, "read_tab", { id });
  expect(await bandText()).toMatch(/^Connexion demandée\. À vous : /);
  await press("search-stop");
  expect((await reading).text).toContain("L'utilisateur a arrêté la recherche");
});

it("code keeps its spaces, line breaks and indentation; words apart stay apart; edit links rank after the article's", async () => {
  const code = "public class A {\n  // rien\n  int x;\n}";
  const r = await read("/code.html");
  expect(r).toContain(code);
  expect(r).toContain("mot suivant");
  expect(r).toContain(`0. Article lié — ${server.url}/lie.html`);
  const id = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "x", goal: "le code" })).text)![1]!;
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/code.html` });
  expect((await callTool(w.dataDir, "read_tab", { id, full: true })).text).toContain(code);
});
