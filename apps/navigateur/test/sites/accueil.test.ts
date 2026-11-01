import { expect, test } from "vitest";
import { fauxReseau } from "../faux-reseau-image";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cheminsEspace } from "@webaios/noyau";
import { AFFICHAGE_REFUSE, CSP_WIDGET, navigationCadrePermise, permissionInterface } from "../../src/main/agent/accueil";
import { cspAccueilSite, FICHIER_ACCUEIL_MAX, imageSite, repondreAccueilSite } from "../../src/main/sites/accueil";
import { ADRESSE_ACCUEIL_MAX, IMAGE_SITE_MAX, MessageDeLAccueil, SCHEMA_SITE } from "../../src/commun/sites";
import { accueilSiteDuCadre } from "../../src/main/sites/cadre-accueil";

/** Un espace avec l'appli `vidola` et son accueil. */
function espace() {
  const c = cheminsEspace(mkdtempSync(join(tmpdir(), "webaios-accueil-site-")));
  const accueil = join(c.sites, "vidola", "accueil");
  mkdirSync(join(accueil, "img"), { recursive: true });
  writeFileSync(join(c.sites, "vidola", "site.json"), '{"nom":"Vidola"}');
  writeFileSync(join(accueil, "index.html"), "<p>séries</p>");
  writeFileSync(join(accueil, "app.js"), "parent.postMessage({ type: 'pret' }, '*')");
  writeFileSync(join(accueil, "style.css"), "p { color: red }");
  writeFileSync(join(accueil, "img", "affiche.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { c, accueil };
}

test("SCHEMA_SITE, IMAGE_SITE_MAX et la longueur des adresses demandées par l'accueil", () => {
  expect(SCHEMA_SITE).toBe("webaios-site");
  expect(IMAGE_SITE_MAX).toBe(2 * 1024 * 1024);
  expect(ADRESSE_ACCUEIL_MAX).toBe(2000);
  expect(MessageDeLAccueil.safeParse({ type: "ouvrir", adresse: "/" + "a".repeat(1999) }).success).toBe(true);
  expect(MessageDeLAccueil.safeParse({ type: "ouvrir", adresse: "/" + "a".repeat(2000) }).success).toBe(false);
  expect(MessageDeLAccueil.safeParse({ type: "image", n: 1, url: "https://a.test/" + "a".repeat(2000) }).success).toBe(false);
});

test("cspAccueilSite : CSP_WIDGET, plus les fichiers de cette appli pour les scripts, styles, images et polices", () => {
  expect(cspAccueilSite("vidola")).toBe(
    "default-src 'none'; script-src 'unsafe-inline' webaios-site://vidola; style-src 'unsafe-inline' webaios-site://vidola; img-src data: webaios-site://vidola; font-src data: webaios-site://vidola; connect-src 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types default",
  );
  // Le reste de CSP_WIDGET est gardé tel quel.
  for (const d of CSP_WIDGET.split("; ").filter((d) => !/^(script|style|img|font)-src/.test(d))) expect(cspAccueilSite("vidola")).toContain(d);
});

test("repondreAccueilSite : index.html avec cspAccueilSite ; scripts, styles et images de accueil/ avec leur type", async () => {
  const { c } = espace();
  const r = await repondreAccueilSite(c, "webaios-site://vidola/index.html");
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("<p>séries</p>");
  expect(r.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("Content-Security-Policy")).toBe(cspAccueilSite("vidola"));
  expect(r.headers.get("X-DNS-Prefetch-Control")).toBe("off");
  expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
  // Rechargement (paramètre) : même fichier.
  expect((await repondreAccueilSite(c, "webaios-site://vidola/index.html?v=2")).status).toBe(200);
  const types: [string, string][] = [
    ["app.js", "text/javascript; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"],
    ["img/affiche.png", "image/png"],
  ];
  for (const [f, type] of types) {
    const rf = await repondreAccueilSite(c, `webaios-site://vidola/${f}`);
    expect(rf.status, f).toBe(200);
    expect(rf.headers.get("Content-Type"), f).toBe(type);
    expect(rf.headers.get("Content-Security-Policy"), f).toBe(cspAccueilSite("vidola"));
  }
});

test("repondreAccueilSite : ../site.json, lien symbolique, autre id, id en majuscules, dossier au nom différent → 404", async () => {
  const { c, accueil } = espace();
  const dehors = mkdtempSync(join(tmpdir(), "webaios-secret-"));
  writeFileSync(join(dehors, "secret.html"), "secret");
  symlinkSync(join(dehors, "secret.html"), join(accueil, "lien.html"));
  symlinkSync(dehors, join(accueil, "dehors"));
  // Un lien qui reste dans l'accueil est refusé lui aussi : aucun lien n'est suivi.
  symlinkSync(join(accueil, "index.html"), join(accueil, "interne.html"));
  // Une autre appli, et une appli dont le dossier a des majuscules (un disque insensible à la casse la trouverait).
  mkdirSync(join(c.sites, "autre", "accueil"), { recursive: true });
  writeFileSync(join(c.sites, "autre", "accueil", "index.html"), "autre");
  mkdirSync(join(c.sites, "MonSite", "accueil"), { recursive: true });
  writeFileSync(join(c.sites, "MonSite", "accueil", "index.html"), "majuscules");
  // Un accueil qui est lui-même un lien.
  mkdirSync(join(c.sites, "lie"), { recursive: true });
  symlinkSync(dehors, join(c.sites, "lie", "accueil"));
  for (const url of [
    "webaios-site://vidola/../site.json",
    "webaios-site://vidola/%2e%2e/site.json",
    "webaios-site://vidola/..%2fsite.json",
    "webaios-site://vidola/img%2faffiche.png",
    "webaios-site://vidola/site.json",
    "webaios-site://vidola/",
    "webaios-site://vidola/absent.html",
    "webaios-site://vidola/img",
    "webaios-site://vidola/lien.html",
    "webaios-site://vidola/dehors/secret.html",
    "webaios-site://vidola/interne.html",
    "webaios-site://vidola/.cache.html",
    "webaios-site://monsite/index.html",
    "webaios-site://MonSite/index.html",
    "webaios-site://lie/secret.html",
    "webaios-site://lie/index.html",
    "webaios-site://vidola:80/index.html",
    "webaios-site://x@vidola/index.html",
    "webaios-site://-vidola/index.html",
    "webaios-widget://vidola/index.html",
    "https://vidola/index.html",
    "pas une url",
  ]) {
    const r = await repondreAccueilSite(c, url);
    expect(r.status, url).toBe(404);
    expect(await r.text(), url).not.toMatch(/secret|majuscules/);
  }
  // L'autre appli sert son propre accueil (et seulement par son id).
  expect(await (await repondreAccueilSite(c, "webaios-site://autre/index.html")).text()).toBe("autre");
  // Le dossier des applis lui-même est un lien : rien n'est servi.
  const c2 = cheminsEspace(mkdtempSync(join(tmpdir(), "webaios-accueil-site-")));
  mkdirSync(join(dehors, "s", "x", "accueil"), { recursive: true });
  writeFileSync(join(dehors, "s", "x", "accueil", "index.html"), "secret");
  mkdirSync(join(c2.sites, ".."), { recursive: true });
  symlinkSync(join(dehors, "s"), c2.sites);
  expect((await repondreAccueilSite(c2, "webaios-site://x/index.html")).status).toBe(404);
});

test("repondreAccueilSite : <link>, <meta http-equiv> ou règles de spéculation dans un .html → AFFICHAGE_REFUSE ; fichier trop gros → 404", async () => {
  const { c, accueil } = espace();
  writeFileSync(join(accueil, "a.html"), '<link rel="preconnect" href="https://x.secret.example">');
  writeFileSync(join(accueil, "b.html"), '<meta http-equiv="refresh" content="0;url=https://x.secret.example">');
  writeFileSync(join(accueil, "c.html"), '<script type="speculationrules">{"prefetch":[{"urls":["https://x.secret.example/"]}]}</script>');
  for (const f of ["a.html", "b.html", "c.html"]) {
    const r = await repondreAccueilSite(c, `webaios-site://vidola/${f}`);
    expect(r.status, f).toBe(200);
    expect(r.headers.get("Content-Security-Policy")).toBe(cspAccueilSite("vidola"));
    expect(await r.text(), f).toBe(AFFICHAGE_REFUSE);
  }
  writeFileSync(join(accueil, "gros.png"), Buffer.alloc(FICHIER_ACCUEIL_MAX + 1));
  expect((await repondreAccueilSite(c, "webaios-site://vidola/gros.png")).status).toBe(404);
});

/** Les requêtes de la session de l'appli (faux `net.request`), qui répondent par `repondre` ; `appels` : adresses demandées. */
function session(repondre: (url: string) => Response) {
  const f = fauxReseau(repondre);
  return { appels: f.demandes, s: f.ouvrir };
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const DOMAINES = ["vidola.example"];

test("imageSite : une image du site (ou d'un sous-domaine) rendue en data:, chargée avec les cookies de l'appli", async () => {
  const { s, appels } = session(() => new Response(PNG, { headers: { "Content-Type": "image/png" } }));
  expect(await imageSite(s, "https://vidola.example/affiches/bear.png", DOMAINES)).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  expect(await imageSite(s, "https://img.vidola.example/a.png", DOMAINES)).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  expect(appels[0]!.cookies).toBe(true);
});

test("imageSite : pub.example, javascript:, identifiants, text/html, 10 Mo, erreur, redirection hors du site → null", async () => {
  const { s, appels } = session(() => new Response(PNG, { headers: { "Content-Type": "image/png" } }));
  for (const url of ["http://vidola.example/a.png", "https://pub.example/a.png", "https://vidola.example.pub.example/a.png", "javascript:alert(1)", "data:image/png;base64,AA==", "file:///etc/passwd", "https://u:p@vidola.example/a.png", "pas une url"]) {
    expect(await imageSite(s, url, DOMAINES), url).toBeNull();
  }
  expect(appels).toEqual([]);

  const html = session(() => new Response("<p>x</p>", { headers: { "Content-Type": "text/html" } }));
  expect(await imageSite(html.s, "https://vidola.example/a.png", DOMAINES)).toBeNull();
  const gros = session(() => new Response(Buffer.alloc(10 * 1024 * 1024), { headers: { "Content-Type": "image/png" } }));
  expect(await imageSite(gros.s, "https://vidola.example/a.png", DOMAINES)).toBeNull();
  const annonce = session(() => new Response(PNG, { headers: { "Content-Type": "image/png", "Content-Length": String(IMAGE_SITE_MAX + 1) } }));
  expect(await imageSite(annonce.s, "https://vidola.example/a.png", DOMAINES)).toBeNull();
  const absente = session(() => new Response("", { status: 404, headers: { "Content-Type": "image/png" } }));
  expect(await imageSite(absente.s, "https://vidola.example/a.png", DOMAINES)).toBeNull();
  const panne = session(() => {
    throw new Error("réseau");
  });
  expect(await imageSite(panne.s, "https://vidola.example/a.png", DOMAINES)).toBeNull();
  // Type bizarre : jamais recopié dans l'adresse data:.
  const bizarre = session(() => new Response(PNG, { headers: { "Content-Type": "image/png,text/html" } }));
  expect(await imageSite(bizarre.s, "https://vidola.example/a.png", DOMAINES)).toBeNull();

  // Redirection : chaque saut est revérifié avant d'être suivi ; vers un tiers ou en http, la cible n'est jamais demandée.
  const redirige = session((url) =>
    url.endsWith("/vers-pub")
      ? new Response(null, { status: 302, headers: { Location: "https://pub.example/a.png" } })
      : url.endsWith("/vers-http")
        ? new Response(null, { status: 302, headers: { Location: "http://vidola.example/a.png" } })
        : url.endsWith("/vers-cdn")
          ? new Response(null, { status: 302, headers: { Location: "/affiches/a.png" } })
          : new Response(PNG, { headers: { "Content-Type": "image/png" } }),
  );
  expect(await imageSite(redirige.s, "https://vidola.example/vers-pub", DOMAINES)).toBeNull();
  // Vers http sur le même domaine : les cookies de l'appli partiraient en clair.
  expect(await imageSite(redirige.s, "https://vidola.example/vers-http", DOMAINES)).toBeNull();
  expect(redirige.appels.map((a) => a.url)).toEqual(["https://vidola.example/vers-pub", "https://vidola.example/vers-http"]);
  // Sur le site (relative ou vers un sous-domaine) : suivie, avec les cookies de l'appli.
  expect(await imageSite(redirige.s, "https://vidola.example/vers-cdn", DOMAINES)).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  expect(redirige.appels.slice(2)).toEqual([
    { url: "https://vidola.example/vers-cdn", cookies: true },
    { url: "https://vidola.example/affiches/a.png", cookies: true },
  ]);
  // 3 sauts suivis, le quatrième jamais demandé.
  const boucle = session((url) => new Response(null, { status: 302, headers: { Location: `/n${Number(/\d+$/.exec(url)?.[0] ?? 0) + 1}` } }));
  expect(await imageSite(boucle.s, "https://vidola.example/n0", DOMAINES)).toBeNull();
  expect(boucle.appels.map((a) => a.url)).toEqual(["https://vidola.example/n0", "https://vidola.example/n1", "https://vidola.example/n2", "https://vidola.example/n3"]);
});

test("permissionInterface refuse un cadre webaios-site:, même présenté comme cadre principal", () => {
  expect(permissionInterface({ requestingUrl: "webaios-site://vidola/index.html", isMainFrame: false })).toBe(false);
  expect(permissionInterface({ requestingUrl: "webaios-site://vidola/index.html", isMainFrame: true })).toBe(false);
  expect(permissionInterface({ requestingUrl: "file:///app/out/renderer/site.html?id=vidola", isMainFrame: true })).toBe(true);
});

test("accueilSiteDuCadre : l'id d'une page .html de l'accueil, sinon null", () => {
  expect(accueilSiteDuCadre("webaios-site://vidola/index.html")).toBe("vidola");
  expect(accueilSiteDuCadre("webaios-site://vidola/series.html?v=2")).toBe("vidola");
  for (const url of ["webaios-site://vidola/img/a.png", "webaios-site://vidola/", "webaios-site://vidola:1/index.html", "webaios-widget://vidola/index.html", "https://vidola/index.html", "x"])
    expect(accueilSiteDuCadre(url), url).toBeNull();
});

test("navigationCadrePermise : un cadre webaios-site://vidola ne va que vers son propre accueil, dans la seule fenêtre de vidola", () => {
  const index = "webaios-site://vidola/index.html";
  // Un nouveau cadre charge l'accueil ; l'accueil se recharge ou passe à une autre de ses pages.
  expect(navigationCadrePermise("", index, "vidola")).toBe(true);
  expect(navigationCadrePermise("about:blank", index, "vidola")).toBe(true);
  expect(navigationCadrePermise("chrome-error://chromewebdata/", index, "vidola")).toBe(true);
  expect(navigationCadrePermise(index, index, "vidola")).toBe(true);
  expect(navigationCadrePermise(index, "webaios-site://vidola/series.html", "vidola")).toBe(true);
  // Jamais vers le web, ni vers l'accueil d'une autre appli, ni vers un fichier qui n'est pas une page.
  expect(navigationCadrePermise(index, "https://pub.example", "vidola")).toBe(false);
  expect(navigationCadrePermise(index, "javascript:alert(1)", "vidola")).toBe(false);
  expect(navigationCadrePermise("", "webaios-site://autre/index.html", "vidola")).toBe(false);
  expect(navigationCadrePermise(index, "webaios-site://autre/index.html", "vidola")).toBe(false);
  expect(navigationCadrePermise(index, "webaios-site://vidola/img/a.svg", "vidola")).toBe(false);
  // Ni widget ni composant dans la fenêtre d'une appli de site ; ni accueil de site dans une fenêtre principale.
  expect(navigationCadrePermise("", "webaios-widget://meteo/affichage.html", "vidola")).toBe(false);
  expect(navigationCadrePermise("", "webaios-composant://barres/composant.html", "vidola")).toBe(false);
  expect(navigationCadrePermise("", index)).toBe(false);
  expect(navigationCadrePermise("webaios-widget://meteo/affichage.html", index)).toBe(false);
  // Les widgets de la fenêtre principale gardent leur règle.
  expect(navigationCadrePermise("", "webaios-widget://meteo/affichage.html")).toBe(true);
});
