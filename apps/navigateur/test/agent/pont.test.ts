import { expect, test, vi } from "vitest";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import type { Action } from "../../src/commun/api";
import type { EtatNavigateur } from "../../src/commun/modele";
import { attendreDroits, attendreReponse, changementsPolitique, infosOnglets, ongletActifDe, PontElectron, questionCaduque, resoudreEspace } from "../../src/main/agent/pont";

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
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼" });
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
