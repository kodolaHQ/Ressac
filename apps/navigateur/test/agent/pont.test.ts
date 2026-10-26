import { expect, test, vi } from "vitest";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import type { Action } from "../../src/commun/api";
import type { EtatNavigateur } from "../../src/commun/modele";
import { attendreReponse, changementsPolitique, infosOnglets, ongletActifDe, resoudreEspace } from "../../src/main/agent/pont";

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
