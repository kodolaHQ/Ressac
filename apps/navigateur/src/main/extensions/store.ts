import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { webContents, type Session, type WebContents, type WebFrameMain } from "electron";
import {
  activer,
  analyserManifeste,
  cleExtension,
  desactiver,
  empreintePortee,
  lireCle,
  lireMessages,
  retirer,
  siteDePortee,
  type AnalyseManifeste,
  type EntreeExtension,
  type EtatExtensions,
  type IdProfil,
  type IdSite,
  type Portee,
} from "@webaios/noyau";
import { carteDe, DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE, SAISIE_INVALIDE, type CarteExtension, type ReponseAccord } from "../../commun/extensions";
import type { Espace, EtatNavigateur, IdFenetre } from "../../commun/modele";
import { telechargerStore, urlCrx } from "./telechargement";

export { SAISIE_INVALIDE };
export const INSTALLATION_REFUSEE = "Installation refusée";
export const TOUTES_COUPEES = "Les extensions sont toutes désactivées : installe-la depuis la page Extensions";

/** Le statut d'une extension désactivée (plantages, portée élargie) : rien n'est chargé tant que l'utilisateur ne la réactive pas. */
const statutDesactivee = (d: EntreeExtension["desactivee"]): ResultatStore | null =>
  d ? { ok: false, erreur: d.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE } : null;

const ID_CHROME = /^[a-p]{32}$/;

/**
 * L'id d'une extension du Store saisi par l'utilisateur : l'id seul, ou l'adresse de sa page
 * (`https://chromewebstore.google.com/detail/<nom>/<id>`, ou l'ancienne `https://chrome.google.com/webstore/detail/…`) ;
 * null pour toute autre saisie (autre site, autre page du Store, http).
 */
export function idDepuisSaisie(saisie: string): string | null {
  const s = saisie.trim();
  if (ID_CHROME.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const morceaux = u.pathname.split("/").filter(Boolean);
  let reste: string[];
  if (u.hostname === "chromewebstore.google.com" && morceaux[0] === "detail") reste = morceaux.slice(1);
  else if (u.hostname === "chrome.google.com" && morceaux[0] === "webstore" && morceaux[1] === "detail") reste = morceaux.slice(2);
  else return null;
  // `<nom>/<id>` ou `<id>` seul : l'id est toujours le dernier segment.
  if (reste.length < 1 || reste.length > 2) return null;
  const id = reste[reste.length - 1]!;
  return ID_CHROME.test(id) ? id : null;
}

/** Où l'extension est demandée : le profil de connexion, l'espace montré sur la carte, la fenêtre de la carte. */
export interface ContexteInstallation {
  profil: IdProfil;
  espace: Espace;
  fenetre: IdFenetre;
  /**
   * Demandée depuis l'interface de WebAiOs (adresse collée, IPC de la fenêtre principale) : seule à pouvoir poser une
   * carte pendant la coupure générale. La page du Store (scriptable) ne l'est jamais.
   */
  depuisInterface?: boolean;
}

export type ResultatStore = { ok: true } | { ok: false; erreur: string };

/** Ce dont l'installation a besoin du service des extensions (`ServiceExtensions.dependancesStore`). */
export interface DependancesStore {
  /** `<userData>/extensions`. */
  dossier: string;
  /** Adresse du CRX (tests : un faux Store local) ; par défaut `urlCrx`. */
  urlCrx?: (id: string) => string;
  etatNavigateur(): EtatNavigateur;
  etatExtensions(): EtatExtensions;
  /** Modifie le registre ; les sessions sont synchronisées avant qu'il ne rende. */
  modifier(changer: (e: EtatExtensions, profilsPrives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<EtatExtensions>;
  demanderAccord(c: CarteExtension, o: { fenetre?: IdFenetre; pendantCoupure?: boolean }): Promise<ReponseAccord>;
  /** `preparerStore` du noyau sur une version installée (lève si elle échoue). */
  preparer(cle: string, dossierVersion: string): Promise<void>;
  /**
   * Efface le stockage de l'extension (version à `chemin`, encore sur le disque) dans la session de chaque appli de
   * `sites` (plan 16). Appelé après l'écriture qui la retire (sessions synchronisées : elle n'y est plus chargée), avant
   * l'effacement de `store/<id>`. Ne lève pas (les échecs sont journalisés).
   */
  effacerDansSites?(cle: string, chemin: string, sites: IdSite[]): Promise<void>;
}

/** Les applis de site d'une entrée : celles où elle est active (`applis`) et celles où elle a démarré (`vues` en `site:*`). */
export function sitesDe(x: EntreeExtension): IdSite[] {
  const sites = new Set(Object.keys(x.applis ?? {}));
  for (const portee of Object.keys(x.vues)) {
    const id = siteDePortee(portee);
    if (id !== null) sites.add(id);
  }
  return [...sites];
}

/** Après le retrait de l'entrée : le stockage effacé dans les applis de site où elle a été active ou a démarré. */
async function effacerDansSites(d: DependancesStore, cle: string, chemin: string | null, sites: IdSite[]): Promise<void> {
  if (!chemin || sites.length === 0 || !d.effacerDansSites) return;
  try {
    await d.effacerDansSites(cle, chemin, sites);
  } catch (e) {
    console.error(`[extensions] stockage de ${cle} non effacé dans les applis de site :`, e);
  }
}

/** Une opération à la fois par extension (téléchargement, installation, mise à jour, désinstallation), par dossier. */
const files = new Map<string, Promise<unknown>>();

/** La file de l'extension `id` du Store dans `dossier` : celle de l'installation et de la désinstallation. */
export function enFileStore<T>(dossier: string, id: string, f: () => Promise<T>): Promise<T> {
  return uneAlaFois(`${dossier}|${id}`, f);
}

/** Vrai si la file de l'extension `id` est tenue (une installation, une carte, une mise à jour en cours). */
export function fileStoreOccupee(dossier: string, id: string): boolean {
  return files.has(`${dossier}|${id}`);
}

function uneAlaFois<T>(cle: string, f: () => Promise<T>): Promise<T> {
  const suivante = (files.get(cle) ?? Promise.resolve()).catch(() => {}).then(f);
  files.set(cle, suivante);
  void suivante
    .finally(() => {
      if (files.get(cle) === suivante) files.delete(cle);
    })
    .catch(() => {});
  return suivante;
}

export async function lireManifeste(dossierVersion: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(dossierVersion, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Le manifeste d'une version du Store analysé, son nom `__MSG_…__` résolu par ses `_locales` (fr, fr_FR, puis
 * `default_locale` ; lus sans suivre de lien, taille bornée).
 */
export async function analyserDossierStore(dossierVersion: string): Promise<AnalyseManifeste> {
  const brut = await lireManifeste(dossierVersion);
  return analyserManifeste(brut, { source: "store", messages: await lireMessages(dossierVersion, brut) });
}

/** Accord écrit seulement si l'utilisateur a accepté exactement la portée qu'on enregistre. */
export function accordPour(r: ReponseAccord, portee: Portee): boolean {
  return r.accepte && r.empreinte === empreintePortee(portee);
}

/**
 * Installe une extension du Store pour l'espace de `o` : téléchargée et vérifiée dans `<dossier>/store-attente/`,
 * analysée (un refus n'est jamais montré), la carte d'accord ; refusée, le dossier est retiré ; acceptée, déplacée sous
 * `<dossier>/store/<id>/<version>_0`, préparée, puis inscrite au registre (accord = portée montrée, active dans ce
 * profil) et les sessions synchronisées. Déjà installée : pas de téléchargement, la carte (même portée) puis activation
 * dans ce profil. Pendant la coupure générale, la carte est montrée (clic de l'utilisateur) et l'extension installée et
 * accordée, mais rien n'est chargé. Une à la fois par id.
 */
export function installerStore(id: string, o: ContexteInstallation, d: DependancesStore): Promise<ResultatStore> {
  if (!ID_CHROME.test(id)) return Promise.resolve({ ok: false, erreur: SAISIE_INVALIDE });
  return uneAlaFois(`${d.dossier}|${id}`, () => installer(id, o, d));
}

async function installer(id: string, o: ContexteInstallation, d: DependancesStore): Promise<ResultatStore> {
  const cle = cleExtension("store", id);
  const depuisInterface = o.depuisInterface === true;
  // Pendant la coupure générale, seule l'interface de WebAiOs peut demander une carte : la page du Store, non.
  if (d.etatExtensions().toutesCoupees && !depuisInterface) return { ok: false, erreur: TOUTES_COUPEES };
  const demander = (c: CarteExtension) => d.demanderAccord(c, { fenetre: o.fenetre, pendantCoupure: depuisInterface });
  const carte = (portee: { nom: string; version: string; portee: Portee; refus: string[]; avertissements: string[] }) =>
    carteDe(portee, { cle, source: "store", espace: o.espace, etat: d.etatNavigateur() });

  // Déjà installée (entrée au registre, version sur le disque) : rien à télécharger.
  const connue = d.etatExtensions().extensions[cle];
  const dossierConnu = connue ? join(d.dossier, "store", id, `${connue.version}_0`) : null;
  if (connue && dossierConnu && existsSync(join(dossierConnu, "manifest.json"))) {
    const desactivee = statutDesactivee(connue.desactivee);
    if (desactivee) return desactivee;
    if (connue.accord && connue.profils.includes(o.profil)) return { ok: true };
    const analyse = await analyserDossierStore(dossierConnu);
    if (analyse.refus.length > 0) return { ok: false, erreur: analyse.refus.join(" ; ") };
    const r = await demander(carte(analyse));
    if (!accordPour(r, analyse.portee)) return { ok: false, erreur: INSTALLATION_REFUSEE };
    try {
      await d.modifier((e, prives) => {
        const x = e.extensions[cle];
        if (!x) throw new Error("Extension retirée pendant la carte : installation annulée");
        return activer({ ...e, extensions: { ...e.extensions, [cle]: { ...x, accord: analyse.portee } } }, cle, o.profil, prives);
      });
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
    return { ok: true };
  }

  // Un essai interrompu a pu laisser une version décompressée : le `rename` de la bibliothèque échouerait (ENOTEMPTY,
  // rapporté en CRX_INVALIDE). L'attente de cet id ne sert qu'à cette installation, une à la fois.
  const attente = join(d.dossier, "store-attente");
  await rm(join(attente, id), { recursive: true, force: true });
  let telecharge: string;
  try {
    telecharge = await telechargerStore(id, attente, (d.urlCrx ?? urlCrx)(id));
  } catch (e) {
    console.error(`[extensions] ${cle} non téléchargée :`, (e as Error).cause ?? e);
    return { ok: false, erreur: (e as Error).message };
  }
  const nettoyer = () => rm(join(attente, id), { recursive: true, force: true });
  try {
    const analyse = await analyserDossierStore(telecharge);
    if (analyse.refus.length > 0) return { ok: false, erreur: analyse.refus.join(" ; ") };
    const r = await demander(carte(analyse));
    if (!accordPour(r, analyse.portee)) return { ok: false, erreur: INSTALLATION_REFUSEE };

    const cible = join(d.dossier, "store", id, `${analyse.version}_0`);
    await mkdir(join(d.dossier, "store", id), { recursive: true });
    // Un dossier à ce nom ici n'est jamais chargé (déjà installée, on ne serait pas là) : reste d'une désinstallation
    // interrompue, remplacé.
    await rm(cible, { recursive: true, force: true });
    await rename(telecharge, cible);
    try {
      await d.preparer(cle, cible);
    } catch (e) {
      await rm(cible, { recursive: true, force: true });
      return { ok: false, erreur: `Extension non préparée : ${(e as Error).message}` };
    }
    let desactivee: EntreeExtension["desactivee"] = null;
    try {
      await d.modifier((e) => {
        const avant = e.extensions[cle];
        desactivee = avant?.desactivee ?? null;
        const profils = avant ? [...new Set([...avant.profils, o.profil])] : [o.profil];
        return {
          ...e,
          extensions: {
            ...e.extensions,
            [cle]: {
              source: "store",
              idChrome: id,
              nom: analyse.nom,
              version: analyse.version,
              accord: analyse.portee,
              profils,
              epinglee: avant?.epinglee ?? false,
              modifieeLe: null,
              // Fichiers retrouvés : une désactivation (plantages, portée élargie) reste, avec ses profils.
              desactivee,
              majEnAttente: null,
              vues: avant?.vues ?? {},
              // Ses activations dans les applis de site restent (plan 16).
              ...(avant?.applis ? { applis: avant.applis } : {}),
            },
          },
        };
      });
    } catch (e) {
      // Rien d'inscrit : la version déplacée et préparée ne reste pas à moitié installée.
      await rm(cible, { recursive: true, force: true });
      throw e;
    }
    return statutDesactivee(desactivee) ?? { ok: true };
  } catch (e) {
    console.error(`[extensions] ${cle} non installée :`, e);
    return { ok: false, erreur: (e as Error).message };
  } finally {
    await nettoyer();
  }
}

/**
 * Désinstalle une extension : retirée du registre (les sessions la retirent avant que `modifier` ne rende), puis son
 * dossier effacé (`store/<id>`, ou la copie de l'agent `copies/<dossier>`). Une à la fois avec ses installations.
 */
export function desinstallerStore(cle: string, d: DependancesStore): Promise<void> {
  const lue = lireCle(cle);
  if (!lue) return Promise.reject(new Error(`Clé d'extension invalide : ${cle}`));
  return uneAlaFois(`${d.dossier}|${lue.id}`, async () => {
    // Relevé dans l'écriture : les applis de site où elle a été active ou a démarré, et sa version sur le disque.
    let sites: IdSite[] = [];
    let chemin: string | null = null;
    await d.modifier((e) => {
      const x = e.extensions[cle];
      if (x && lue.source === "store") {
        sites = sitesDe(x);
        chemin = join(d.dossier, "store", lue.id, `${x.version}_0`);
      }
      return retirer(e, cle);
    });
    // Déchargée de chaque session (la synchronisation est faite) ; son manifeste est encore là pour le talon (C6).
    await effacerDansSites(d, cle, chemin, sites);
    await rm(join(d.dossier, lue.source === "store" ? "store" : "copies", lue.id), { recursive: true, force: true });
  });
}

/**
 * « Retirer de Chrome » sur la page du Store d'un profil : n'agit que sur ce profil. Refusé si l'extension n'y est pas
 * active ; retirée de ce profil seulement si un autre profil ou une appli de site la garde (fichiers et entrée restent) ;
 * sinon désinstallée (entrée retirée, stockage effacé dans les applis où elle a démarré, puis `store/<id>` effacé). Décidé dans l'écriture sérialisée du registre, une à la fois par id.
 */
export function retirerDuProfilStore(cle: string, profil: IdProfil, d: DependancesStore): Promise<void> {
  const lue = lireCle(cle);
  if (lue?.source !== "store") return Promise.reject(new Error(`Extension du Store inconnue : ${cle}`));
  return uneAlaFois(`${d.dossier}|${lue.id}`, async () => {
    let derniere = false;
    let sites: IdSite[] = [];
    let chemin: string | null = null;
    await d.modifier((e) => {
      const x = e.extensions[cle];
      if (!x) throw new Error(`Extension du Store inconnue : ${cle}`);
      if (!x.profils.includes(profil)) throw new Error(`Extension pas active dans ce profil : ${cle}`);
      // Active dans une appli de site : elle n'est pas désinstallée (plan 16).
      derniere = x.profils.length === 1 && Object.keys(x.applis ?? {}).length === 0;
      if (derniere) {
        sites = sitesDe(x);
        chemin = join(d.dossier, "store", lue.id, `${x.version}_0`);
      }
      return derniere ? retirer(e, cle) : desactiver(e, cle, profil);
    });
    if (derniere) {
      await effacerDansSites(d, cle, chemin, sites);
      await rm(join(d.dossier, "store", lue.id), { recursive: true, force: true });
    }
  });
}

/**
 * `beforeInstall` de la bibliothèque du Store pour la session d'un profil : l'onglet de la page du Store (son espace et
 * sa fenêtre) passe par notre installation ; `allow` seulement si elle a réussi ET que l'extension est chargée dans
 * cette session (la bibliothèque la trouve alors chargée et ne fait rien de plus). Sinon `deny` : la bibliothèque ne
 * charge ni ne télécharge jamais rien elle-même (coupure générale, carte refusée, onglet inconnu, autre profil).
 */
export function avantInstallation(o: {
  profil: IdProfil;
  session: Pick<Session, "extensions">;
  contexteDe(wc: WebContents): ContexteInstallation | null;
  installer(id: string, c: ContexteInstallation): Promise<ResultatStore>;
}): (details: { id: string; frame: WebFrameMain }) => Promise<{ action: "allow" | "deny" }> {
  return async (details) => {
    try {
      const wc = webContents.fromFrame(details.frame);
      const c = wc ? o.contexteDe(wc) : null;
      if (!c || c.profil !== o.profil) return { action: "deny" };
      const r = await o.installer(details.id, c);
      return r.ok && o.session.extensions.getExtension(details.id) ? { action: "allow" } : { action: "deny" };
    } catch (e) {
      console.error("[extensions] installation depuis la page du Store :", e);
      return { action: "deny" };
    }
  };
}
