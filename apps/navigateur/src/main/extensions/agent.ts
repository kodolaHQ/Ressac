import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  activer,
  cleExtension,
  ERREUR_PROFIL_PRIVE,
  porteeElargie,
  preparerCopie,
  type AnalyseManifeste,
  type EntreeExtension,
  type EtatExtensions,
  type IdProfil,
} from "@webaios/noyau";
import { carteDe, DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE, type CarteExtension, type ReponseAccord } from "../../commun/extensions";
import type { Espace, EtatNavigateur, IdFenetre } from "../../commun/modele";
import { accordPour } from "./store";

export const DOSSIER_ABSENT = "Dossier absent";
export const ACTIVATION_REFUSEE = "Activation refusée";
export const TOUTES_COUPEES_AGENT = "Les extensions sont toutes désactivées : rien n'est activé";
export const SANS_ACCORD = "Extension sans accord : demande d'abord son activation";

/**
 * L'empreinte (`preparerCopie`) du dossier de l'agent dont la copie est faite, écrite dans la copie : au démarrage, une
 * copie refaite d'un dossier inchangé ne compte pas comme une modification (ni `modifieeLe`, ni `onInstalled`).
 */
const FICHIER_EMPREINTE = "webaios-source.sha256";

/** Ce dont les extensions de l'agent ont besoin du service des extensions. */
export interface DependancesAgent {
  /** `<userData>/extensions` (copies dans `copies/`). */
  dossier: string;
  /** `~/WebAiOs/extensions` : ce que l'agent écrit (jamais un droit). */
  dossierAgent: string;
  /** Gardes et correctifs livrés (`packages/noyau/extensions`). */
  dossierGardes: string;
  etatNavigateur(): EtatNavigateur;
  etatExtensions(): EtatExtensions;
  /** Modifie le registre ; les sessions sont synchronisées avant qu'il ne rende (après le démarrage). */
  modifier(changer: (e: EtatExtensions, profilsPrives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<EtatExtensions>;
  demanderAccord(c: CarteExtension, o: { fenetre?: IdFenetre; delaiMs?: number; signal?: AbortSignal }): Promise<ReponseAccord>;
  /**
   * Erreur d'une clé (null : effacée), en mémoire. `bloquee` : l'extension n'est plus chargée tant que l'erreur reste
   * (dossier absent). Rend quand les sessions ont suivi.
   */
  noterErreur(cle: string, erreur: string | null, bloquee?: boolean): Promise<void>;
}

export type PreparationAgent =
  | { ok: true; analyse: AnalyseManifeste; empreinte: string; staging: string }
  | { ok: false; refus: string[] };

export type ResultatActivation = { ok: true } | { ok: false; erreur: string };
export interface ResultatRechargement {
  etat: "rechargee" | "desactivee" | "refusee";
  detail: string[];
}

/** Une opération à la fois par extension de l'agent (la copie d'attente est la sienne). */
const files = new Map<string, Promise<unknown>>();
function enFile<T>(cle: string, f: () => Promise<T>): Promise<T> {
  const suivante = (files.get(cle) ?? Promise.resolve()).catch(() => {}).then(f);
  files.set(cle, suivante);
  void suivante
    .finally(() => {
      if (files.get(cle) === suivante) files.delete(cle);
    })
    .catch(() => {});
  return suivante;
}

const cleAgent = (id: string): string | null => {
  try {
    return cleExtension("agent", id);
  } catch {
    return null;
  }
};

interface Repere {
  chemin: string;
  dev: number;
  ino: number;
}

/**
 * Le chemin de `~/WebAiOs/extensions` jusqu'à `<id>` : chaque élément est un vrai dossier (lstat), jamais un lien
 * symbolique. `preparerCopie` ne vérifie pas les parents de sa source : c'est fait ici, avant et après la copie.
 */
async function reperesDuChemin(dossierAgent: string, id: string): Promise<Repere[] | string> {
  const reperes: Repere[] = [];
  for (const chemin of [dossierAgent, join(dossierAgent, id)]) {
    let info;
    try {
      info = await lstat(chemin);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return DOSSIER_ABSENT;
      return `Dossier illisible : ${(e as Error).message}`;
    }
    if (info.isSymbolicLink()) return `Lien symbolique refusé : ${chemin}`;
    if (!info.isDirectory()) return chemin === dossierAgent ? DOSSIER_ABSENT : `Pas un dossier : ${chemin}`;
    reperes.push({ chemin, dev: info.dev, ino: info.ino });
  }
  return reperes;
}

const memesReperes = (a: Repere[], b: Repere[]) =>
  a.length === b.length && a.every((x, i) => x.chemin === b[i]!.chemin && x.dev === b[i]!.dev && x.ino === b[i]!.ino);

const attente = (dossier: string, id: string) => join(dossier, "copies", `${id}.attente`);
const copie = (dossier: string, id: string) => join(dossier, "copies", id);

/**
 * Prépare la copie contrôlée de `~/WebAiOs/extensions/<id>` dans `<dossier>/copies/<id>.attente` (jamais à la place de la
 * copie chargée) : chemin sans lien symbolique (vérifié avant et après), copie faite par `preparerCopie`, qui refuse
 * liens, liens physiques et fichiers interdits. Un refus ne laisse aucune copie d'attente.
 */
export async function preparerAgent(id: string, d: DependancesAgent): Promise<PreparationAgent> {
  if (!cleAgent(id)) return { ok: false, refus: [`Identifiant d'extension invalide : ${id}`] };
  const staging = attente(d.dossier, id);
  await rm(staging, { recursive: true, force: true });
  const avant = await reperesDuChemin(d.dossierAgent, id);
  if (typeof avant === "string") return { ok: false, refus: [avant] };
  let reelAvant: string;
  try {
    reelAvant = await realpath(d.dossierAgent);
  } catch (e) {
    return { ok: false, refus: [`Dossier illisible : ${(e as Error).message}`] };
  }
  let r: { analyse: AnalyseManifeste; empreinte: string; racine?: { chemin: string; dev: number; ino: number } };
  try {
    await mkdir(join(d.dossier, "copies"), { recursive: true });
    r = await preparerCopie({ source: join(d.dossierAgent, id), cible: staging, dossierGardes: d.dossierGardes });
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, refus: [`Copie impossible : ${(e as Error).message}`] };
  }
  // Le chemin n'a pas changé pendant la copie (un lien posé à la place d'un dossier, puis retiré).
  const apres = await reperesDuChemin(d.dossierAgent, id);
  const reelApres = await realpath(d.dossierAgent).catch(() => "");
  if (typeof apres === "string" || !memesReperes(avant, apres) || reelApres !== reelAvant) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, refus: [typeof apres === "string" ? apres : "Dossier remplacé pendant la copie"] };
  }
  // Le dossier réellement lu est celui qu'on a contrôlé avant (une seule bascule d'`extensions` en lien, puis remis).
  const lu = avant[1]!;
  if (r.racine && (r.racine.chemin !== join(reelAvant, id) || r.racine.dev !== lu.dev || r.racine.ino !== lu.ino)) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, refus: ["Dossier remplacé pendant la copie"] };
  }
  if (r.analyse.refus.length > 0) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, refus: r.analyse.refus };
  }
  try {
    await writeFile(join(staging, FICHIER_EMPREINTE), r.empreinte);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, refus: [`Copie impossible : ${(e as Error).message}`] };
  }
  return { ok: true, analyse: r.analyse, empreinte: r.empreinte, staging };
}

/**
 * La copie d'attente prend la place de `copies/<id>` (deux renommages) ; l'ancienne est gardée jusqu'à `valider`, et
 * `annuler` la remet (le registre n'a pas pu être écrit : jamais une copie chargée sans l'accord qui va avec).
 */
async function poserCopie(staging: string, cible: string): Promise<{ valider(): Promise<void>; annuler(): Promise<void> }> {
  const ancienne = `${cible}.${randomUUID()}.ancienne`;
  let deplacee = false;
  try {
    await rename(cible, ancienne);
    deplacee = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await rename(staging, cible);
  } catch (e) {
    if (deplacee) await rename(ancienne, cible).catch(() => undefined);
    throw e;
  }
  return {
    valider: () => (deplacee ? rm(ancienne, { recursive: true, force: true }) : Promise.resolve()),
    annuler: async () => {
      await rm(cible, { recursive: true, force: true });
      if (deplacee) await rename(ancienne, cible).catch(() => undefined);
    },
  };
}

/** Profils qu'utilise au moins un espace privé. */
const profilsPrivesDe = (nav: EtatNavigateur) => new Set(nav.espaces.filter((e) => e.prive).map((e) => e.profil));

/**
 * L'agent demande d'activer `~/WebAiOs/extensions/<id>` dans un espace. Profil privé : `ERREUR_PROFIL_PRIVE`, sans carte.
 * Sinon la copie est préparée, et la carte décrit **cette copie** ; acceptée (pour exactement la portée montrée, et
 * l'espace toujours là, son profil toujours non privé), la copie devient `copies/<id>`, l'accord est la portée montrée,
 * l'extension est active dans le profil et chargée. Refusée : la copie d'attente est effacée.
 */
export function demanderActivation(
  id: string,
  o: { espace: Espace; fenetre?: IdFenetre; delaiMs?: number; signal?: AbortSignal },
  d: DependancesAgent,
): Promise<ResultatActivation> {
  const cle = cleAgent(id);
  if (!cle) return Promise.resolve({ ok: false, erreur: `Identifiant d'extension invalide : ${id}` });
  return enFile(`${d.dossier}|${cle}`, () => activation(id, cle, o, d));
}

async function activation(
  id: string,
  cle: string,
  o: { espace: Espace; fenetre?: IdFenetre; delaiMs?: number; signal?: AbortSignal },
  d: DependancesAgent,
): Promise<ResultatActivation> {
  const profil = o.espace.profil;
  if (profilsPrivesDe(d.etatNavigateur()).has(profil)) return { ok: false, erreur: ERREUR_PROFIL_PRIVE };
  if (d.etatExtensions().toutesCoupees) return { ok: false, erreur: TOUTES_COUPEES_AGENT };
  const connue = d.etatExtensions().extensions[cle];
  // Plantages : c'est l'utilisateur qui la réactive, depuis la page des extensions.
  if (connue?.desactivee?.raison === "plantages") return { ok: false, erreur: DESACTIVEE_PLANTAGES };
  if (connue?.accord && !connue.desactivee && connue.profils.includes(profil)) return { ok: true };

  const p = await preparerAgent(id, d);
  if (!p.ok) return { ok: false, erreur: p.refus.join(" ; ") };
  const effacer = () => rm(p.staging, { recursive: true, force: true });
  const carte = carteDe(p.analyse, { cle, source: "agent", espace: o.espace, etat: d.etatNavigateur() });
  const r = await d.demanderAccord(carte, {
    ...(o.fenetre ? { fenetre: o.fenetre } : {}),
    ...(o.delaiMs !== undefined ? { delaiMs: o.delaiMs } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!accordPour(r, p.analyse.portee)) {
    await effacer();
    return { ok: false, erreur: ACTIVATION_REFUSEE };
  }
  // L'état a pu changer pendant la carte : il est revu au « oui ».
  const nav = d.etatNavigateur();
  const espace = nav.espaces.find((e) => e.id === o.espace.id);
  const refus = !espace
    ? "Espace disparu pendant la carte : rien n'est activé"
    : espace.profil !== profil || profilsPrivesDe(nav).has(profil)
      ? ERREUR_PROFIL_PRIVE
      : d.etatExtensions().toutesCoupees
        ? TOUTES_COUPEES_AGENT
        : connue && !(cle in d.etatExtensions().extensions)
          ? "Extension retirée pendant la carte : rien n'est activé"
          : null;
  if (refus) {
    await effacer();
    return { ok: false, erreur: refus };
  }

  let pose: Awaited<ReturnType<typeof poserCopie>>;
  try {
    pose = await poserCopie(p.staging, copie(d.dossier, id));
  } catch (e) {
    await effacer();
    return { ok: false, erreur: `Copie non posée : ${(e as Error).message}` };
  }
  const { analyse } = p;
  try {
    await d.modifier((e, prives) => {
      if (e.toutesCoupees) throw new Error(TOUTES_COUPEES_AGENT);
      const x = e.extensions[cle];
      if (connue && !x) throw new Error("Extension retirée pendant la carte : rien n'est activé");
      const base: EntreeExtension = x ?? {
        source: "agent",
        idChrome: null,
        nom: analyse.nom,
        version: analyse.version,
        accord: null,
        profils: [],
        epinglee: false,
        modifieeLe: null,
        desactivee: null,
        majEnAttente: null,
        vues: {},
      };
      const entree: EntreeExtension = {
        ...base,
        nom: analyse.nom,
        version: analyse.version,
        accord: analyse.portee,
        modifieeLe: new Date().toISOString(),
        desactivee: base.desactivee?.raison === "plantages" ? base.desactivee : null,
      };
      return activer({ ...e, extensions: { ...e.extensions, [cle]: entree } }, cle, profil, prives);
    });
  } catch (e) {
    await pose.annuler();
    return { ok: false, erreur: (e as Error).message };
  }
  await pose.valider();
  await d.noterErreur(cle, null);
  return { ok: true };
}

/**
 * Recharge une extension accordée depuis `~/WebAiOs/extensions/<id>` : copie préparée ; portée comprise dans l'accord →
 * elle remplace `copies/<id>`, `modifieeLe` change, les sessions la rechargent ; portée élargie → déchargée partout
 * (`desactivee: portee-elargie`), l'accord gardé jusqu'à un nouvel accord ; refus → rien ne change, les refus sont rendus
 * (et gardés comme erreur). Dossier absent : déchargée, l'entrée gardée avec l'erreur `DOSSIER_ABSENT`.
 * `demarrage` : `modifieeLe` ne change que si le dossier a changé depuis la copie en place.
 */
export function recharger(id: string, d: DependancesAgent, o: { demarrage?: boolean } = {}): Promise<ResultatRechargement> {
  const cle = cleAgent(id);
  if (!cle) return Promise.resolve({ etat: "refusee", detail: [`Identifiant d'extension invalide : ${id}`] });
  return enFile(`${d.dossier}|${cle}`, () => rechargement(id, cle, d, o.demarrage === true));
}

async function rechargement(id: string, cle: string, d: DependancesAgent, demarrage: boolean): Promise<ResultatRechargement> {
  if (!d.etatExtensions().extensions[cle]?.accord) return { etat: "refusee", detail: [SANS_ACCORD] };
  const p = await preparerAgent(id, d);
  if (!p.ok) {
    // « Dossier absent » seul bloque le chargement. Tout autre refus (dossier revenu avec un manifeste refusé, par
    // exemple) laisse l'ancienne copie, accordée, chargée : l'erreur gardée est le refus, comme pour toute extension.
    const absent = p.refus.includes(DOSSIER_ABSENT);
    await d.noterErreur(cle, p.refus.join(" ; "), absent);
    return { etat: "refusee", detail: p.refus };
  }
  const effacer = () => rm(p.staging, { recursive: true, force: true });
  const accord = d.etatExtensions().extensions[cle]?.accord;
  if (!accord) {
    await effacer();
    return { etat: "refusee", detail: [SANS_ACCORD] };
  }
  const { analyse } = p;
  if (porteeElargie(accord, analyse.portee)) {
    await effacer();
    try {
      await d.modifier((e) => {
        const x = e.extensions[cle];
        if (!x) return e;
        const desactivee = x.desactivee?.raison === "portee-elargie" ? x.desactivee : { raison: "portee-elargie" as const, le: new Date().toISOString() };
        return { ...e, extensions: { ...e.extensions, [cle]: { ...x, desactivee } } };
      });
    } catch (e) {
      return { etat: "refusee", detail: [(e as Error).message] };
    }
    await d.noterErreur(cle, null);
    return { etat: "desactivee", detail: [DESACTIVEE_PORTEE] };
  }

  const cible = copie(d.dossier, id);
  const enPlace = await readFile(join(cible, FICHIER_EMPREINTE), "utf8").catch(() => null);
  const change = !demarrage || enPlace !== p.empreinte;
  let pose: Awaited<ReturnType<typeof poserCopie>>;
  try {
    pose = await poserCopie(p.staging, cible);
  } catch (e) {
    await effacer();
    return { etat: "refusee", detail: [`Copie non posée : ${(e as Error).message}`] };
  }
  try {
    await d.modifier((e) => {
      const x = e.extensions[cle];
      if (!x?.accord || porteeElargie(x.accord, analyse.portee)) throw new Error("Accord changé pendant le rechargement");
      const entree: EntreeExtension = {
        ...x,
        nom: analyse.nom,
        version: analyse.version,
        modifieeLe: change || !x.modifieeLe ? new Date().toISOString() : x.modifieeLe,
        // Revenue dans son accord : elle repart. Des plantages, non (L'utilisateur la réactive).
        desactivee: x.desactivee?.raison === "portee-elargie" ? null : x.desactivee,
      };
      return { ...e, extensions: { ...e.extensions, [cle]: entree } };
    });
  } catch (e) {
    await pose.annuler();
    return { etat: "refusee", detail: [(e as Error).message] };
  }
  await pose.valider();
  await d.noterErreur(cle, null);
  return { etat: "rechargee", detail: [] };
}

/**
 * Au démarrage : les restes d'une copie interrompue (`copies/*.tmp`, `*.ancienne`, `*.attente`) sont effacés, puis
 * chaque extension de l'agent accordée est rechargée depuis son dossier (`recharger`, `demarrage`).
 */
export async function demarrerAgents(d: DependancesAgent): Promise<void> {
  const copies = join(d.dossier, "copies");
  let noms: string[] = [];
  try {
    noms = await readdir(copies);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("[extensions] copies illisibles :", e);
  }
  for (const nom of noms)
    if (/\.(tmp|ancienne|attente)$/.test(nom)) await rm(join(copies, nom), { recursive: true, force: true }).catch(() => undefined);
  for (const [cle, x] of Object.entries(d.etatExtensions().extensions)) {
    if (x.source !== "agent" || !x.accord) continue;
    const id = cle.slice("agent:".length);
    try {
      const r = await recharger(id, d, { demarrage: true });
      if (r.etat !== "rechargee") console.warn(`[extensions] ${cle} au démarrage : ${r.etat} (${r.detail.join(" ; ")})`);
    } catch (e) {
      console.error(`[extensions] ${cle} non rechargée au démarrage :`, e);
    }
  }
}
