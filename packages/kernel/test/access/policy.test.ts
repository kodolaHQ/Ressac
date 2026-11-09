import { beforeEach, expect, test, vi } from "vitest";
import { DROITS_DEV, AccessPolicy } from "../../src/access/policy.js";
import type { TabInfo } from "../../src/mcp/pont.js";

const github: TabInfo = { id: "1", titre: "svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: TabInfo = { id: "2", titre: "Gmail", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const demo: TabInfo = { id: "3", titre: "Démo", url: "http://localhost:5280/", espace: "perso" };
let p: AccessPolicy;
beforeEach(() => (p = new AccessPolicy()));

test("no access by default", () => {
  expect(p.peutLire(gmail)).toBe(false);
});

test("interaction from a tab → access to that tab only", () => {
  p.interactionUtilisateur(github);
  expect(p.peutLire(github)).toBe(true);
  expect(p.peutLire(gmail)).toBe(false);
});

test("tab opened by the agent → access", () => {
  p.ongletOuvertParAgent(demo);
  expect(p.peutLire(demo)).toBe(true);
});

test("accorder (yes answer to a request) → access", () => {
  p.accorder(gmail);
  expect(p.peutLire(gmail)).toBe(true);
});

test("The user changes site → authorization lapsed, even if they come back", () => {
  p.interactionUtilisateur(github);
  p.ongletNavigue(github.id, "https://mail.google.com/");
  expect(p.peutLire({ ...github, url: "https://mail.google.com/" })).toBe(false);
  p.ongletNavigue(github.id, github.url);
  expect(p.peutLire(github)).toBe(false);
});

test("same site, other page → access kept", () => {
  p.interactionUtilisateur(github);
  p.ongletNavigue(github.id, "https://github.com/sveltejs/kit");
  expect(p.peutLire({ ...github, url: "https://github.com/sveltejs/kit" })).toBe(true);
});

test("the current URL counts even without a navigation event", () => {
  p.interactionUtilisateur(github);
  expect(p.peutLire({ ...github, url: "https://evil.test/" })).toBe(false);
});

test("the agent navigates its demo tab to another port → access kept", () => {
  p.ongletOuvertParAgent(demo);
  p.navigationParAgent(demo.id, "http://localhost:5281/");
  expect(p.peutLire({ ...demo, url: "http://localhost:5281/" })).toBe(true);
});

test("reinitialiser removes everything; ongletFerme removes the tab", () => {
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

test("the agent opens Gmail itself → no access without a request", () => {
  p.ongletOuvertParAgent({ ...gmail, id: "9" });
  expect(p.peutLire({ ...gmail, id: "9" })).toBe(false);
});

test("the agent navigates its demo to an outside site → access lost", () => {
  p.ongletOuvertParAgent(demo);
  p.navigationParAgent(demo.id, "https://mail.google.com/");
  expect(p.peutLire({ ...demo, url: "https://mail.google.com/" })).toBe(false);
});

test("demo on 127.0.0.1 opened by the agent → access", () => {
  const d = { ...demo, url: "http://127.0.0.1:5280/" };
  p.ongletOuvertParAgent(d);
  expect(p.peutLire(d)).toBe(true);
});

test("the agent navigates on the same site a tab the user gave it → access kept", () => {
  p.interactionUtilisateur(github);
  p.navigationParAgent(github.id, "https://github.com/sveltejs/kit");
  expect(p.peutLire({ ...github, url: "https://github.com/sveltejs/kit" })).toBe(true);
});

// --- Dev tools rights ---

const app: TabInfo = { id: "4", titre: "Mon app", url: "http://localhost:8123/", espace: "perso", application: "mon-app" };
const port3000: TabInfo = { id: "5", titre: "Dev", url: "http://localhost:3000/", espace: "perso" };

test("built: app:<folder> and localhost:5285 opened by the agent have the four rights; localhost:3000 has none", () => {
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

test("built: the default demo range follows WEBAIOS_PORTS_CONTENEUR", () => {
  vi.stubEnv("WEBAIOS_PORTS_CONTENEUR", "5300-5319");
  try {
    const q = new AccessPolicy();
    const d5305 = { ...demo, url: "http://localhost:5305/" };
    const d5285 = { ...demo, id: "6", url: "http://localhost:5285/" };
    q.ongletOuvertParAgent(d5305);
    q.ongletOuvertParAgent(d5285);
    expect(q.estConstruite(d5305)).toBe(true);
    expect(q.estConstruite(d5285)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("built: the port predicate is configurable", () => {
  const q = new AccessPolicy({ portConstruit: (port) => port === 3000 });
  q.ongletOuvertParAgent(port3000);
  expect(q.estConstruite(port3000)).toBe(true);
});

test("built: leaving the origin removes the rights; navigating back to it (agent) restores them", () => {
  p.ongletOuvertParAgent(demo);
  p.navigationParAgent(demo.id, "https://github.com/");
  expect(p.droitsDev({ ...demo, url: "https://github.com/" })).toEqual([]);
  p.navigationParAgent(demo.id, demo.url);
  expect(p.droitsDev(demo)).toHaveLength(4);
  p.ongletNavigue(demo.id, "https://github.com/");
  p.ongletNavigue(demo.id, demo.url);
  expect(p.droitsDev(demo)).toEqual([]);
});

test("accorderDev: only the checked rights; they drop on site change, on close, on reinitialiser", () => {
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

test("refusal: peutDemander false for a refused (tab, right) until interactionUtilisateur; another right stays requestable", () => {
  p.accorderDev(github, [], ["reseau"]);
  expect(p.peutDemander(github.id, "reseau")).toBe(false);
  expect(p.peutDemander(github.id, "console")).toBe(true);
  p.interactionUtilisateur(gmail);
  expect(p.peutDemander(github.id, "reseau")).toBe(true);
  p.accorderDev(github, [], ["reseau"]);
  p.reinitialiser();
  expect(p.peutDemander(github.id, "reseau")).toBe(true);
});

test("couper(id, \"agir\") removes that right only; couper(id) removes everything, reading included; a built one that is cut stays so until reinitialiser", () => {
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

test("etat(): reading, rights, built, enCours (utilisation true/false balanced)", () => {
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

test("surChange called on each mutation, unsubscribe effective", () => {
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

test("cut built: relaunching the app (closing then reopening app:x) does not restore the rights; reinitialiser does", () => {
  const app: TabInfo = { id: "app:x", titre: "X", url: "http://localhost:5281/", espace: "", application: "x" };
  p.construite(app);
  p.couper("app:x");
  p.ongletFerme("app:x");
  // relaunched on another port: same app window
  const relaunched = { ...app, url: "http://localhost:5290/" };
  p.construite(relaunched);
  expect(p.estConstruite(relaunched)).toBe(true);
  expect(p.droitsDev(relaunched)).toEqual([]);
  // the agent opens the app's old origin in a tab: cut as well
  const tab: TabInfo = { id: "9", titre: "X", url: "http://localhost:5281/", espace: "" };
  p.ongletOuvertParAgent(tab);
  expect(p.droitsDev(tab)).toEqual([]);
  p.reinitialiser();
  expect(p.droitsDev(relaunched)).toEqual(DROITS_DEV);
  expect(p.droitsDev(tab)).toEqual(DROITS_DEV);
});

test("cut demo: a new agent tab on the same origin has no right; another origin does; a single cut right stays cut", () => {
  p.ongletOuvertParAgent(demo);
  p.couper(demo.id, "agir");
  p.ongletFerme(demo.id);
  const fresh: TabInfo = { ...demo, id: "4" };
  p.ongletOuvertParAgent(fresh);
  expect(p.droitsDev(fresh)).toEqual(["console", "reseau", "performances"]);
  p.couper(fresh.id);
  p.ongletFerme(fresh.id);
  const encore: TabInfo = { ...demo, id: "5" };
  p.ongletOuvertParAgent(encore);
  expect(p.droitsDev(encore)).toEqual([]);
  const other: TabInfo = { ...demo, id: "6", url: "http://localhost:5281/" };
  p.ongletOuvertParAgent(other);
  expect(p.droitsDev(other)).toEqual(DROITS_DEV);
  // The user grants again themselves: the right comes back
  p.accorderDev(encore, ["console"], []);
  expect(p.droitsDev(encore)).toEqual(["console"]);
  p.reinitialiser();
  expect(p.droitsDev(encore)).toEqual(DROITS_DEV);
});

test("conversation: changes at each reinitialiser", () => {
  const before = p.conversation;
  p.reinitialiser();
  expect(p.conversation).toBe(before + 1);
});

test("accorder signals the change (the read badge follows); nothing if access is already there", () => {
  let n = 0;
  p.surChange(() => n++);
  p.accorder(gmail);
  expect(n).toBe(1);
  p.accorder(gmail);
  expect(n).toBe(1);
});

const vidola: TabInfo = { id: "site:vidola", titre: "Vidola", url: "https://vidola-a.example/film/1", espace: "", site: "vidola" };
const youtube: TabInfo = { id: "site:youtube", titre: "YouTube", url: "https://www.youtube.com/", espace: "", site: "youtube" };

test("accorderLectureSite(\"vidola\") : peutLire de site:vidola vrai, de site:youtube faux ; nouvelle conversation : faux", () => {
  expect(p.peutLire(vidola)).toBe(false);
  let n = 0;
  p.surChange(() => n++);
  p.accorderLectureSite("vidola");
  expect(n).toBe(1);
  expect(p.lectureSiteAccordee("vidola")).toBe(true);
  expect(p.peutLire(vidola)).toBe(true);
  // The grant is about the app, not the origin: the page may change within the site.
  expect(p.peutLire({ ...vidola, url: "https://vidola-b.example/serie/2" })).toBe(true);
  expect(p.peutLire(youtube)).toBe(false);
  p.reinitialiser();
  expect(p.lectureSiteAccordee("vidola")).toBe(false);
  expect(p.peutLire(vidola)).toBe(false);
});

test("site app: an origin authorization (tab of the same domain, or accorder on the window) does not open it", () => {
  const tab: TabInfo = { id: "7", titre: "Vidola", url: "https://vidola-a.example/film/1", espace: "perso" };
  p.accorder(tab);
  p.interactionUtilisateur(tab);
  expect(p.peutLire(tab)).toBe(true);
  expect(p.peutLire(vidola)).toBe(false);
  // Even set on the window id, an origin authorization does not count.
  p.accorder(vidola);
  p.interactionUtilisateur(vidola);
  p.ongletOuvertParAgent(vidola);
  expect(p.peutLire(vidola)).toBe(false);
  // Nor does the data of a widget or an action of the same name.
  p.accorderDonneesWidget("vidola");
  p.accorderDonneesAction("vidola");
  expect(p.peutLire(vidola)).toBe(false);
});

test("site app: its dev rights are only valid with its grant; a new conversation removes both", () => {
  p.accorderDev(vidola, ["console"], []);
  expect(p.droitsDev(vidola)).toEqual([]);
  p.accorderLectureSite("vidola");
  expect(p.droitsDev(vidola)).toEqual(["console"]);
  p.reinitialiser();
  expect(p.droitsDev(vidola)).toEqual([]);
});

test("reading of a site app tied to the hash of its declaration: another hash does not count", () => {
  p.accorderLectureSite("vidola", "e1");
  expect(p.lectureSiteAccordee("vidola", "e1")).toBe(true);
  expect(p.peutLire({ ...vidola, empreinte: "e1" })).toBe(true);
  expect(p.lectureSiteAccordee("vidola", "e2")).toBe(false);
  expect(p.lectureSiteAccordee("vidola")).toBe(false);
  expect(p.peutLire({ ...vidola, empreinte: "e2" })).toBe(false);
  p.accorderDev({ ...vidola, empreinte: "e1" }, ["console"], []);
  expect(p.droitsDev({ ...vidola, empreinte: "e1" })).toEqual(["console"]);
  expect(p.droitsDev({ ...vidola, empreinte: "e2" })).toEqual([]);
  // Le nouvel accord remplace l'ancien.
  p.accorderLectureSite("vidola", "e2");
  expect(p.lectureSiteAccordee("vidola", "e2")).toBe(true);
  expect(p.lectureSiteAccordee("vidola", "e1")).toBe(false);
});

test("retirerLectureSite (app deleted): the grant drops, the badge follows; pending cards see it (retraitsLectureSite)", () => {
  p.accorderLectureSite("vidola", "e1");
  p.accorderLectureSite("youtube", "y");
  let n = 0;
  p.surChange(() => n++);
  p.retirerLectureSite("vidola");
  expect(n).toBe(1);
  expect(p.lectureSiteAccordee("vidola", "e1")).toBe(false);
  expect(p.lectureSiteAccordee("youtube", "y")).toBe(true);
  // Even without a grant (a card still pending), the removal is counted and signaled.
  const before = p.retraitsLectureSite("vidola");
  p.retirerLectureSite("vidola");
  expect(p.retraitsLectureSite("vidola")).toBe(before + 1);
  expect(p.retraitsLectureSite("youtube")).toBe(0);
  expect(n).toBe(2);
});
