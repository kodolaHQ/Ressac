import { expect, test, vi } from "vitest";
import { apply } from "../../core/etat/actions";
import { initialState } from "../../core/etat/etat-initial";
import type { Action } from "../../shared/api";
import { siteDe, type BrowserState } from "../../shared/modele";
import { waitForRights, waitForResponse, changementsPolitique, allowedDecision, spacesBecamePrivate, tabInfos, activeTabOf, siteTab, SITE_PREFIX, staleQuestion, staleSiteQuestion, resolveSpace } from "../../core/agent/pont";

/** Sets a space's private flag, leaving the rest untouched. */
function reglerPrive(e: BrowserState, ag: (a: Action) => unknown, id: string, prive: boolean) {
  const esp = e.espaces.find((x) => x.id === id)!;
  ag({ type: "reglerEspace", id, nom: esp.nom, icone: esp.icone, prive, profil: esp.profil });
}

function preparer() {
  let n = 0;
  const g = () => `g${++n}`;
  let e: BrowserState = initialState(g);
  const ag = (a: Action) => (e = apply(e, a, g));
  const F = e.fenetres[0]!.id;
  ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://a.test/" });
  ag({ type: "ouvrirFenetre", id: "F2" });
  ag({ type: "ouvrirOnglet", fenetreId: "F2", url: "https://b.test/" });
  return { e: () => e, ag, F };
}

test("infosOnglets: all tabs of all windows, espace = name", () => {
  const { e } = preparer();
  expect(tabInfos(e()).map((o) => ({ url: o.url, espace: o.espace }))).toEqual([
    { url: "https://a.test/", espace: "Perso" },
    { url: "https://b.test/", espace: "Perso" },
  ]);
  expect(tabInfos(e())[0]).toEqual({ id: expect.any(String), titre: "https://a.test/", url: "https://a.test/", espace: "Perso" });
});

test("ongletActifDe: null on an empty page, the active space's active tab otherwise", () => {
  const { e, ag, F } = preparer();
  expect(activeTabOf(e(), F)?.url).toBe("https://a.test/");
  expect(activeTabOf(e(), undefined)).toBeNull();
  ag({ type: "afficherPageVide", fenetreId: F });
  expect(activeTabOf(e(), F)).toBeNull();
});

test("resoudreEspace: by id, by name ignoring case, otherwise the active space", () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  const f = e().fenetres.find((x) => x.id === F)!;
  const boulot = e().espaces.find((x) => x.nom === "Boulot")!.id;
  expect(resolveSpace(e(), f, "boulot")).toBe(boulot);
  expect(resolveSpace(e(), f, boulot)).toBe(boulot);
  expect(resolveSpace(e(), f, "inconnu")).toBe(f.espaceActif);
  expect(resolveSpace(e(), f)).toBe(f.espaceActif);
});

test("changementsPolitique: URL changed and tab closed; nothing for a title", () => {
  const { e, ag } = preparer();
  const avant = e();
  const [a, b] = Object.keys(avant.onglets);
  ag({ type: "majOnglet", id: a!, champs: { url: "https://autre.test/" } });
  ag({ type: "fermerOnglet", id: b! });
  expect(changementsPolitique(avant, e())).toEqual({ navigues: [{ id: a, url: "https://autre.test/" }], fermes: [b] });
  const milieu = e();
  ag({ type: "majOnglet", id: a!, champs: { titre: "Autre" } });
  expect(changementsPolitique(milieu, e())).toEqual({ navigues: [], fermes: [] });
});

test("attendreReponse: with no answer by the deadline, the question is withdrawn and the answer is no", async () => {
  vi.useFakeTimers();
  try {
    let retiree = false;
    const reponse = waitForResponse(() => () => (retiree = true), 120_000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(retiree).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(retiree).toBe(true);
    await expect(reponse).resolves.toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("attendreReponse: allow → yes, deny → no", async () => {
  await expect(waitForResponse((repondre) => (repondre("autoriser"), () => {}), 1000)).resolves.toBe(true);
  await expect(waitForResponse((repondre) => (repondre("refuser"), () => {}), 1000)).resolves.toBe(false);
});

test("attendreReponse: signal raised (donnees-widget card of a past conversation) → card withdrawn, answer no", async () => {
  const retrait = new AbortController();
  let retiree = false;
  let repondreTard: ((d: "autoriser" | "refuser") => void) | undefined;
  const reponse = waitForResponse((repondre) => ((repondreTard = repondre), () => (retiree = true)), 1000, retrait.signal);
  retrait.abort();
  expect(retiree).toBe(true);
  repondreTard?.("autoriser"); // a late answer grants nothing
  await expect(reponse).resolves.toBe(false);
  let posee = false;
  await expect(waitForResponse(() => ((posee = true), () => {}), 1000, retrait.signal)).resolves.toBe(false);
  expect(posee).toBe(false);
});

test("questionCaduque: an agent request only lapses with its target tab; a site permission, with its tab", () => {
  const { e, ag, F } = preparer();
  const [a, b] = Object.keys(e().onglets);
  const lecture = { id: "q", ongletId: a!, fenetreId: F, cible: b!, origine: "https://b.test", permissions: ["lire-onglet" as const] };
  const site = { id: "s", ongletId: a!, origine: "https://a.test", permissions: ["notifications" as const] };
  ag({ type: "fermerOnglet", id: a! });
  expect(staleQuestion(lecture, e())).toBe(false);
  expect(staleQuestion(site, e())).toBe(true);
  ag({ type: "fermerOnglet", id: b! });
  expect(staleQuestion(lecture, e())).toBe(true);
});

test("attendreDroits: allow → the ticked rights; deny, deadline passed or allow with nothing → []", async () => {
  await expect(waitForRights((repondre) => (repondre("autoriser", ["console", "agir"]), () => {}), 1000)).resolves.toEqual(["console", "agir"]);
  await expect(waitForRights((repondre) => (repondre("refuser", ["console"]), () => {}), 1000)).resolves.toEqual([]);
  await expect(waitForRights((repondre) => (repondre("autoriser"), () => {}), 1000)).resolves.toEqual([]);
  vi.useFakeTimers();
  try {
    let retiree = false;
    const reponse = waitForRights(() => () => (retiree = true), 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(reponse).resolves.toEqual([]);
    expect(retiree).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("attendreDroits: signal raised → card withdrawn and []; a late answer changes nothing; already raised → [] without a card", async () => {
  const controleur = new AbortController();
  let retiree = false;
  let repondreTard!: (d: "autoriser", droits: ["console"]) => void;
  const reponse = waitForRights((repondre) => ((repondreTard = repondre), () => (retiree = true)), 120_000, controleur.signal);
  controleur.abort();
  await expect(reponse).resolves.toEqual([]);
  expect(retiree).toBe(true);
  repondreTard("autoriser", ["console"]);
  await expect(reponse).resolves.toEqual([]);
  let posee = false;
  await expect(waitForRights(() => ((posee = true), () => {}), 1000, AbortSignal.abort())).resolves.toEqual([]);
  expect(posee).toBe(false);
});

test("questionCaduque: a dev-tools request lapses if the tab changes site; a site-app window is not a closed tab", () => {
  const { e, ag, F } = preparer();
  const [a, b] = Object.keys(e().onglets);
  const origine = new URL(e().onglets[b!]!.url).origin;
  const dev = { id: "d", ongletId: a!, fenetreId: F, cible: b!, origine, permissions: ["outils-dev" as const], droits: ["console" as const] };
  expect(staleQuestion(dev, e())).toBe(false);
  ag({ type: "majOnglet", id: b!, champs: { url: "https://ailleurs.test/" } });
  expect(staleQuestion(dev, e())).toBe(true);
  expect(staleQuestion({ ...dev, cible: "app:essai", origine: "http://localhost:15280" }, e())).toBe(false);
});

test("a webaios: tab is neither listed nor active for the agent", () => {
  const { e, ag, F } = preparer();
  const id = Object.values(e().onglets).find((o) => o.fenetreId === F)!.id;
  ag({ type: "majOnglet", id, champs: { url: "webaios://applications" } });
  expect(tabInfos(e()).map((o) => o.url)).toEqual(["https://b.test/"]);
  expect(activeTabOf(e(), F)).toBeNull();
});

test("siteDe: an origin's host; an unreadable origin (about:blank, data:, « null ») is returned as is, without an exception", () => {
  expect(siteDe("https://mail.google.com")).toBe("mail.google.com");
  expect(siteDe("http://localhost:5280")).toBe("localhost:5280");
  for (const o of ["null", "about:blank", "data:text/html,x", ""]) expect(siteDe(o)).toBe(o);
});

test("private space: neither listed nor active for the agent, its name neither", () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Secret", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const secret = e().espaces.find((x) => x.nom === "Secret")!.id;
  ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://banque.test/", espaceId: secret });
  expect(tabInfos(e()).map((o) => o.url)).toEqual(["https://a.test/", "https://b.test/"]);
  expect(tabInfos(e()).some((o) => o.espace === "Secret")).toBe(false);
  expect(e().fenetres.find((f) => f.id === F)!.espaceActif).toBe(secret);
  expect(activeTabOf(e(), F)).toBeNull();
  // Unknown space: private by default.
  const id = Object.values(e().onglets).find((o) => o.url === "https://a.test/")!.id;
  const inconnu = { ...e(), onglets: { ...e().onglets, [id]: { ...e().onglets[id]!, espaceId: "disparu" } } };
  expect(tabInfos(inconnu).map((o) => o.url)).toEqual(["https://b.test/"]);
});

test("resoudreEspace: a private space, by name or by id, counts as unknown", () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Secret", icone: "🔒", prive: true, profil: "defaut" });
  const f = e().fenetres.find((x) => x.id === F)!;
  const secret = e().espaces.find((x) => x.nom === "Secret")!.id;
  expect(resolveSpace(e(), f, "secret")).toBe(f.espaceActif);
  expect(resolveSpace(e(), f, secret)).toBe(f.espaceActif);
});

test("changementsPolitique: a tab whose space becomes private is closed for the agent; an essential displayed in a space that stayed non-private moves to that space", () => {
  const { e, ag, F } = preparer();
  const perso = e().espaces[0]!.id;
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  const boulot = e().espaces.find((x) => x.nom === "Boulot")!.id;
  const a = Object.values(e().onglets).find((o) => o.url === "https://a.test/")!.id;
  const b = Object.values(e().onglets).find((o) => o.url === "https://b.test/")!.id;
  // a becomes an essential, also displayed in Boulot (same key).
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "activerEspace", fenetreId: F, id: boulot });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e().essentiels[0]!.id });
  expect(e().fenetres.find((x) => x.id === F)!.actif[boulot]).toBe(a);
  const avant = e();
  reglerPrive(e(), ag, perso, true);
  // The essential stays in Boulot, non-private, which already displayed it: it was never seen under the private key.
  expect(e().fenetres.find((x) => x.id === F)!.actif[boulot]).toBe(a);
  expect(e().fenetres.find((x) => x.id === F)!.actif[perso]).toBeNull();
  expect(e().onglets[a]!.espaceId).toBe(boulot);
  expect(changementsPolitique(avant, e())).toEqual({ navigues: [], fermes: [b] });
  // Becoming non-private again gives nothing back: access has to be requested again.
  const prive = e();
  reglerPrive(e(), ag, perso, false);
  expect(changementsPolitique(prive, e())).toEqual({ navigues: [], fermes: [] });
});

test("an essential shared by two private spaces stays invisible to the agent when its owner stops being private", () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F });
  const banque = e().espaces.find((x) => x.nom === "Banque")!;
  ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://mail.google.com/" });
  const gmail = Object.values(e().onglets).find((o) => o.url === "https://mail.google.com/")!.id;
  ag({ type: "ajouterEssentiel", id: gmail });
  ag({ type: "creerEspace", nom: "Banque pro", icone: "💳", prive: true, profil: banque.profil, fenetreId: F });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e().essentiels[0]!.id });
  const avant = e();
  reglerPrive(e(), ag, banque.id, false);
  expect(tabInfos(e()).map((o) => o.url)).not.toContain("https://mail.google.com/");
  expect(activeTabOf(e(), F)).toBeNull();
  // Nothing new for the policy: the tab was never readable.
  expect(changementsPolitique(avant, e())).toEqual({ navigues: [], fermes: [] });
});

test("questionCaduque: a read request lapses if the target tab moves to a private space", () => {
  const { e, ag, F } = preparer();
  const [a, b] = Object.keys(e().onglets);
  const lecture = { id: "q", ongletId: a!, fenetreId: F, cible: b!, origine: "https://b.test", permissions: ["lire-onglet" as const] };
  expect(staleQuestion(lecture, e())).toBe(false);
  reglerPrive(e(), ag, e().espaces[0]!.id, true);
  expect(staleQuestion(lecture, e())).toBe(true);
});

test("questionCaduque: a read card lapses when its tab changes origin", () => {
  const { e, ag, F } = preparer();
  const a = Object.values(e().onglets).find((o) => o.url === "https://a.test/")!.id;
  const lecture = { id: "q", ongletId: a, fenetreId: F, cible: a, origine: "https://a.test", permissions: ["lire-onglet" as const] };
  ag({ type: "majOnglet", id: a, champs: { url: "https://a.test/autre" } });
  expect(staleQuestion(lecture, e())).toBe(false);
  ag({ type: "majOnglet", id: a, champs: { url: "https://banque.test/" } });
  expect(staleQuestion(lecture, e())).toBe(true);
});

test("espacesDevenusPrives: only the switch from non-private to private", () => {
  const { e, ag } = preparer();
  const id = e().espaces[0]!.id;
  const avant = e();
  reglerPrive(e(), ag, id, true);
  const prive = e();
  expect(spacesBecamePrivate(avant, prive)).toEqual([id]);
  expect(spacesBecamePrivate(prive, prive)).toEqual([]);
  reglerPrive(e(), ag, id, false);
  expect(spacesBecamePrivate(prive, e())).toEqual([]);
});

const carteExtension = (espaceId: string, source: "store" | "agent", renforce = false) => ({
  cle: source === "agent" ? "agent:essai" : `store:${"a".repeat(32)}`,
  nom: "Essai",
  source,
  version: "1.0.0",
  droits: [],
  sites: [],
  tousLesSites: false,
  reseau: source === "agent" ? [] : null,
  renforce,
  espace: "Perso",
  espaceId,
  autresEspaces: [],
  remplaceAussi: [],
  maj: null,
  empreinte: "0".repeat(64),
});

test("questionCaduque: an extension card lapses with its space; the agent's one too when the profile becomes private", () => {
  const { e, ag, F } = preparer();
  const espace = e().espaces[0]!.id;
  const agent = { id: "x", ongletId: null, fenetreId: F, origine: "agent:essai", permissions: ["extension" as const], extension: carteExtension(espace, "agent") };
  const store = { ...agent, id: "y", extension: carteExtension(espace, "store") };
  expect(staleQuestion(agent, e())).toBe(false);
  expect(staleQuestion(store, e())).toBe(false);
  // Another space of the same profile becomes private: the profile is, and the agent's extension has no place there any more.
  ag({ type: "creerEspace", nom: "Secret", icone: "🔒", prive: false, profil: e().espaces[0]!.profil });
  const secret = e().espaces.at(-1)!.id;
  reglerPrive(e(), ag, secret, true);
  expect(staleQuestion(agent, e())).toBe(true);
  expect(staleQuestion(store, e())).toBe(false);
  // Space deleted: every card lapses.
  expect(staleQuestion({ ...store, extension: carteExtension("inconnu", "store") }, e())).toBe(true);
});

test("decisionPermise: a « yes » to a reinforced card without the box ticked counts as a refusal", () => {
  const renforcee = { id: "x", ongletId: null, origine: "agent:essai", permissions: ["extension" as const], extension: carteExtension("e", "agent", true) };
  expect(allowedDecision(renforcee, "autoriser")).toBe("refuser");
  expect(allowedDecision(renforcee, "autoriser", false)).toBe("refuser");
  expect(allowedDecision(renforcee, "autoriser", true)).toBe("autoriser");
  expect(allowedDecision(renforcee, "refuser", true)).toBe("refuser");
  const simple = { ...renforcee, extension: carteExtension("e", "agent") };
  expect(allowedDecision(simple, "autoriser")).toBe("autoriser");
  const lecture = { id: "l", ongletId: null, origine: "https://a.test", permissions: ["lire-onglet" as const] };
  expect(allowedDecision(lecture, "autoriser")).toBe("autoriser");
});

// ——— Site-app windows (`site:<id>`) ———

test("ongletSite: site:<id>, title = app name, empty space, site, current domain and declaration hash filled in", () => {
  expect(SITE_PREFIX).toBe("site:");
  expect(siteTab({ id: "vidola", nom: "Vidola", url: "https://compte.example/connexion", domaine: "vidola-a.example", empreinte: "e1" })).toEqual({
    id: "site:vidola", titre: "Vidola", url: "https://compte.example/connexion", espace: "", site: "vidola", domaine: "vidola-a.example", empreinte: "e1",
  });
});

test("questionSiteCaduque: a question on site:<id> lapses with its window; the dev-tools one too when leaving for another origin", () => {
  const ouverte = [{ id: "vidola", nom: "Vidola", url: "https://vidola-a.example/film/1", domaine: "vidola-a.example" }];
  const dev = { id: "d", ongletId: null, cible: "site:vidola", origine: "https://vidola-a.example", permissions: ["outils-dev" as const], droits: ["console" as const] };
  expect(staleSiteQuestion(dev, ouverte)).toBe(false);
  // Window closed (surFermee): the card lapses.
  expect(staleSiteQuestion(dev, [])).toBe(true);
  expect(staleSiteQuestion(dev, [{ ...ouverte[0]!, url: "https://compte.example/connexion" }])).toBe(true);
  // Neither a question without a site: target, nor the app's card (no target).
  expect(staleSiteQuestion({ ...dev, cible: "app:essai" }, [])).toBe(false);
  expect(staleSiteQuestion({ id: "s", ongletId: null, origine: "webaios-site://vidola", permissions: ["donnees-widget" as const], site: "vidola" }, [])).toBe(false);
});

test("questionCaduque: a site-app window is not a closed tab (tracked separately)", () => {
  const { e, F } = preparer();
  const dev = { id: "d", ongletId: null, fenetreId: F, cible: "site:vidola", origine: "https://vidola-a.example", permissions: ["outils-dev" as const], droits: ["console" as const] };
  expect(staleQuestion(dev, e())).toBe(false);
});
