import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accorder,
  cheminsEspace,
  ecrireExecution,
  ecrireResultat,
  idExecution,
  lireAction,
  type ActionsNoyau,
  type CheminsEspace,
  type EtatActions,
  type Execution,
  type LancementAction,
  type ResultatLancement,
} from "@webaios/noyau";
import type { Action } from "../../src/commun/api";
import { actionDeUrl, cibleDeUrlWorkflow, PREFIXE_WORKFLOW_ACTION, URL_ACTIONS, urlAction, widgetDeUrlWorkflow, type EtatNavigateur } from "../../src/commun/modele";
import { ACTIONS_EN_ESPACE_PRIVE, EN_ATTENTE, lectureDe, MISE_EN_PAGE, SCHEMA_COMPOSANT, SCHEMA_IMAGE, urlComposant, urlImage } from "../../src/commun/actions";
import { AFFICHAGE_REFUSE, CSP_WIDGET, navigationCadrePermise, permissionInterface } from "../../src/main/agent/accueil";
import { creerServiceActions, IMAGE_MAX, lienPermis, lireActionsAffichees, repondreComposant, repondreImage, retirerAction } from "../../src/main/agent/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import { fauxReseau } from "../faux-reseau-image";
import { appliquer } from "../../src/main/etat/actions";

const DEBUT = "2026-10-31T10:00:00.000Z";

/** Un espace temporaire avec ces actions (`action.json`), et le dossier de leurs données hors de l'espace. */
function espace(declarations: Record<string, object>): { c: CheminsEspace; dossierActions: string } {
  const racine = mkdtempSync(join(tmpdir(), "webaios-actions-"));
  const c = cheminsEspace(join(racine, "WebAiOs"));
  for (const [id, d] of Object.entries(declarations)) {
    mkdirSync(join(c.actions, id), { recursive: true });
    writeFileSync(join(c.actions, id, "action.json"), JSON.stringify(d));
  }
  return { c, dossierActions: join(racine, "profil", "actions") };
}

/** Une exécution gardée de l'action, avec ses résultats ; rend son id. */
async function executer(dossierActions: string, id: string, resultats: unknown, debut = DEBUT): Promise<string> {
  const ex = idExecution(debut);
  const e: Execution = { version: 1, id: ex, proprietaire: { type: "action", id }, declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs: [] };
  await ecrireExecution(join(dossierActions, id), e);
  await ecrireResultat(dossierActions, id, { version: 1, execution: ex, saisie: null, resultats, plan: null, secours: true, vide: false });
  return ex;
}

test("adresses des actions : webaios://action/<id>[/<exécution>], rien d'autre", () => {
  expect(URL_ACTIONS).toBe("webaios://actions");
  expect(actionDeUrl("webaios://action/gitlab")).toEqual({ id: "gitlab", execution: null });
  expect(actionDeUrl(urlAction("gitlab"))).toEqual({ id: "gitlab", execution: null });
  const ex = idExecution(DEBUT);
  expect(urlAction("gitlab", ex)).toBe(`webaios://action/gitlab/${ex}`);
  expect(actionDeUrl(`webaios://action/gitlab/${ex}`)).toEqual({ id: "gitlab", execution: ex });
  for (const u of [
    "webaios://action/../x",
    "webaios://action/",
    "webaios://action/Git_Lab",
    "webaios://action/gitlab/../etat",
    "webaios://action/gitlab/x/y",
    `webaios://action/gitlab/${ex}/`,
    "webaios://actions",
    "webaios://workflow/gitlab",
    "https://action/gitlab",
  ]) {
    expect(actionDeUrl(u), u).toBeNull();
  }
});

test("cibleDeUrlWorkflow : widget et action ; widgetDeUrlWorkflow ignore une action", () => {
  expect(PREFIXE_WORKFLOW_ACTION).toBe("webaios://workflow/action/");
  expect(cibleDeUrlWorkflow("webaios://workflow/meteo")).toEqual({ type: "widget", id: "meteo" });
  expect(cibleDeUrlWorkflow("webaios://workflow/action/gitlab")).toEqual({ type: "action", id: "gitlab" });
  expect(cibleDeUrlWorkflow("webaios://workflow/action/../x")).toBeNull();
  expect(cibleDeUrlWorkflow("webaios://workflow/action/")).toBeNull();
  expect(cibleDeUrlWorkflow("webaios://action/gitlab")).toBeNull();
  expect(widgetDeUrlWorkflow("webaios://workflow/action/x")).toBeNull();
  expect(widgetDeUrlWorkflow("webaios://workflow/meteo")).toBe("meteo");
});

test("messages de la page de l'action", () => {
  expect(ACTIONS_EN_ESPACE_PRIVE).toBe("Les actions ne sont pas disponibles dans un espace privé");
  expect(EN_ATTENTE).toBe("En attente : deux actions tournent déjà");
  expect(MISE_EN_PAGE).toBe("Mise en page…");
  expect(lectureDe("gitlab.com")).toBe("Lecture de gitlab.com…");
});

test("urlImage : webaios-image://<id>/<exécution>?u=<url encodée>", () => {
  expect(SCHEMA_IMAGE).toBe("webaios-image");
  expect(SCHEMA_COMPOSANT).toBe("webaios-composant");
  const ex = idExecution(DEBUT);
  expect(urlImage("leboncoin", ex, "https://img.test/a.jpg?x=1&y=2")).toBe(`webaios-image://leboncoin/${ex}?u=https%3A%2F%2Fimg.test%2Fa.jpg%3Fx%3D1%26y%3D2`);
  expect(urlComposant("barres")).toBe("webaios-composant://barres/composant.html");
});

/** De fausses requêtes (`net.request`, redirections en mode « manual ») qui notent chaque adresse demandée. */
function faussesRequetes(reponse: (url: string) => Response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })) {
  const { demandes, ouvrir } = fauxReseau(reponse);
  return { demandes, ouvrir };
}

test("repondreImage : une adresse https présente telle quelle dans les résultats d'une action sans compte est récupérée sans cookies", async () => {
  const { c, dossierActions } = espace({ leboncoin: { nom: "Leboncoin", sources: { web: true } } });
  const image = "https://img.test/annonce/1.jpg?rule=ad-large";
  const ex = await executer(dossierActions, "leboncoin", { annonces: [{ titre: "Clio", photo: image }] });
  const { demandes, ouvrir } = faussesRequetes();
  const r = await repondreImage({ dossierActions, lireAction: (id) => lireAction(c, id), ouvrir }, urlImage("leboncoin", ex, image));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/jpeg");
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(demandes).toEqual([{ url: image, cookies: false }]);
});

test("repondreImage refuse (404, aucune requête) : compte, http, adresse absente ou composée, exécution inconnue, adresse locale", async () => {
  const { c, dossierActions } = espace({
    publique: { nom: "Publique", sources: { web: true } },
    gitlab: { nom: "GitLab", sources: { compte: ["gitlab.com"] } },
  });
  const image = "https://img.test/a.jpg";
  const resultats = { elements: [{ photo: image, http: "http://img.test/a.jpg", local: "https://127.0.0.1/a.jpg", lan: "https://192.168.1.2/a.jpg" }] };
  const exPublique = await executer(dossierActions, "publique", resultats);
  const exGitlab = await executer(dossierActions, "gitlab", resultats);
  const { demandes, ouvrir } = faussesRequetes();
  const o = { dossierActions, lireAction: (id: string) => lireAction(c, id), ouvrir };
  const refusees = [
    urlImage("gitlab", exGitlab, image), // action avec compte
    urlImage("publique", exPublique, "http://img.test/a.jpg"), // http
    urlImage("publique", exPublique, "https://img.test/b.jpg"), // absente des résultats
    urlImage("publique", exPublique, "https://tiers.test/?d=" + encodeURIComponent(image)), // composée
    urlImage("publique", exPublique, image + "?d=secret"), // composée
    urlImage("publique", idExecution("2026-10-31T11:00:00.000Z"), image), // exécution inconnue
    urlImage("publique", "../etat", image),
    urlImage("absente", exPublique, image), // action disparue
    urlImage("publique", exPublique, "https://127.0.0.1/a.jpg"), // adresse de la machine
    urlImage("publique", exPublique, "https://192.168.1.2/a.jpg"), // réseau local
    `webaios-image://publique/${exPublique}`, // sans adresse
    `webaios-icone://publique/${exPublique}?u=${encodeURIComponent(image)}`,
    "pas une url",
  ];
  for (const u of refusees) expect((await repondreImage(o, u)).status, u).toBe(404);
  expect(demandes).toEqual([]);
});

test("repondreImage refuse une réponse qui n'est pas une image, un échec ou une image trop grosse", async () => {
  const { c, dossierActions } = espace({ publique: { nom: "Publique", sources: { web: true } } });
  const html = "https://img.test/page.html";
  const gros = "https://img.test/gros.jpg";
  const absent = "https://img.test/absent.jpg";
  const ex = await executer(dossierActions, "publique", { a: html, b: gros, c: absent });
  const { ouvrir } = faussesRequetes((url) => {
    if (url === html) return new Response("<p>x</p>", { headers: { "content-type": "text/html" } });
    if (url === gros) return new Response(new Uint8Array(IMAGE_MAX + 1), { headers: { "content-type": "image/png" } });
    return new Response("", { status: 404 });
  });
  const o = { dossierActions, lireAction: (id: string) => lireAction(c, id), ouvrir };
  expect(IMAGE_MAX).toBe(5 * 1024 * 1024);
  for (const u of [html, gros, absent]) expect((await repondreImage(o, urlImage("publique", ex, u))).status, u).toBe(404);
  const echec = {
    ...o,
    ouvrir: fauxReseau(() => {
      throw new Error("réseau");
    }).ouvrir,
  };
  expect((await repondreImage(echec, urlImage("publique", ex, html))).status).toBe(404);
});

test("repondreImage suit au plus 3 redirections, chacune vers une adresse https publique ; sinon 404 sans aller plus loin", async () => {
  const { c, dossierActions } = espace({ publique: { nom: "Publique", sources: { web: true } } });
  const image = "https://img.test/a.jpg";
  const ex = await executer(dossierActions, "publique", { photo: image });
  const redirection = (location: string) => new Response(null, { status: 302, headers: { location } });
  const essayer = async (sauts: Record<string, Response | (() => Response)>) => {
    const { demandes, ouvrir } = faussesRequetes((url) => {
      const r = sauts[url];
      if (r) return typeof r === "function" ? r() : r;
      return new Response(new Uint8Array([7]), { headers: { "content-type": "image/png" } });
    });
    const r = await repondreImage({ dossierActions, lireAction: (id) => lireAction(c, id), ouvrir }, urlImage("publique", ex, image));
    return { statut: r.status, demandes: demandes.map((d) => d.url), cookies: demandes.map((d) => d.cookies) };
  };
  // https → https publique (relative comprise) : suivie, l'image finale est servie.
  const suivie = await essayer({ [image]: redirection("https://cdn.test/b.jpg"), "https://cdn.test/b.jpg": redirection("/c.jpg") });
  expect(suivie).toEqual({ statut: 200, demandes: [image, "https://cdn.test/b.jpg", "https://cdn.test/c.jpg"], cookies: [false, false, false] });
  // Vers le réseau local, la machine ou en http : refusée, sans requête vers la cible.
  for (const cible of ["http://192.168.1.2/", "https://192.168.1.2/a.png", "https://127.0.0.1:5280/a.png", "http://img.test/a.jpg", "javascript:alert(1)"]) {
    expect(await essayer({ [image]: redirection(cible) }), cible).toEqual({ statut: 404, demandes: [image], cookies: [false] });
  }
  // Sans Location : refusée.
  expect((await essayer({ [image]: new Response(null, { status: 302 }) })).statut).toBe(404);
  // 3 sauts : suivis ; 4 : refusés, la quatrième cible n'est jamais demandée.
  const chaine = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i === 0 ? image : `https://cdn.test/${i}.jpg`, redirection(`https://cdn.test/${i + 1}.jpg`)]));
  expect((await essayer(chaine(3))).statut).toBe(200);
  const quatre = await essayer(chaine(4));
  expect(quatre.statut).toBe(404);
  expect(quatre.demandes).toEqual([image, "https://cdn.test/1.jpg", "https://cdn.test/2.jpg", "https://cdn.test/3.jpg"]);
  // La réponse finale doit toujours être une image.
  expect((await essayer({ [image]: redirection("https://cdn.test/p"), "https://cdn.test/p": new Response("<p>", { headers: { "content-type": "text/html" } }) })).statut).toBe(404);
});

test("repondreImage refuse une action qui a un accord du compte, même si sa déclaration n'a plus de compte", async () => {
  const { c, dossierActions } = espace({ reecrite: { nom: "Réécrite", sources: { web: true } } });
  const image = "https://img.test/a.jpg";
  const ex = await executer(dossierActions, "reecrite", { photo: image });
  await accorder(dossierActions, "reecrite", { domaines: ["gitlab.com"], publiques: [], profil: "defaut" });
  const { demandes, ouvrir } = faussesRequetes();
  expect((await repondreImage({ dossierActions, lireAction: (id) => lireAction(c, id), ouvrir }, urlImage("reecrite", ex, image))).status).toBe(404);
  expect(demandes).toEqual([]);
});

test("repondreComposant sert composant.html avec CSP_WIDGET, sans résolution de noms ; refuse tout autre chemin", async () => {
  const { c } = espace({});
  mkdirSync(join(c.composants, "barres"), { recursive: true });
  writeFileSync(join(c.composants, "barres", "composant.html"), "<svg></svg>");
  writeFileSync(join(c.composants, "barres", "composant.json"), "{}");
  const ok = await repondreComposant(c.composants, "webaios-composant://barres/composant.html?v=3");
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("<svg></svg>");
  expect(ok.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(ok.headers.get("Content-Security-Policy")).toBe(CSP_WIDGET);
  expect(ok.headers.get("X-DNS-Prefetch-Control")).toBe("off");
  for (const u of [
    "webaios-composant://barres/composant.json",
    "webaios-composant://barres/../barres/composant.html/x",
    "webaios-composant://Barres_1/composant.html",
    "webaios-composant://absent/composant.html",
    "webaios-widget://barres/composant.html",
    "pas une url",
  ]) {
    expect((await repondreComposant(c.composants, u)).status, u).toBe(404);
  }
  expect((await repondreComposant(null, "webaios-composant://barres/composant.html")).status).toBe(404);
});

test("repondreComposant : un lien symbolique qui sort du composant → 404 ; un indice réseau → AFFICHAGE_REFUSE ; trop gros → 404", async () => {
  const { c } = espace({});
  const dehors = mkdtempSync(join(tmpdir(), "webaios-dehors-"));
  writeFileSync(join(dehors, "composant.html"), "<p>secret du Mac</p>");
  mkdirSync(join(c.composants, "lien"), { recursive: true });
  symlinkSync(join(dehors, "composant.html"), join(c.composants, "lien", "composant.html"));
  symlinkSync(dehors, join(c.composants, "sortant"));
  for (const u of ["webaios-composant://lien/composant.html", "webaios-composant://sortant/composant.html"]) {
    expect((await repondreComposant(c.composants, u)).status, u).toBe(404);
  }
  mkdirSync(join(c.composants, "fuite"), { recursive: true });
  writeFileSync(join(c.composants, "fuite", "composant.html"), '<link rel="prefetch" href="https://tiers.test/?d=x"><p>x</p>');
  const refuse = await repondreComposant(c.composants, "webaios-composant://fuite/composant.html");
  expect(refuse.status).toBe(200);
  expect(await refuse.text()).toBe(AFFICHAGE_REFUSE);
  expect(refuse.headers.get("Content-Security-Policy")).toBe(CSP_WIDGET);
  mkdirSync(join(c.composants, "gros"), { recursive: true });
  writeFileSync(join(c.composants, "gros", "composant.html"), "x".repeat(256 * 1024 + 1));
  expect((await repondreComposant(c.composants, "webaios-composant://gros/composant.html")).status).toBe(404);
});

test("navigationCadrePermise : un cadre de composant ne va que vers lui-même", () => {
  const barres = "webaios-composant://barres/composant.html";
  expect(navigationCadrePermise("", barres)).toBe(true);
  expect(navigationCadrePermise("about:blank", barres)).toBe(true);
  expect(navigationCadrePermise("chrome-error://chromewebdata/", barres)).toBe(true);
  expect(navigationCadrePermise(barres, barres + "?v=2")).toBe(true);
  expect(navigationCadrePermise(barres, "webaios-composant://camembert/composant.html")).toBe(false);
  expect(navigationCadrePermise(barres, "https://tiers.test/?d=secret")).toBe(false);
  expect(navigationCadrePermise(barres, "webaios-widget://meteo/affichage.html")).toBe(false);
  expect(navigationCadrePermise("webaios-widget://meteo/affichage.html", barres)).toBe(false);
  expect(navigationCadrePermise("", "webaios-composant://barres/composant.json")).toBe(false);
  expect(navigationCadrePermise("", `webaios-image://x/${idExecution(DEBUT)}?u=https%3A%2F%2Fa.test%2F`)).toBe(false);
});

test("permissionInterface refuse les cadres de composant", () => {
  expect(permissionInterface({ requestingUrl: "webaios-composant://barres/composant.html", isMainFrame: false })).toBe(false);
  expect(permissionInterface({ requestingUrl: "webaios-composant://barres/composant.html", isMainFrame: true })).toBe(false);
  expect(permissionInterface({ requestingUrl: "file:///app/out/renderer/index.html", isMainFrame: true })).toBe(true);
});

test("l'interface charge les images par webaios-image: et les composants par webaios-composant:, rien d'autre de nouveau", () => {
  const html = readFileSync(join(__dirname, "../../src/renderer/index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
  const directive = (nom: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(nom + " "))!.split(/\s+/).slice(1);
  expect(directive("img-src")).toEqual(["'self'", "data:", "webaios-icone:", "webaios-image:", "crx:"]);
  expect(directive("frame-src")).toEqual(["webaios-widget:", "webaios-composant:"]);
});

test("lienPermis : seulement une adresse http(s) ouvrable présente telle quelle dans les résultats de l'exécution", async () => {
  const { dossierActions } = espace({});
  const ex = await executer(dossierActions, "gitlab", { tickets: [{ url: "https://gitlab.com/a/-/issues/1", code: "javascript:alert(1)", local: "http://127.0.0.1:5280/" }] });
  expect(await lienPermis(dossierActions, "gitlab", ex, "https://gitlab.com/a/-/issues/1")).toBe(true);
  for (const url of ["https://gitlab.com/a/-/issues/2", "javascript:alert(1)", "http://127.0.0.1:5280/", "https://tiers.test/?d=https://gitlab.com/a/-/issues/1"]) {
    expect(await lienPermis(dossierActions, "gitlab", ex, url), url).toBe(false);
  }
  expect(await lienPermis(dossierActions, "gitlab", idExecution("2026-10-31T12:00:00.000Z"), "https://gitlab.com/a/-/issues/1")).toBe(false);
  expect(await lienPermis(dossierActions, "../gitlab", ex, "https://gitlab.com/a/-/issues/1")).toBe(false);
});

test("retirerAction met le dossier à la corbeille (rien n'est détruit) et appelle oublier", async () => {
  const { c } = espace({ gitlab: { nom: "GitLab" } });
  const oublies: string[] = [];
  await retirerAction(c, "gitlab", async (id) => void oublies.push(id));
  expect(existsSync(join(c.actions, "gitlab"))).toBe(false);
  const corbeille = readdirSync(join(c.actions, ".corbeille"));
  expect(corbeille).toHaveLength(1);
  expect(corbeille[0]).toMatch(/^gitlab-\d+$/);
  expect(readFileSync(join(c.actions, ".corbeille", corbeille[0]!, "action.json"), "utf8")).toContain("GitLab");
  expect(oublies).toEqual(["gitlab"]);
  await expect(retirerAction(c, "../x", async () => {})).rejects.toThrow();
});

test("lireActionsAffichees : déclaration, accord, dernier résultat (pas un essai), action cassée signalée", async () => {
  const { c, dossierActions } = espace({
    gitlab: { nom: "GitLab", description: "Mes tickets", motsCles: ["tickets"], sources: { compte: ["gitlab.com"] } },
    leboncoin: { nom: "Leboncoin", saisie: { libelle: "Recherche" }, sources: { web: true } },
  });
  mkdirSync(join(c.actions, "cassee"), { recursive: true });
  writeFileSync(join(c.actions, "cassee", "action.json"), "{");
  const ex = await executer(dossierActions, "leboncoin", { a: 1 });
  const liste = await lireActionsAffichees(c, dossierActions);
  expect(liste.map((a) => a.id)).toEqual(["cassee", "gitlab", "leboncoin"]);
  expect(liste[0]).toMatchObject({ id: "cassee", nom: "cassee", motsCles: [], saisie: null, compte: [], accord: false, dernier: null });
  expect(liste[0]!.erreur).toBeTruthy();
  expect(liste[1]).toEqual({ id: "gitlab", nom: "GitLab", description: "Mes tickets", motsCles: ["tickets"], saisie: null, compte: ["gitlab.com"], publiques: [], accord: false, dernier: null });
  expect(liste[2]).toEqual({ id: "leboncoin", nom: "Leboncoin", description: "", motsCles: [], saisie: { libelle: "Recherche" }, compte: [], publiques: [], accord: false, dernier: { execution: ex, debut: DEBUT, statut: "reussie" } });
});

// --- Le service : refus en espace privé, ouverture et lancement ---

/** Un faux noyau des actions : note les lancements et arrêts. */
function fauxNoyau(direct: EtatActions = { courantes: [], enAttente: [] }, issue: ResultatLancement | Promise<ResultatLancement> = { statut: "reussie", execution: "x" }) {
  const lances: { id: string; saisie?: string }[] = [];
  const arretes: string[] = [];
  /** Arrêts et retraits d'accord, dans l'ordre. */
  const appels: string[] = [];
  const actions = {
    lancer: (id: string, o: { saisie?: string }): LancementAction => {
      lances.push({ id, ...(o.saisie !== undefined ? { saisie: o.saisie } : {}) });
      return { deja: false, fin: Promise.resolve(issue) };
    },
    arreter: (id: string) => {
      arretes.push(id);
      appels.push(`arreter:${id}`);
    },
    direct: () => direct,
    page: async () => ({ execution: "x", debut: DEBUT, fin: DEBUT, saisie: null, statut: "reussie" as const, page: null, compte: false }),
    executions: async () => [],
    accorder: async () => {},
    refuserAccord: async (id: string) => void appels.push(`refuserAccord:${id}`),
  } as unknown as ActionsNoyau;
  return { lances, arretes, appels, noyau: { actions } };
}

function service(o: { prive?: boolean; direct?: EtatActions; issue?: ResultatLancement | Promise<ResultatLancement> } = {}) {
  let n = 0;
  const genId = () => `g${++n}`;
  let etat: EtatNavigateur = etatInitial(genId);
  const F = etat.fenetres[0]!.id;
  if (o.prive) etat = appliquer(etat, { type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F }, genId);
  const { c, dossierActions } = espace({
    gitlab: { nom: "GitLab", sources: { compte: ["gitlab.com"] } },
    leboncoin: { nom: "Leboncoin", saisie: { libelle: "Recherche" }, sources: { web: true } },
  });
  const faux = fauxNoyau(o.direct, o.issue);
  let changes = 0;
  const agies: Action[] = [];
  let horloge = 10_000;
  const agir = (a: Action) => {
    agies.push(a);
    etat = appliquer(etat, a, genId);
  };
  const s = creerServiceActions({
    etat: () => etat,
    agir,
    noyau: () => faux.noyau,
    chemins: () => c,
    dossierActions,
    maintenant: () => horloge,
    surChange: () => void changes++,
  });
  return { s, F, c, dossierActions, agies, agir, ...faux, etat: () => etat, avancer: (ms: number) => (horloge += ms), changes: () => changes };
}

test("dans un espace privé, chaque appel des actions est refusé", async () => {
  const { s, F, lances, arretes, agies, dossierActions } = service({ prive: true });
  const ex = await executer(dossierActions, "leboncoin", { u: "https://a.test/" });
  expect(await s.liste(F)).toEqual([]);
  expect(await s.ouvrir(F, "gitlab", null)).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
  expect(await s.lancer(F, "gitlab", null)).toEqual({ statut: "invalide", erreur: ACTIONS_EN_ESPACE_PRIVE });
  s.arreter(F, "gitlab");
  expect(await s.page(F, "gitlab", null)).toBeNull();
  expect(await s.executions(F, "gitlab")).toEqual([]);
  expect(await s.direct(F)).toEqual({ courantes: [], enAttente: [] });
  await s.ouvrirLien(F, "leboncoin", ex, "https://a.test/");
  expect(s.profilsPourAccord(F)).toEqual([]);
  expect(await s.accorder(F, { id: "gitlab", profil: "defaut", compte: ["gitlab.com"], publiques: [] })).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
  await s.refuserAccord(F, "gitlab");
  expect(await s.supprimer(F, "gitlab")).toEqual({ ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE });
  await s.voirWorkflow(F, "gitlab");
  expect(lances).toEqual([]);
  expect(arretes).toEqual([]);
  expect(agies.filter((a) => a.type !== "creerEspace")).toEqual([]);
});

test("ouvrir : ouvre la page de l'action titrée de son nom puis la lance", async () => {
  const { s, F, lances, etat } = service();
  expect(await s.ouvrir(F, "gitlab", null)).toEqual({ ok: true });
  const onglets = Object.values(etat().onglets);
  expect(onglets).toHaveLength(1);
  expect(onglets[0]).toMatchObject({ url: "webaios://action/gitlab", titre: "GitLab" });
  expect(lances).toEqual([{ id: "gitlab" }]);
  expect(await s.ouvrir(F, "leboncoin", "clio lyon")).toEqual({ ok: true });
  expect(lances).toEqual([{ id: "gitlab" }, { id: "leboncoin", saisie: "clio lyon" }]);
});

test("ouvrir : sans la saisie requise, la page s'ouvre sans rien lancer ; action inconnue refusée", async () => {
  const { s, F, lances, etat } = service();
  expect(await s.ouvrir(F, "leboncoin", null)).toEqual({ ok: true });
  expect(await s.ouvrir(F, "leboncoin", "  ")).toEqual({ ok: true });
  expect(Object.values(etat().onglets).map((o) => o.url)).toEqual(["webaios://action/leboncoin"]);
  expect(lances).toEqual([]);
  expect(await s.ouvrir(F, "inconnue", null)).toEqual({ ok: false, erreur: "Action inconnue" });
  expect(await s.ouvrir(F, "../x", null)).toEqual({ ok: false, erreur: "Action inconnue" });
});

test("ouvrir pendant qu'elle tourne : amène sur l'onglet qui la montre, sans seconde exécution", async () => {
  const direct: EtatActions = { courantes: [{ action: "gitlab", debut: DEBUT, saisie: null, essai: false, etape: "workflow", blocs: {} }], enAttente: [] };
  const { s, F, lances, etat, agies, agir } = service({ direct });
  agies.length = 0;
  expect(await s.ouvrir(F, "gitlab", null)).toEqual({ ok: true });
  const page = Object.values(etat().onglets)[0]!;
  // Un autre onglet passe devant ; relancer revient sur la page de l'action.
  agir({ type: "ouvrirOnglet", fenetreId: F, url: "https://a.test/" });
  expect(await s.ouvrir(F, "gitlab", null)).toEqual({ ok: true });
  expect(Object.values(etat().onglets).filter((o) => o.url.startsWith("webaios://action/"))).toHaveLength(1);
  expect(etat().fenetres[0]!.actif[etat().fenetres[0]!.espaceActif]).toBe(page.id);
  expect(lances).toEqual([]);
});

test("ouvrirLien : ouvre un onglet actif pour une adresse des résultats, un par seconde au plus", async () => {
  const { s, F, dossierActions, agies, avancer } = service();
  const ex = await executer(dossierActions, "gitlab", { tickets: [{ url: "https://gitlab.com/1" }, { url: "https://gitlab.com/2" }] });
  await s.ouvrirLien(F, "gitlab", ex, "https://gitlab.com/1");
  await s.ouvrirLien(F, "gitlab", ex, "https://gitlab.com/2"); // trop rapproché
  await s.ouvrirLien(F, "gitlab", ex, "javascript:alert(1)");
  await s.ouvrirLien(F, "gitlab", ex, "https://gitlab.com/3"); // absente
  avancer(1000);
  await s.ouvrirLien(F, "gitlab", ex, "https://gitlab.com/2");
  expect(agies).toEqual([
    { type: "ouvrirOnglet", fenetreId: F, url: "https://gitlab.com/1", activer: true },
    { type: "ouvrirOnglet", fenetreId: F, url: "https://gitlab.com/2", activer: true },
  ]);
});

test("voirWorkflow ouvre le constructeur sur l'action ; lancer et arrêter passent au noyau", async () => {
  const { s, F, etat, lances, arretes } = service();
  await s.voirWorkflow(F, "gitlab");
  expect(Object.values(etat().onglets)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", titre: "Workflow — GitLab" });
  expect(await s.lancer(F, "leboncoin", "clio")).toEqual({ statut: "reussie", execution: "x" });
  s.arreter(F, "leboncoin");
  expect(lances).toEqual([{ id: "leboncoin", saisie: "clio" }]);
  expect(arretes).toEqual(["leboncoin"]);
});

test("ouvrir : un lancement refusé sans exécution écrite (atelier arrêté…) est montré par la liste, jusqu'à une exécution plus récente", async () => {
  const issue: ResultatLancement = { statut: "echouee", erreur: "Docker n'est pas démarré", erreurNoyau: true };
  const { s, F, dossierActions, changes, avancer } = service({ issue });
  expect(await s.ouvrir(F, "gitlab", null)).toEqual({ ok: true });
  await new Promise((ok) => setTimeout(ok, 0));
  expect(changes()).toBe(1);
  expect((await s.liste(F)).find((a) => a.id === "gitlab")?.refus).toBe("Docker n'est pas démarré");
  expect((await s.liste(F)).find((a) => a.id === "leboncoin")?.refus).toBeUndefined();
  // Une exécution écrite depuis (lancée par l'agent…) : le refus ne compte plus.
  avancer(1000);
  await executer(dossierActions, "gitlab", { a: 1 });
  expect((await s.liste(F)).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
});

test("lancer (Relancer) note aussi un refus sans exécution ; une issue avec exécution n'en laisse pas", async () => {
  const { s, F, changes } = service({ issue: { statut: "invalide", erreur: "Cette action n'a pas de workflow.json", erreurNoyau: true } });
  await s.ouvrir(F, "gitlab", null);
  await new Promise((ok) => setTimeout(ok, 0));
  expect((await s.liste(F)).find((a) => a.id === "gitlab")?.refus).toBe("Cette action n'a pas de workflow.json");
  const r = await s.lancer(F, "gitlab", null);
  expect(r.erreur).toBe("Cette action n'a pas de workflow.json");
  expect(changes()).toBe(2);
  const ok = service();
  await ok.s.ouvrir(ok.F, "gitlab", null);
  await new Promise((fin) => setTimeout(fin, 0));
  expect((await ok.s.liste(ok.F)).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
  expect(ok.changes()).toBe(0);
});

test("supprimer et retirer l'accord arrêtent d'abord l'action qui tourne", async () => {
  const { s, F, appels } = service();
  await s.refuserAccord(F, "gitlab");
  expect(appels).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
  appels.length = 0;
  expect(await s.supprimer(F, "gitlab")).toEqual({ ok: true });
  expect(appels).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
});

test("supprimer pendant un lancement : l'exécution arrêtée qui finit sans rien écrire ne laisse pas de refus à une action recréée", async () => {
  let finir!: (r: ResultatLancement) => void;
  const issue = new Promise<ResultatLancement>((ok) => (finir = ok));
  const { s, F, changes } = service({ issue });
  await s.ouvrir(F, "gitlab", null);
  expect(await s.supprimer(F, "gitlab")).toEqual({ ok: true });
  finir({ statut: "echouee", erreur: "Action inconnue", erreurNoyau: true });
  await new Promise((ok) => setTimeout(ok, 0));
  expect(changes()).toBe(0);
  expect((await s.liste(F)).find((a) => a.id === "gitlab")?.refus).toBeUndefined();
});
