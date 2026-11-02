import { beforeEach, expect, test } from "vitest";
import { DROITS_DEV, PolitiqueAcces } from "../../src/acces/politique.js";
import type { OngletInfo } from "../../src/mcp/pont.js";

const github: OngletInfo = { id: "1", titre: "svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: OngletInfo = { id: "2", titre: "Gmail", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const demo: OngletInfo = { id: "3", titre: "Démo", url: "http://localhost:5280/", espace: "perso" };
let p: PolitiqueAcces;
beforeEach(() => (p = new PolitiqueAcces()));

test("aucun accès par défaut", () => {
  expect(p.peutLire(gmail)).toBe(false);
});

test("interaction depuis un onglet → accès à cet onglet seulement", () => {
  p.interactionUtilisateur(github);
  expect(p.peutLire(github)).toBe(true);
  expect(p.peutLire(gmail)).toBe(false);
});

test("onglet ouvert par l'agent → accès", () => {
  p.ongletOuvertParAgent(demo);
  expect(p.peutLire(demo)).toBe(true);
});

test("accorder (réponse oui à une demande) → accès", () => {
  p.accorder(gmail);
  expect(p.peutLire(gmail)).toBe(true);
});

test("L'utilisateur change de site → autorisation caduque, même s'il revient", () => {
  p.interactionUtilisateur(github);
  p.ongletNavigue(github.id, "https://mail.google.com/");
  expect(p.peutLire({ ...github, url: "https://mail.google.com/" })).toBe(false);
  p.ongletNavigue(github.id, github.url);
  expect(p.peutLire(github)).toBe(false);
});

test("même site, autre page → accès conservé", () => {
  p.interactionUtilisateur(github);
  p.ongletNavigue(github.id, "https://github.com/sveltejs/kit");
  expect(p.peutLire({ ...github, url: "https://github.com/sveltejs/kit" })).toBe(true);
});

test("l'URL actuelle compte même sans événement de navigation", () => {
  p.interactionUtilisateur(github);
  expect(p.peutLire({ ...github, url: "https://evil.test/" })).toBe(false);
});

test("l'agent navigue son onglet de démo vers un autre port → accès conservé", () => {
  p.ongletOuvertParAgent(demo);
  p.navigationParAgent(demo.id, "http://localhost:5281/");
  expect(p.peutLire({ ...demo, url: "http://localhost:5281/" })).toBe(true);
});

test("reinitialiser retire tout ; ongletFerme retire l'onglet", () => {
  p.interactionUtilisateur(github);
  p.accorder(gmail);
  p.ongletFerme(gmail.id);
  expect(p.peutLire(gmail)).toBe(false);
  expect(p.peutLire(github)).toBe(true);
  p.reinitialiser();
  expect(p.peutLire(github)).toBe(false);
});

test("URL invalide → jamais lisible", () => {
  p.accorder({ ...github, url: "pas une url" });
  expect(p.peutLire({ ...github, url: "pas une url" })).toBe(false);
});

test("l'agent ouvre lui-même Gmail → pas d'accès sans demande", () => {
  p.ongletOuvertParAgent({ ...gmail, id: "9" });
  expect(p.peutLire({ ...gmail, id: "9" })).toBe(false);
});

test("l'agent navigue sa démo vers un site extérieur → accès perdu", () => {
  p.ongletOuvertParAgent(demo);
  p.navigationParAgent(demo.id, "https://mail.google.com/");
  expect(p.peutLire({ ...demo, url: "https://mail.google.com/" })).toBe(false);
});

test("démo sur 127.0.0.1 ouverte par l'agent → accès", () => {
  const d = { ...demo, url: "http://127.0.0.1:5280/" };
  p.ongletOuvertParAgent(d);
  expect(p.peutLire(d)).toBe(true);
});

test("l'agent navigue sur le même site un onglet que l'utilisateur lui a donné → accès conservé", () => {
  p.interactionUtilisateur(github);
  p.navigationParAgent(github.id, "https://github.com/sveltejs/kit");
  expect(p.peutLire({ ...github, url: "https://github.com/sveltejs/kit" })).toBe(true);
});

// --- Droits des outils de développement ---

const app: OngletInfo = { id: "4", titre: "Mon app", url: "http://localhost:8123/", espace: "perso", application: "mon-app" };
const port3000: OngletInfo = { id: "5", titre: "Dev", url: "http://localhost:3000/", espace: "perso" };

test("construite : app:<dossier> et localhost:5285 ouvert par l'agent ont les quatre droits ; localhost:3000 n'en a aucun", () => {
  const demo5285 = { ...demo, url: "http://localhost:5285/" };
  p.ongletOuvertParAgent(app);
  p.ongletOuvertParAgent(demo5285);
  p.ongletOuvertParAgent(port3000);
  expect(p.droitsDev(app)).toEqual(["console", "reseau", "performances", "agir"]);
  expect(p.droitsDev(demo5285)).toEqual(["console", "reseau", "performances", "agir"]);
  expect(p.estConstruite(demo5285)).toBe(true);
  expect(p.droitsDev(port3000)).toEqual([]);
  expect(p.estConstruite(port3000)).toBe(false);
});

test("construite : le prédicat de port est configurable", () => {
  const q = new PolitiqueAcces({ portConstruit: (port) => port === 3000 });
  q.ongletOuvertParAgent(port3000);
  expect(q.estConstruite(port3000)).toBe(true);
});

test("construite : quitter l'origine retire les droits ; y renaviguer (agent) les rend", () => {
  p.ongletOuvertParAgent(demo);
  p.navigationParAgent(demo.id, "https://github.com/");
  expect(p.droitsDev({ ...demo, url: "https://github.com/" })).toEqual([]);
  p.navigationParAgent(demo.id, demo.url);
  expect(p.droitsDev(demo)).toHaveLength(4);
  p.ongletNavigue(demo.id, "https://github.com/");
  p.ongletNavigue(demo.id, demo.url);
  expect(p.droitsDev(demo)).toEqual([]);
});

test("accorderDev : seuls les droits cochés ; tombent au changement de site, à la fermeture, à reinitialiser", () => {
  p.accorderDev(github, ["console", "agir"], ["reseau"]);
  expect(p.droitsDev(github)).toEqual(["console", "agir"]);
  p.ongletNavigue(github.id, "https://mail.google.com/");
  expect(p.droitsDev(github)).toEqual([]);
  p.accorderDev(github, ["console"], []);
  p.ongletFerme(github.id);
  expect(p.droitsDev(github)).toEqual([]);
  p.accorderDev(github, ["console"], []);
  p.reinitialiser();
  expect(p.droitsDev(github)).toEqual([]);
});

test("refus : peutDemander faux pour (onglet, droit) refusé jusqu'à interactionUtilisateur ; un autre droit reste demandable", () => {
  p.accorderDev(github, [], ["reseau"]);
  expect(p.peutDemander(github.id, "reseau")).toBe(false);
  expect(p.peutDemander(github.id, "console")).toBe(true);
  p.interactionUtilisateur(gmail);
  expect(p.peutDemander(github.id, "reseau")).toBe(true);
  p.accorderDev(github, [], ["reseau"]);
  p.reinitialiser();
  expect(p.peutDemander(github.id, "reseau")).toBe(true);
});

test("couper(id, \"agir\") retire ce seul droit ; couper(id) retire tout, lecture comprise ; une construite coupée le reste jusqu'à reinitialiser", () => {
  p.interactionUtilisateur(github);
  p.accorderDev(github, ["console", "agir"], []);
  p.couper(github.id, "agir");
  expect(p.droitsDev(github)).toEqual(["console"]);
  p.couper(github.id);
  expect(p.droitsDev(github)).toEqual([]);
  expect(p.peutLire(github)).toBe(false);

  p.ongletOuvertParAgent(demo);
  p.couper(demo.id, "agir");
  expect(p.droitsDev(demo)).toEqual(["console", "reseau", "performances"]);
  p.couper(demo.id);
  expect(p.droitsDev(demo)).toEqual([]);
  p.navigationParAgent(demo.id, "http://localhost:5281/");
  expect(p.droitsDev({ ...demo, url: "http://localhost:5281/" })).toEqual([]);
  p.reinitialiser();
  expect(p.droitsDev({ ...demo, url: "http://localhost:5281/" })).toHaveLength(4);
});

test("etat() : lecture, droits, construite, enCours (utilisation true/false équilibrés)", () => {
  expect(p.etat()).toEqual({});
  p.interactionUtilisateur(github);
  p.accorderDev(gmail, ["reseau"], []);
  p.ongletOuvertParAgent(demo);
  p.utilisation(github.id, true);
  p.utilisation(github.id, true);
  p.utilisation(github.id, false);
  expect(p.etat()[github.id]).toEqual({ lecture: true, droits: [], construite: false, enCours: true });
  expect(p.etat()[gmail.id]).toEqual({ lecture: false, droits: ["reseau"], construite: false, enCours: false });
  expect(p.etat()[demo.id]).toEqual({ lecture: true, droits: [...DROITS_DEV], construite: true, enCours: false });
  p.utilisation(github.id, false);
  expect(p.etat()[github.id]?.enCours).toBe(false);
  p.ongletFerme(demo.id);
  expect(p.etat()[demo.id]).toBeUndefined();
});

test("surChange appelé à chaque mutation, désabonnement effectif", () => {
  let n = 0;
  const stop = p.surChange(() => n++);
  p.interactionUtilisateur(github);
  p.accorderDev(github, ["console"], []);
  p.couper(github.id, "console");
  p.utilisation(github.id, true);
  p.ongletNavigue(github.id, "https://x.test/");
  p.navigationParAgent(github.id, "https://y.test/");
  p.ongletFerme(github.id);
  p.reinitialiser();
  expect(n).toBe(8);
  stop();
  p.interactionUtilisateur(github);
  expect(n).toBe(8);
});

test("construite coupée : relancer l'appli (fermeture puis réouverture de app:x) ne rend pas les droits ; reinitialiser les rend", () => {
  const app: OngletInfo = { id: "app:x", titre: "X", url: "http://localhost:5281/", espace: "", application: "x" };
  p.construite(app);
  p.couper("app:x");
  p.ongletFerme("app:x");
  // relancée sur un autre port : même fenêtre d'appli
  const relancee = { ...app, url: "http://localhost:5290/" };
  p.construite(relancee);
  expect(p.estConstruite(relancee)).toBe(true);
  expect(p.droitsDev(relancee)).toEqual([]);
  // l'agent ouvre l'ancienne origine de l'appli dans un onglet : coupée aussi
  const onglet: OngletInfo = { id: "9", titre: "X", url: "http://localhost:5281/", espace: "" };
  p.ongletOuvertParAgent(onglet);
  expect(p.droitsDev(onglet)).toEqual([]);
  p.reinitialiser();
  expect(p.droitsDev(relancee)).toEqual(DROITS_DEV);
  expect(p.droitsDev(onglet)).toEqual(DROITS_DEV);
});

test("démo coupée : un nouvel onglet de l'agent sur la même origine n'a aucun droit ; une autre origine si ; un seul droit coupé reste coupé", () => {
  p.ongletOuvertParAgent(demo);
  p.couper(demo.id, "agir");
  p.ongletFerme(demo.id);
  const nouveau: OngletInfo = { ...demo, id: "4" };
  p.ongletOuvertParAgent(nouveau);
  expect(p.droitsDev(nouveau)).toEqual(["console", "reseau", "performances"]);
  p.couper(nouveau.id);
  p.ongletFerme(nouveau.id);
  const encore: OngletInfo = { ...demo, id: "5" };
  p.ongletOuvertParAgent(encore);
  expect(p.droitsDev(encore)).toEqual([]);
  const autre: OngletInfo = { ...demo, id: "6", url: "http://localhost:5281/" };
  p.ongletOuvertParAgent(autre);
  expect(p.droitsDev(autre)).toEqual(DROITS_DEV);
  // L'utilisateur réaccorde lui-même : le droit revient
  p.accorderDev(encore, ["console"], []);
  expect(p.droitsDev(encore)).toEqual(["console"]);
  p.reinitialiser();
  expect(p.droitsDev(encore)).toEqual(DROITS_DEV);
});

test("conversation : change à chaque reinitialiser", () => {
  const avant = p.conversation;
  p.reinitialiser();
  expect(p.conversation).toBe(avant + 1);
});

test("accorder signale le changement (la pastille de lecture suit) ; rien si l'accès est déjà là", () => {
  let n = 0;
  p.surChange(() => n++);
  p.accorder(gmail);
  expect(n).toBe(1);
  p.accorder(gmail);
  expect(n).toBe(1);
});

const vidola: OngletInfo = { id: "site:vidola", titre: "Vidola", url: "https://vidola-a.example/film/1", espace: "", site: "vidola" };
const youtube: OngletInfo = { id: "site:youtube", titre: "YouTube", url: "https://www.youtube.com/", espace: "", site: "youtube" };

test("accorderLectureSite(\"vidola\") : peutLire de site:vidola vrai, de site:youtube faux ; nouvelle conversation : faux", () => {
  expect(p.peutLire(vidola)).toBe(false);
  let n = 0;
  p.surChange(() => n++);
  p.accorderLectureSite("vidola");
  expect(n).toBe(1);
  expect(p.lectureSiteAccordee("vidola")).toBe(true);
  expect(p.peutLire(vidola)).toBe(true);
  // L'accord porte sur l'appli, pas sur l'origine : la page peut changer dans le site.
  expect(p.peutLire({ ...vidola, url: "https://vidola-b.example/serie/2" })).toBe(true);
  expect(p.peutLire(youtube)).toBe(false);
  p.reinitialiser();
  expect(p.lectureSiteAccordee("vidola")).toBe(false);
  expect(p.peutLire(vidola)).toBe(false);
});

test("appli de site : une autorisation d'origine (onglet du même domaine, ou accorder sur la fenêtre) ne l'ouvre pas", () => {
  const onglet: OngletInfo = { id: "7", titre: "Vidola", url: "https://vidola-a.example/film/1", espace: "perso" };
  p.accorder(onglet);
  p.interactionUtilisateur(onglet);
  expect(p.peutLire(onglet)).toBe(true);
  expect(p.peutLire(vidola)).toBe(false);
  // Même posée sur l'id de la fenêtre, une autorisation d'origine ne compte pas.
  p.accorder(vidola);
  p.interactionUtilisateur(vidola);
  p.ongletOuvertParAgent(vidola);
  expect(p.peutLire(vidola)).toBe(false);
  // Ni les données d'un widget ou d'une action du même nom.
  p.accorderDonneesWidget("vidola");
  p.accorderDonneesAction("vidola");
  expect(p.peutLire(vidola)).toBe(false);
});

test("appli de site : ses droits de développement ne valent qu'avec son accord ; une nouvelle conversation retire les deux", () => {
  p.accorderDev(vidola, ["console"], []);
  expect(p.droitsDev(vidola)).toEqual([]);
  p.accorderLectureSite("vidola");
  expect(p.droitsDev(vidola)).toEqual(["console"]);
  p.reinitialiser();
  expect(p.droitsDev(vidola)).toEqual([]);
});
