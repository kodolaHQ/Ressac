import { expect, test, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import { chargerSession, EnregistreurSession } from "../../src/main/etat/persistance";
import type { EtatNavigateur } from "../../src/commun/modele";

const dossier = () => mkdtempSync(join(tmpdir(), "webaios-session-"));
const mis_de_cote = (d: string, suffixe: string) => readdirSync(d).filter((f) => f.startsWith("session.json.") && f.endsWith(suffixe));
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

function etatRiche(): EtatNavigateur {
  let n = 0;
  const g = () => `g${++n}`;
  let e = etatInitial(g);
  const F = e.fenetres[0]!.id;
  e = appliquer(e, { type: "ouvrirOnglet", fenetreId: F, url: "https://a.test/" }, g);
  e = appliquer(e, { type: "ouvrirOnglet", fenetreId: F, url: "https://b.test/" }, g);
  const [a, b] = Object.keys(e.onglets);
  e = appliquer(e, { type: "majOnglet", id: a!, champs: { titre: "A", zoom: 1.2, chargement: true, peutReculer: true, plante: true } }, g);
  e = appliquer(e, { type: "epinglerOnglet", id: b! }, g);
  e = appliquer(e, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" }, g);
  return e;
}

test("aller-retour : identique, hors champs volatils remis par défaut", async () => {
  const d = dossier();
  const etat = etatRiche();
  const enr = new EnregistreurSession(d);
  enr.planifier(etat);
  await enr.vider();
  const relu = await chargerSession(d);
  const a = Object.values(relu.onglets).find((o) => o.url === "https://a.test/")!;
  expect(a).toMatchObject({ titre: "A", zoom: 1.2, chargement: false, peutReculer: false, peutAvancer: false, plante: false });
  const attendu = structuredClone(etat);
  for (const o of Object.values(attendu.onglets)) Object.assign(o, { chargement: false, peutReculer: false, peutAvancer: false, plante: false, erreur: null });
  expect(relu).toEqual(attendu);
});

/** Le même état tel qu'un navigateur d'avant les espaces configurables l'enregistrait (version 1). */
function enV1(etat: EtatNavigateur): unknown {
  const { profils: _profils, ...reste } = structuredClone(etat);
  return { ...reste, version: 1, espaces: reste.espaces.map(({ prive: _prive, profil: _profil, ...e }) => e) };
}

test("session v1 → v2 : espaces non privés sur le profil de connexion par défaut, onglets intacts", async () => {
  const d = dossier();
  const etat = etatRiche();
  writeFileSync(join(d, "session.json"), JSON.stringify(enV1(etat)));
  const e = await chargerSession(d);
  expect(e.version).toBe(2);
  expect(e.profils).toEqual([{ id: "defaut" }]);
  for (const espace of e.espaces) expect(espace).toMatchObject({ prive: false, profil: "defaut" });
  const attendu = structuredClone(etat);
  for (const o of Object.values(attendu.onglets)) Object.assign(o, { chargement: false, peutReculer: false, peutAvancer: false, plante: false, erreur: null });
  expect(e).toEqual(attendu);
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("session v2 avec un espace privé et un second profil de connexion : aller-retour identique", async () => {
  const d = dossier();
  let n = 100;
  const g = () => `h${++n}`;
  const etat = appliquer(etatRiche(), { type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau" }, g);
  expect(etat.profils).toHaveLength(2);
  const enr = new EnregistreurSession(d);
  enr.planifier(etat);
  await enr.vider();
  const relu = await chargerSession(d);
  expect(relu.version).toBe(2);
  expect(relu.profils).toEqual(etat.profils);
  expect(relu.espaces).toEqual(etat.espaces);
});

test("une session enregistrée avant le cadre des fenêtres se charge (cadre = null)", async () => {
  const d = dossier();
  const ancienne = structuredClone(etatInitial()) as unknown as { fenetres: Record<string, unknown>[] };
  for (const f of ancienne.fenetres) delete f.cadre;
  writeFileSync(join(d, "session.json"), JSON.stringify(ancienne));
  const e = await chargerSession(d);
  expect(e.fenetres[0]!.cadre).toBeNull();
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("fichier absent → état initial", async () => {
  const e = await chargerSession(dossier());
  expect(e.espaces).toHaveLength(1);
  expect(e.fenetres).toHaveLength(1);
});

test("JSON invalide → état initial et ancien fichier gardé de côté (….corrompu)", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), "{ pas du json");
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  const [garde] = mis_de_cote(d, ".corrompu");
  expect(readFileSync(join(d, garde!), "utf8")).toBe("{ pas du json");
});

test("session corrompue : le nom du fichier gardé de côté est rendu pour prévenir l'utilisateur, rien sans fichier", async () => {
  const d = dossier();
  const garde = vi.fn();
  await chargerSession(d, garde);
  expect(garde).not.toHaveBeenCalled();
  writeFileSync(join(d, "session.json"), "{ pas du json");
  await chargerSession(d, garde);
  expect(garde).toHaveBeenCalledWith(join(d, mis_de_cote(d, ".corrompu")[0]!));
});

test("version inconnue → état initial et fichier gardé de côté", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...etatRiche(), version: 3 }));
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  expect(mis_de_cote(d, ".corrompu")).toHaveLength(1);
});

test("deux sessions corrompues de suite : la seconde n'écrase pas la première", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), "premier");
  await chargerSession(d);
  writeFileSync(join(d, "session.json"), "second");
  await chargerSession(d);
  const gardes = mis_de_cote(d, ".corrompu").map((f) => readFileSync(join(d, f), "utf8"));
  expect(gardes.sort()).toEqual(["premier", "second"]);
});

test("session illisible (droits) → état initial, et le prochain enregistrement ne l'écrase pas", async () => {
  const d = dossier();
  const chemin = join(d, "session.json");
  writeFileSync(chemin, JSON.stringify(etatRiche()));
  chmodSync(chemin, 0o000);
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  const enr = new EnregistreurSession(d, 0);
  enr.planifier(e);
  await enr.vider();
  const [garde] = mis_de_cote(d, ".illisible");
  chmodSync(join(d, garde!), 0o600);
  expect(Object.keys(JSON.parse(readFileSync(join(d, garde!), "utf8")).onglets)).toHaveLength(2);
});

test("état incohérent (aucun espace) → état initial", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...etatRiche(), espaces: [] }));
  expect((await chargerSession(d)).espaces).toHaveLength(1);
});

test("planifier regroupe les écritures (3 appels rapprochés → 1 écriture)", async () => {
  const d = dossier();
  const espion = vi.spyOn(fsp, "rename");
  const enr = new EnregistreurSession(d, 50);
  const e = etatRiche();
  enr.planifier(e);
  enr.planifier(e);
  enr.planifier(e);
  await attendre(150);
  expect(espion).toHaveBeenCalledTimes(1);
  espion.mockRestore();
});

test("écriture atomique : passe par un fichier temporaire puis rename", async () => {
  const d = dossier();
  const espion = vi.spyOn(fsp, "rename");
  const enr = new EnregistreurSession(d);
  enr.planifier(etatRiche());
  await enr.vider();
  expect(espion.mock.calls[0]![0]).toMatch(/session\.json\..*tmp$/);
  expect(espion.mock.calls[0]![1]).toBe(join(d, "session.json"));
  espion.mockRestore();
});

test("vider() écrit immédiatement l'état en attente ; sans attente, ne fait rien", async () => {
  const d = dossier();
  const enr = new EnregistreurSession(d, 10_000);
  await enr.vider();
  expect(existsSync(join(d, "session.json"))).toBe(false);
  enr.planifier(etatRiche());
  await enr.vider();
  expect(existsSync(join(d, "session.json"))).toBe(true);
});

test("vider() attend l'écriture en cours : rien n'est perdu à la sortie, aucun fichier temporaire ne reste", async () => {
  const d = dossier();
  const enr = new EnregistreurSession(d, 10_000);
  const a = etatRiche();
  const b = appliquer(a, { type: "choisirMoteur", moteur: "qwant" });
  enr.planifier(a);
  const premiere = enr.vider(); // écriture en cours…
  const sortie = enr.vider(); // …la sortie n'a plus rien en attente, mais doit attendre
  await sortie;
  expect(existsSync(join(d, "session.json"))).toBe(true);
  enr.planifier(b);
  await Promise.all([enr.vider(), enr.vider(), premiere]);
  expect(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).reglages.moteur).toBe("qwant");
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("une écriture ratée ne laisse pas de fichier temporaire et l'état est réécrit au vider() suivant", async () => {
  const d = dossier();
  const espion = vi.spyOn(fsp, "rename").mockRejectedValueOnce(new Error("disque plein"));
  const enr = new EnregistreurSession(d, 10_000);
  enr.planifier(etatRiche());
  await enr.vider();
  expect(readdirSync(d)).toEqual([]);
  await enr.vider();
  expect(Object.keys(JSON.parse(readFileSync(join(d, "session.json"), "utf8")).onglets)).toHaveLength(2);
  espion.mockRestore();
});

test("l'erreur de chargement d'un onglet n'est pas enregistrée", async () => {
  const d = dossier();
  let e = etatRiche();
  const id = Object.keys(e.onglets)[0]!;
  e = appliquer(e, { type: "majOnglet", id, champs: { erreur: "ERR_NAME_NOT_RESOLVED" } });
  const enr = new EnregistreurSession(d);
  enr.planifier(e);
  await enr.vider();
  expect((await chargerSession(d)).onglets[id]?.erreur).toBeNull();
});

test("une session enregistrée sans profilAgent se charge avec claude", async () => {
  const d = dossier();
  const ancienne = structuredClone(etatInitial()) as unknown as { reglages: Record<string, unknown> };
  delete ancienne.reglages.profilAgent;
  writeFileSync(join(d, "session.json"), JSON.stringify(ancienne));
  const e = await chargerSession(d);
  expect(e.reglages.profilAgent).toBe("claude");
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("une session enregistrée sans largeur de panneau agent se charge avec 420", async () => {
  const d = dossier();
  const ancienne = structuredClone(etatInitial()) as unknown as { reglages: Record<string, unknown> };
  delete ancienne.reglages.largeurPanneauAgent;
  writeFileSync(join(d, "session.json"), JSON.stringify(ancienne));
  const e = await chargerSession(d);
  expect(e.reglages.largeurPanneauAgent).toBe(420);
  expect(mis_de_cote(d, ".corrompu")).toEqual([]);
});

test("session v2 dont un espace utilise un profil de connexion non listé : le profil est ajouté à la liste", async () => {
  const d = dossier();
  const etat = etatRiche();
  etat.espaces[1]!.profil = "orphelin";
  writeFileSync(join(d, "session.json"), JSON.stringify(etat));
  const relu = await chargerSession(d);
  expect(relu.profils).toEqual([{ id: "defaut" }, { id: "orphelin" }]);
  expect(relu.espaces[1]!.profil).toBe("orphelin");
});
