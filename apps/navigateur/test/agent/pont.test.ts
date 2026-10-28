import { expect, test, vi } from "vitest";
import { OngletPrive } from "@webaios/noyau";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import type { Action } from "../../src/commun/api";
import { siteDe, type EtatNavigateur } from "../../src/commun/modele";
import { attendreDroits, attendreReponse, changementsPolitique, espacesDevenusPrives, infosOnglets, ongletActifDe, PontElectron, questionCaduque, resoudreEspace } from "../../src/main/agent/pont";

/** Règle le caractère privé d'un espace, sans toucher au reste. */
function reglerPrive(e: EtatNavigateur, ag: (a: Action) => unknown, id: string, prive: boolean) {
  const esp = e.espaces.find((x) => x.id === id)!;
  ag({ type: "reglerEspace", id, nom: esp.nom, icone: esp.icone, prive, profil: esp.profil });
}

function preparer() {
  let n = 0;
  const g = () => `g${++n}`;
  let e: EtatNavigateur = etatInitial(g);
  const ag = (a: Action) => (e = appliquer(e, a, g));
  const F = e.fenetres[0]!.id;
  ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://a.test/" });
  ag({ type: "ouvrirFenetre", id: "F2" });
  ag({ type: "ouvrirOnglet", fenetreId: "F2", url: "https://b.test/" });
  return { e: () => e, ag, F };
}

test("infosOnglets : tous les onglets de toutes les fenêtres, espace = nom", () => {
  const { e } = preparer();
  expect(infosOnglets(e()).map((o) => ({ url: o.url, espace: o.espace }))).toEqual([
    { url: "https://a.test/", espace: "Perso" },
    { url: "https://b.test/", espace: "Perso" },
  ]);
  expect(infosOnglets(e())[0]).toEqual({ id: expect.any(String), titre: "https://a.test/", url: "https://a.test/", espace: "Perso" });
});

test("ongletActifDe : null sur une page vide, l'onglet actif de l'espace actif sinon", () => {
  const { e, ag, F } = preparer();
  expect(ongletActifDe(e(), F)?.url).toBe("https://a.test/");
  expect(ongletActifDe(e(), undefined)).toBeNull();
  ag({ type: "afficherPageVide", fenetreId: F });
  expect(ongletActifDe(e(), F)).toBeNull();
});

test("resoudreEspace : par id, par nom sans casse, sinon l'espace actif", () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  const f = e().fenetres.find((x) => x.id === F)!;
  const boulot = e().espaces.find((x) => x.nom === "Boulot")!.id;
  expect(resoudreEspace(e(), f, "boulot")).toBe(boulot);
  expect(resoudreEspace(e(), f, boulot)).toBe(boulot);
  expect(resoudreEspace(e(), f, "inconnu")).toBe(f.espaceActif);
  expect(resoudreEspace(e(), f)).toBe(f.espaceActif);
});

test("changementsPolitique : URL changée et onglet fermé ; rien pour un titre", () => {
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

test("attendreReponse : sans réponse au bout du délai, la question est retirée et la réponse est non", async () => {
  vi.useFakeTimers();
  try {
    let retiree = false;
    const reponse = attendreReponse(() => () => (retiree = true), 120_000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(retiree).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(retiree).toBe(true);
    await expect(reponse).resolves.toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("attendreReponse : autoriser → oui, refuser → non", async () => {
  await expect(attendreReponse((repondre) => (repondre("autoriser"), () => {}), 1000)).resolves.toBe(true);
  await expect(attendreReponse((repondre) => (repondre("refuser"), () => {}), 1000)).resolves.toBe(false);
});

test("attendreReponse : signal levé (carte donnees-widget d'une conversation passée) → carte retirée, réponse non", async () => {
  const retrait = new AbortController();
  let retiree = false;
  let repondreTard: ((d: "autoriser" | "refuser") => void) | undefined;
  const reponse = attendreReponse((repondre) => ((repondreTard = repondre), () => (retiree = true)), 1000, retrait.signal);
  retrait.abort();
  expect(retiree).toBe(true);
  repondreTard?.("autoriser"); // une réponse tardive n'accorde rien
  await expect(reponse).resolves.toBe(false);
  let posee = false;
  await expect(attendreReponse(() => ((posee = true), () => {}), 1000, retrait.signal)).resolves.toBe(false);
  expect(posee).toBe(false);
});

test("questionCaduque : une demande de l'agent ne tombe qu'avec son onglet visé ; une permission de site, avec son onglet", () => {
  const { e, ag, F } = preparer();
  const [a, b] = Object.keys(e().onglets);
  const lecture = { id: "q", ongletId: a!, fenetreId: F, cible: b!, origine: "https://b.test", permissions: ["lire-onglet" as const] };
  const site = { id: "s", ongletId: a!, origine: "https://a.test", permissions: ["notifications" as const] };
  ag({ type: "fermerOnglet", id: a! });
  expect(questionCaduque(lecture, e())).toBe(false);
  expect(questionCaduque(site, e())).toBe(true);
  ag({ type: "fermerOnglet", id: b! });
  expect(questionCaduque(lecture, e())).toBe(true);
});

test("attendreDroits : autoriser → les droits cochés ; refuser, délai dépassé ou autoriser sans rien → []", async () => {
  await expect(attendreDroits((repondre) => (repondre("autoriser", ["console", "agir"]), () => {}), 1000)).resolves.toEqual(["console", "agir"]);
  await expect(attendreDroits((repondre) => (repondre("refuser", ["console"]), () => {}), 1000)).resolves.toEqual([]);
  await expect(attendreDroits((repondre) => (repondre("autoriser"), () => {}), 1000)).resolves.toEqual([]);
  vi.useFakeTimers();
  try {
    let retiree = false;
    const reponse = attendreDroits(() => () => (retiree = true), 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(reponse).resolves.toEqual([]);
    expect(retiree).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("attendreDroits : signal levé → carte retirée et [] ; une réponse tardive ne change rien ; déjà levé → [] sans carte", async () => {
  const controleur = new AbortController();
  let retiree = false;
  let repondreTard!: (d: "autoriser", droits: ["console"]) => void;
  const reponse = attendreDroits((repondre) => ((repondreTard = repondre), () => (retiree = true)), 120_000, controleur.signal);
  controleur.abort();
  await expect(reponse).resolves.toEqual([]);
  expect(retiree).toBe(true);
  repondreTard("autoriser", ["console"]);
  await expect(reponse).resolves.toEqual([]);
  let posee = false;
  await expect(attendreDroits(() => ((posee = true), () => {}), 1000, AbortSignal.abort())).resolves.toEqual([]);
  expect(posee).toBe(false);
});

test("questionCaduque : une demande d'outils de développement tombe si l'onglet change de site ; une fenêtre d'appli n'est pas un onglet fermé", () => {
  const { e, ag, F } = preparer();
  const [a, b] = Object.keys(e().onglets);
  const origine = new URL(e().onglets[b!]!.url).origin;
  const dev = { id: "d", ongletId: a!, fenetreId: F, cible: b!, origine, permissions: ["outils-dev" as const], droits: ["console" as const] };
  expect(questionCaduque(dev, e())).toBe(false);
  ag({ type: "majOnglet", id: b!, champs: { url: "https://ailleurs.test/" } });
  expect(questionCaduque(dev, e())).toBe(true);
  expect(questionCaduque({ ...dev, cible: "app:essai", origine: "http://localhost:15280" }, e())).toBe(false);
});

test("listerOnglets inclut les fenêtres d'application", async () => {
  const { e } = preparer();
  const wc = {} as never;
  const vues = { naviguer: vi.fn(), lireTexte: vi.fn(), capturer: vi.fn(), lireTexteDe: vi.fn(async () => ({ texte: "Essai essai" })), capturerDe: vi.fn(async () => Buffer.from("png")) };
  const pont = new PontElectron({
    magasin: { etat: e() } as never,
    vues: vues as never,
    fenetreActive: () => undefined,
    demander: async () => true,
    applications: {
      ouvertes: () => [{ dossier: "essai", titre: "Essai", url: "http://localhost:15280/" }],
      webContents: (d) => (d === "essai" ? wc : undefined),
    },
  });
  expect(await pont.listerOnglets()).toContainEqual({ id: "app:essai", titre: "Essai", url: "http://localhost:15280/", espace: "", application: "essai" });
  expect((await pont.lireTexte("app:essai")).texte).toBe("Essai essai");
  expect(vues.lireTexteDe).toHaveBeenCalledWith(wc);
  expect((await pont.capturer("app:essai")).toString()).toBe("png");
  await expect(pont.lireTexte("app:absente")).rejects.toThrow();
  await expect(pont.naviguer("app:absente", "http://x.test/")).rejects.toThrow();
});

test("naviguer une fenêtre d'appli : sur son origine seulement, le reste s'ouvre dans un onglet", async () => {
  const { e, ag, F } = preparer();
  const wc = { loadURL: vi.fn(async () => {}) };
  const pont = new PontElectron({
    magasin: { get etat() { return e(); }, agir: ag } as never,
    vues: {} as never,
    fenetreActive: () => F,
    demander: async () => true,
    applications: {
      ouvertes: () => [{ dossier: "essai", titre: "Essai", url: "http://localhost:15280/" }],
      webContents: (d) => (d === "essai" ? (wc as never) : undefined),
    },
  });
  await pont.naviguer("app:essai", "http://localhost:15280/autre");
  expect(wc.loadURL).toHaveBeenCalledWith("http://localhost:15280/autre");
  for (const url of ["https://exemple.test/", "http://localhost:15281/"]) await pont.naviguer("app:essai", url);
  expect(wc.loadURL).toHaveBeenCalledTimes(1);
  expect(Object.values(e().onglets).filter((o) => o.ouvertParAgent).map((o) => o.url)).toEqual(["https://exemple.test/", "http://localhost:15281/"]);
});

test("un onglet webaios: n'est ni listé ni actif pour l'agent", () => {
  const { e, ag, F } = preparer();
  const id = Object.values(e().onglets).find((o) => o.fenetreId === F)!.id;
  ag({ type: "majOnglet", id, champs: { url: "webaios://applications" } });
  expect(infosOnglets(e()).map((o) => o.url)).toEqual(["https://b.test/"]);
  expect(ongletActifDe(e(), F)).toBeNull();
});

test("siteDe : l'hôte d'une origine ; une origine illisible (about:blank, data:, « null ») est rendue telle quelle, sans exception", () => {
  expect(siteDe("https://mail.google.com")).toBe("mail.google.com");
  expect(siteDe("http://localhost:5280")).toBe("localhost:5280");
  for (const o of ["null", "about:blank", "data:text/html,x", ""]) expect(siteDe(o)).toBe(o);
});

test("espace privé : ni listé ni actif pour l'agent, son nom non plus", () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Secret", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const secret = e().espaces.find((x) => x.nom === "Secret")!.id;
  ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://banque.test/", espaceId: secret });
  expect(infosOnglets(e()).map((o) => o.url)).toEqual(["https://a.test/", "https://b.test/"]);
  expect(infosOnglets(e()).some((o) => o.espace === "Secret")).toBe(false);
  expect(e().fenetres.find((f) => f.id === F)!.espaceActif).toBe(secret);
  expect(ongletActifDe(e(), F)).toBeNull();
  // Espace inconnu : privé par défaut.
  const id = Object.values(e().onglets).find((o) => o.url === "https://a.test/")!.id;
  const inconnu = { ...e(), onglets: { ...e().onglets, [id]: { ...e().onglets[id]!, espaceId: "disparu" } } };
  expect(infosOnglets(inconnu).map((o) => o.url)).toEqual(["https://b.test/"]);
});

test("resoudreEspace : un espace privé, par nom ou par id, compte comme inconnu", () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Secret", icone: "🔒", prive: true, profil: "defaut" });
  const f = e().fenetres.find((x) => x.id === F)!;
  const secret = e().espaces.find((x) => x.nom === "Secret")!.id;
  expect(resoudreEspace(e(), f, "secret")).toBe(f.espaceActif);
  expect(resoudreEspace(e(), f, secret)).toBe(f.espaceActif);
});

test("changementsPolitique : un onglet dont l'espace devient privé est fermé pour l'agent ; un essentiel affiché dans un espace resté non privé passe à cet espace", () => {
  const { e, ag, F } = preparer();
  const perso = e().espaces[0]!.id;
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  const boulot = e().espaces.find((x) => x.nom === "Boulot")!.id;
  const a = Object.values(e().onglets).find((o) => o.url === "https://a.test/")!.id;
  const b = Object.values(e().onglets).find((o) => o.url === "https://b.test/")!.id;
  // a devient un essentiel, affiché aussi dans Boulot (même clé).
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "activerEspace", fenetreId: F, id: boulot });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e().essentiels[0]!.id });
  expect(e().fenetres.find((x) => x.id === F)!.actif[boulot]).toBe(a);
  const avant = e();
  reglerPrive(e(), ag, perso, true);
  // L'essentiel reste à Boulot, non privé, qui l'affichait déjà : il n'a jamais été vu sous la clé privée.
  expect(e().fenetres.find((x) => x.id === F)!.actif[boulot]).toBe(a);
  expect(e().fenetres.find((x) => x.id === F)!.actif[perso]).toBeNull();
  expect(e().onglets[a]!.espaceId).toBe(boulot);
  expect(changementsPolitique(avant, e())).toEqual({ navigues: [], fermes: [b] });
  // Redevenir non privé ne rend rien : l'accès est à redemander.
  const prive = e();
  reglerPrive(e(), ag, perso, false);
  expect(changementsPolitique(prive, e())).toEqual({ navigues: [], fermes: [] });
});

test("un essentiel partagé par deux espaces privés reste invisible à l'agent quand son propriétaire cesse d'être privé", () => {
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
  expect(infosOnglets(e()).map((o) => o.url)).not.toContain("https://mail.google.com/");
  expect(ongletActifDe(e(), F)).toBeNull();
  // Rien de nouveau pour la politique : l'onglet n'a jamais été lisible.
  expect(changementsPolitique(avant, e())).toEqual({ navigues: [], fermes: [] });
});

test("questionCaduque : une demande de lecture tombe si l'onglet visé passe dans un espace privé", () => {
  const { e, ag, F } = preparer();
  const [a, b] = Object.keys(e().onglets);
  const lecture = { id: "q", ongletId: a!, fenetreId: F, cible: b!, origine: "https://b.test", permissions: ["lire-onglet" as const] };
  expect(questionCaduque(lecture, e())).toBe(false);
  reglerPrive(e(), ag, e().espaces[0]!.id, true);
  expect(questionCaduque(lecture, e())).toBe(true);
});

function pontSur(e: () => EtatNavigateur, ag: (a: Action) => unknown, F: string, vues: Record<string, unknown> = {}) {
  return new PontElectron({
    magasin: { get etat() { return e(); }, agir: ag } as never,
    vues: vues as never,
    fenetreActive: () => F,
    demander: async () => true,
    applications: { ouvertes: () => [], webContents: () => undefined },
  });
}

test("PontElectron : l'espace actif privé n'accepte pas d'onglet de l'agent ; un nom d'espace privé vise l'espace actif", async () => {
  const { e, ag, F } = preparer();
  ag({ type: "creerEspace", nom: "Secret", icone: "🔒", prive: true, profil: "defaut" });
  const pont = pontSur(e, ag, F);
  const o = await pont.ouvrirOnglet("https://demo.test/", "Secret");
  expect(e().onglets[o.id]!.espaceId).toBe(e().espaces[0]!.id);
  reglerPrive(e(), ag, e().espaces[0]!.id, true);
  const avant = Object.keys(e().onglets).length;
  await expect(pont.ouvrirOnglet("https://demo.test/")).rejects.toThrow("Impossible d'ouvrir un onglet ici : l'espace actif est privé.");
  expect(Object.keys(e().onglets)).toHaveLength(avant);
});

test("PontElectron : un onglet privé n'est ni lu, ni capturé, ni navigué, ni inspecté", async () => {
  const { e, ag, F } = preparer();
  const vues = { naviguer: vi.fn(), lireTexte: vi.fn(async () => ({ texte: "secret" })), capturer: vi.fn(async () => Buffer.from("png")), vue: vi.fn(() => ({}) as never) };
  const pont = pontSur(e, ag, F, vues);
  const a = Object.values(e().onglets).find((o) => o.url === "https://a.test/")!.id;
  expect(pont.estPrive(a)).toBe(false);
  expect(pont.ongletActifPrive()).toBe(false);
  reglerPrive(e(), ag, e().espaces[0]!.id, true);
  expect(pont.estPrive(a)).toBe(true);
  expect(pont.estPrive("inconnu")).toBe(false);
  expect(pont.ongletActifPrive()).toBe(true);
  expect(await pont.ongletActif()).toBeNull();
  expect(await pont.listerOnglets()).toEqual([]);
  await expect(pont.lireTexte(a)).rejects.toBeInstanceOf(OngletPrive);
  await expect(pont.capturer(a)).rejects.toBeInstanceOf(OngletPrive);
  await expect(pont.naviguer(a, "https://x.test/")).rejects.toBeInstanceOf(OngletPrive);
  await expect(pont.outilsDev.attacher(a)).rejects.toThrow();
  expect(vues.lireTexte).not.toHaveBeenCalled();
  expect(vues.capturer).not.toHaveBeenCalled();
  expect(vues.naviguer).not.toHaveBeenCalled();
  expect(vues.vue).not.toHaveBeenCalled();
});

test("PontElectron : un onglet devenu privé pendant sa lecture ou sa capture ne rend rien", async () => {
  const { e, ag, F } = preparer();
  const perso = e().espaces[0]!.id;
  const vues = {
    lireTexte: vi.fn(async () => (reglerPrive(e(), ag, perso, true), { texte: "secret" })),
    capturer: vi.fn(async () => (reglerPrive(e(), ag, perso, true), Buffer.from("png"))),
  };
  const pont = pontSur(e, ag, F, vues);
  const a = Object.values(e().onglets).find((o) => o.url === "https://a.test/")!.id;
  await expect(pont.lireTexte(a)).rejects.toBeInstanceOf(OngletPrive);
  reglerPrive(e(), ag, perso, false);
  await expect(pont.capturer(a)).rejects.toBeInstanceOf(OngletPrive);
});

test("espacesDevenusPrives : seulement le passage de non privé à privé", () => {
  const { e, ag } = preparer();
  const id = e().espaces[0]!.id;
  const avant = e();
  reglerPrive(e(), ag, id, true);
  const prive = e();
  expect(espacesDevenusPrives(avant, prive)).toEqual([id]);
  expect(espacesDevenusPrives(prive, prive)).toEqual([]);
  reglerPrive(e(), ag, id, false);
  expect(espacesDevenusPrives(prive, e())).toEqual([]);
});

test("PontElectron : historique absent sans base ; sinon il délègue, les dates ISO en Date", async () => {
  const { e, ag, F } = preparer();
  expect(pontSur(e, ag, F).historique).toBeUndefined();
  const resultat = { url: "https://svelte.dev/", titre: "Svelte", derniereVisite: "2026-10-21T09:00:00.000Z", visites: 2, extrait: "runes" };
  const page = { url: "https://svelte.dev/", titre: "Svelte", date: "2026-10-21T09:00:00.000Z", texte: "Les runes." };
  const base = { rechercherPourAgent: vi.fn(() => [resultat]), texteRetenu: vi.fn(() => page) };
  const pont = new PontElectron({
    magasin: { etat: e() } as never,
    vues: {} as never,
    fenetreActive: () => F,
    demander: async () => true,
    applications: { ouvertes: () => [], webContents: () => undefined },
    historique: base,
  });
  expect(await pont.historique!.chercher({ requete: "runes", depuis: "2026-10-14T00:00:00.000Z", jusqua: "2026-10-21T23:59:59.999Z", limite: 5 })).toEqual([resultat]);
  expect(base.rechercherPourAgent).toHaveBeenCalledWith({
    requete: "runes",
    depuis: new Date("2026-10-14T00:00:00.000Z"),
    jusqua: new Date("2026-10-21T23:59:59.999Z"),
    limite: 5,
  });
  await pont.historique!.chercher({ requete: "runes", limite: 20 });
  expect(base.rechercherPourAgent).toHaveBeenLastCalledWith({ requete: "runes", limite: 20 });
  expect(await pont.historique!.lire("https://svelte.dev/")).toEqual(page);
  expect(base.texteRetenu).toHaveBeenCalledWith("https://svelte.dev/");
});
