import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleExtension, empreintePortee, porteeElargie, type EtatExtensions, type IdProfil, type Portee } from "@webaios/noyau";
import { analyserDossierStore, enFileStore } from "./store";
import { telechargerStore } from "./telechargement";

/** Entre deux vérifications des mises à jour du Store. */
export const INTERVALLE_MAJ_MS = 5 * 3600_000;
/** Première vérification, après le démarrage. */
export const PREMIERE_MAJ_MS = 60_000;
/** Le service de mises à jour du Chrome Web Store (protocole Omaha 3.1, JSON), celui de la bibliothèque. */
export const URL_MISES_A_JOUR = "https://update.googleapis.com/service/update2/json";

const ID_CHROME = /^[a-p]{32}$/;
const PREFIXE = ")]}'\n";
const SESSION = randomUUID();

/** L'adresse du service des mises à jour ; en test (mode invisible seulement), `WEBAIOS_TEST_STORE_MAJ_URL`. */
export function urlMisesAJour(): string {
  const test = process.env.WEBAIOS_INVISIBLE === "1" ? process.env.WEBAIOS_TEST_STORE_MAJ_URL : undefined;
  return test || URL_MISES_A_JOUR;
}

/** Compare deux versions d'extension (`1.2.3.4`), nombre par nombre, les morceaux absents valant 0. */
export function comparerVersions(a: string, b: string): number {
  const x = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const plateforme = () => (process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform);
const architecture = () => (process.arch === "ia32" ? "x86" : process.arch);

export interface MiseAJour {
  id: string;
  version: string;
  /** Adresse du CRX donnée par le Store. */
  url: string;
}

/**
 * Demande au Store (requête JSON Omaha, comme la bibliothèque) les versions disponibles des extensions `entrees` ; rend
 * seulement celles plus récentes que la version installée. Toute erreur (réseau, HTTP, réponse sans le préfixe `)]}'`,
 * JSON, forme inattendue) rend `[]`, journalisée.
 */
export async function chercherMisesAJour(
  entrees: { id: string; version: string }[],
  o: { fetch: typeof fetch; url?: string },
): Promise<MiseAJour[]> {
  if (entrees.length === 0) return [];
  const installees = new Map(entrees.map((e) => [e.id, e.version]));
  const chrome = process.versions.chrome ?? "";
  try {
    const reponse = await o.fetch(o.url ?? urlMisesAJour(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Update-Interactivity": "bg",
        "X-Goog-Update-AppId": entrees.map((e) => e.id).join(","),
        "X-Goog-Update-Updater": `chromiumcrx-${chrome}`,
      },
      body: JSON.stringify({
        request: {
          "@updater": "webaios",
          acceptformat: "crx3",
          // Comme la bibliothèque : avec `version`, le Store répond toujours « noupdate ».
          app: entrees.map((e) => ({ appid: e.id, updatecheck: {} })),
          os: { platform: plateforme(), arch: architecture() },
          prodversion: chrome,
          protocol: "3.1",
          requestid: randomUUID(),
          sessionid: SESSION,
        },
      }),
    });
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const texte = await reponse.text();
    if (!texte.startsWith(PREFIXE)) throw new Error("réponse sans le préfixe )]}'");
    const json = JSON.parse(texte.slice(PREFIXE.length)) as { response?: { app?: unknown } };
    const apps = json.response?.app;
    if (!Array.isArray(apps)) throw new Error("réponse sans liste d'extensions");
    const majs: MiseAJour[] = [];
    for (const app of apps as { appid?: unknown; updatecheck?: { status?: unknown; manifest?: { version?: unknown }; urls?: { url?: { codebase?: unknown }[] } } }[]) {
      const u = app.updatecheck;
      if (u?.status !== "ok") continue;
      const id = app.appid;
      const version = u.manifest?.version;
      const url = u.urls?.url?.[0]?.codebase;
      if (typeof id !== "string" || typeof version !== "string" || typeof url !== "string") throw new Error("mise à jour de forme inattendue");
      const installee = installees.get(id);
      if (!ID_CHROME.test(id) || installee === undefined) throw new Error(`mise à jour d'une extension non demandée : ${id}`);
      if (comparerVersions(installee, version) < 0) majs.push({ id, version, url });
    }
    return majs;
  } catch (e) {
    console.error("[extensions] vérification des mises à jour du Store :", e);
    return [];
  }
}

export type ResultatMiseAJour = "appliquee" | "en-attente" | "echec";

/** Ce dont la mise à jour a besoin du service des extensions. */
export interface DependancesMiseAJour {
  /** `<userData>/extensions`. */
  dossier: string;
  etatExtensions(): EtatExtensions;
  /** Modifie le registre ; les sessions sont synchronisées (version rechargée) avant qu'il ne rende. */
  modifier(changer: (e: EtatExtensions, profilsPrives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<EtatExtensions>;
  /** `preparerStore` du noyau sur la version téléchargée (lève si elle échoue). */
  preparer(cle: string, dossierVersion: string): Promise<void>;
  /** L'erreur de la dernière mise à jour de `cle` (pour la page) ; null : effacée. */
  noterErreur(cle: string, erreur: string | null): void;
  /** Après une écriture : l'erreur si `cle` n'a pas pu être chargée dans un profil où elle est active, sinon null. */
  chargementRate(cle: string): string | null;
  /** Pendant `f`, un échec de chargement de `cle` ne compte pas comme un plantage. */
  sansPlantage<T>(cle: string, f: () => Promise<T>): Promise<T>;
  /** Après une écriture : `cle` est chargée dans au moins un profil. */
  chargee(cle: string): boolean;
  /**
   * La nouvelle version est inscrite mais rien ne la charge (coupure générale, inactive) : l'essai est remis au premier
   * chargement (`resoudreEssai` après chaque synchronisation) ; l'ancienne version reste jusque-là.
   */
  differer(cle: string, essai: EssaiMiseAJour): void;
}

/** Une mise à jour inscrite dont le chargement n'a pas encore été essayé : de quoi revenir à `avant`. */
export interface EssaiMiseAJour {
  avant: { version: string; nom: string; accord: Portee | null };
  nouvelle: { version: string; portee: Portee; chemin: string };
  /** Le dossier de l'ancienne version, effacé une fois la nouvelle chargée. */
  ancienne: string;
}

/**
 * Après une synchronisation, l'essai différé de `cle` : la nouvelle version a été chargée → l'ancienne s'efface ; elle
 * n'a pas pu l'être → l'ancienne revient (`retablirSiNonChargee`) ; toujours rien de chargé → `"en-cours"`. Une version
 * inscrite qui n'est plus la nouvelle (désinstallée, autre mise à jour) clôt l'essai sans rien toucher. À appeler dans la
 * file de l'extension.
 */
export async function resoudreEssai(cle: string, essai: EssaiMiseAJour, d: DependancesMiseAJour): Promise<"en-cours" | "fini"> {
  const y = d.etatExtensions().extensions[cle];
  if (!y || y.version !== essai.nouvelle.version) return "fini";
  if (await retablirSiNonChargee(cle, essai.avant, essai.nouvelle, d)) return "fini";
  if (!d.chargee(cle)) return "en-cours";
  if (essai.ancienne !== essai.nouvelle.chemin) await rm(essai.ancienne, { recursive: true, force: true });
  return "fini";
}

/**
 * La version `nouvelle` vient d'être inscrite : si une session n'a pas pu la charger, l'ancienne (`avant`, toujours sur
 * le disque) est réinscrite (les sessions la rechargent) et la nouvelle reste en attente (`majEnAttente`), avec l'erreur
 * notée. Rend vrai si elle a été retirée ainsi.
 */
async function retablirSiNonChargee(
  cle: string,
  avant: { version: string; nom: string; accord: Portee | null },
  nouvelle: { version: string; portee: Portee; chemin: string },
  d: DependancesMiseAJour,
): Promise<boolean> {
  const rate = d.chargementRate(cle);
  if (!rate) return false;
  console.error(`[extensions] ${cle} ${nouvelle.version} non chargée, la version ${avant.version} revient :`, rate);
  await d.modifier((e) => {
    const y = e.extensions[cle];
    if (!y || y.version !== nouvelle.version) return e;
    return {
      ...e,
      extensions: { ...e.extensions, [cle]: { ...y, nom: avant.nom, version: avant.version, accord: avant.accord, majEnAttente: { ...nouvelle } } },
    };
  });
  d.noterErreur(cle, `Mise à jour ${nouvelle.version} non chargée (la version ${avant.version} reste) : ${rate}`);
  return true;
}

const dossierVersion = (dossier: string, id: string, version: string) => join(dossier, "store", id, `${version}_0`);

/**
 * Applique une mise à jour trouvée par `chercherMisesAJour`, dans la file de l'extension (avec ses installations et
 * désinstallations) : téléchargée et vérifiée dans `store-attente/`, déplacée sous `store/<id>/<version>_0`, préparée,
 * analysée. Portée non élargie par rapport à l'accord : `version` remplacée au registre (les sessions où elle est
 * chargée la rechargent pendant cette écriture), puis l'ancienne version effacée ; `"appliquee"`. Une session n'a pas pu
 * la charger : l'ancienne version est réinscrite (rechargée), la nouvelle reste en attente avec l'erreur, aucun plantage
 * n'est compté ; `"en-attente"`. Élargie : `majEnAttente`
 * (l'ancienne reste chargée et active) ; `"en-attente"`. Échec (Store, CRX, préparation, refus) : rien ne change, rien ne
 * reste, l'erreur est notée ; `"echec"`. Pendant la coupure générale, les fichiers sont remplacés et rien n'est chargé.
 * Extension retirée entre-temps, ou déjà à cette version : `"echec"` sans erreur ni téléchargement.
 */
export function appliquerMiseAJour(maj: MiseAJour, d: DependancesMiseAJour): Promise<ResultatMiseAJour> {
  if (!ID_CHROME.test(maj.id)) return Promise.resolve("echec");
  return enFileStore(d.dossier, maj.id, () => appliquer(maj, d));
}

async function appliquer(maj: MiseAJour, d: DependancesMiseAJour): Promise<ResultatMiseAJour> {
  const cle = cleExtension("store", maj.id);
  const x = d.etatExtensions().extensions[cle];
  if (!x || x.source !== "store" || comparerVersions(x.version, maj.version) >= 0) return "echec";
  // Une attente n'est jamais remplacée par une version plus basse, ni par la même déjà téléchargée (rien à refaire).
  const m = x.majEnAttente;
  if (m) {
    const ecart = comparerVersions(maj.version, m.version);
    if (ecart < 0 || (ecart === 0 && existsSync(join(dossierVersion(d.dossier, maj.id, m.version), "manifest.json")))) return "en-attente";
  }

  const echec = (message: string, cause?: unknown): ResultatMiseAJour => {
    console.error(`[extensions] mise à jour de ${cle} non installée :`, cause ?? message);
    d.noterErreur(cle, `Mise à jour ${maj.version} non installée : ${message}`);
    return "echec";
  };
  const attente = join(d.dossier, "store-attente");
  // Un essai interrompu a pu laisser une version décompressée (le `rename` de la bibliothèque échouerait).
  await rm(join(attente, maj.id), { recursive: true, force: true });
  let cible: string | null = null;
  try {
    let telecharge: string;
    try {
      telecharge = await telechargerStore(maj.id, attente, maj.url);
    } catch (e) {
      return echec((e as Error).message, (e as Error).cause ?? e);
    }
    const analyse = await analyserDossierStore(telecharge);
    if (analyse.refus.length > 0) return echec(analyse.refus.join(" ; "));
    // Comme Chrome : le fichier doit être la version annoncée (sinon, ni une version plus basse ni une boucle de
    // téléchargements ne remplacent ce qui est installé ou en attente).
    if (analyse.version !== maj.version) return echec(`le Store a annoncé la version ${maj.version} et fourni la ${analyse.version}`);

    const nouvelle = dossierVersion(d.dossier, maj.id, analyse.version);
    await mkdir(join(d.dossier, "store", maj.id), { recursive: true });
    // Jamais chargée (plus récente que la version installée) : reste d'un essai interrompu, ou une attente remplacée.
    await rm(nouvelle, { recursive: true, force: true });
    await rename(telecharge, nouvelle);
    cible = nouvelle;
    try {
      await d.preparer(cle, nouvelle);
    } catch (e) {
      return echec(`extension non préparée : ${(e as Error).message}`, e);
    }

    // Écrits dans `modifier` : les types sont donnés pour que TypeScript ne les fige pas à leur valeur initiale.
    let elargie = false as boolean;
    let ancienne = null as string | null;
    let attenteAvant = null as string | null;
    const inscrite = () => {
      const y = d.etatExtensions().extensions[cle];
      return !!y && (y.version === analyse.version || y.majEnAttente?.version === analyse.version);
    };
    let suiteRatee = false;
    let avant = null as { version: string; nom: string; accord: Portee | null } | null;
    const retiree = await d.sansPlantage(cle, async () => {
      await d.modifier((e) => {
        const y = e.extensions[cle];
        if (!y) throw new Error("extension retirée pendant la mise à jour");
        avant = { version: y.version, nom: y.nom, accord: y.accord };
        // Comparée à l'accord écrit au moment même de l'écriture.
        elargie = !y.accord || porteeElargie(y.accord, analyse.portee);
        attenteAvant = y.majEnAttente ? dossierVersion(d.dossier, maj.id, y.majEnAttente.version) : null;
        if (elargie) {
          return { ...e, extensions: { ...e.extensions, [cle]: { ...y, majEnAttente: { version: analyse.version, portee: analyse.portee, chemin: nouvelle } } } };
        }
        ancienne = dossierVersion(d.dossier, maj.id, y.version);
        return { ...e, extensions: { ...e.extensions, [cle]: { ...y, nom: analyse.nom, version: analyse.version, majEnAttente: null } } };
      }).catch((e: unknown) => {
        // Le registre a pu être écrit avant l'erreur (sessions, cartes, avis) : la version qu'il nomme reste alors.
        if (!inscrite()) throw e;
        suiteRatee = true;
        console.error(`[extensions] mise à jour de ${cle} inscrite, mais la suite a échoué :`, e);
      });
      // Pas chargée : l'ancienne version revient, la nouvelle attend (aucun plantage compté pour cet essai).
      return !elargie && !suiteRatee && avant
        ? retablirSiNonChargee(cle, avant, { version: analyse.version, portee: analyse.portee, chemin: nouvelle }, d)
        : false;
    });
    cible = null; // inscrite : elle reste.
    if (retiree) {
      if (attenteAvant && attenteAvant !== nouvelle) await rm(attenteAvant, { recursive: true, force: true });
      return "en-attente";
    }
    // Rien ne la charge maintenant : l'ancienne version reste jusqu'au premier chargement (et y revient s'il échoue).
    if (!elargie && !suiteRatee && avant && ancienne && !d.chargee(cle)) {
      d.differer(cle, { avant, nouvelle: { version: analyse.version, portee: analyse.portee, chemin: nouvelle }, ancienne });
      ancienne = null;
    }
    // Les sessions ont rechargé (ou gardé) ce qu'il faut : l'ancienne version et une attente abandonnée s'effacent.
    // Sessions pas synchronisées : l'ancienne version, peut-être encore chargée, reste.
    for (const reste of [suiteRatee ? null : ancienne, attenteAvant]) if (reste && reste !== nouvelle) await rm(reste, { recursive: true, force: true });
    d.noterErreur(cle, null);
    return elargie ? "en-attente" : "appliquee";
  } catch (e) {
    return echec((e as Error).message, e);
  } finally {
    if (cible) await rm(cible, { recursive: true, force: true });
    await rm(join(attente, maj.id), { recursive: true, force: true });
  }
}

/**
 * Accepte une mise à jour en attente (carte acceptée pour `portee`), dans la file de l'extension : seulement si la même
 * version, de même portée, attend toujours et que ses fichiers sont là ; `version` et `accord` remplacés au registre (les
 * sessions la rechargent), puis l'ancienne version effacée. Sinon `"echec"`, l'erreur notée.
 */
export function accepterMiseAJour(
  cle: string,
  attendue: { version: string; nom: string; portee: Portee },
  d: DependancesMiseAJour,
): Promise<ResultatMiseAJour> {
  const id = cle.slice("store:".length);
  if (!cle.startsWith("store:") || !ID_CHROME.test(id)) return Promise.resolve("echec");
  return enFileStore(d.dossier, id, async () => {
    const nouvelle = dossierVersion(d.dossier, id, attendue.version);
    let ancienne = null as string | null;
    let suiteRatee = false;
    let avant = null as { version: string; nom: string; accord: Portee | null } | null;
    let retiree = false;
    try {
      if (!existsSync(join(nouvelle, "manifest.json"))) throw new Error("fichiers de la mise à jour absents");
      retiree = await d.sansPlantage(cle, async () => {
        await d.modifier((e) => {
          const y = e.extensions[cle];
          const m = y?.majEnAttente;
          if (!y || !m || m.version !== attendue.version || empreintePortee(m.portee) !== empreintePortee(attendue.portee))
            throw new Error("la mise à jour en attente a changé");
          ancienne = dossierVersion(d.dossier, id, y.version);
          avant = { version: y.version, nom: y.nom, accord: y.accord };
          return { ...e, extensions: { ...e.extensions, [cle]: { ...y, nom: attendue.nom, version: m.version, accord: m.portee, majEnAttente: null } } };
        }).catch((e: unknown) => {
          // Écrit avant l'erreur (sessions, cartes, avis) : appliquée, mais l'ancienne, peut-être encore chargée, reste.
          if (d.etatExtensions().extensions[cle]?.version !== attendue.version) throw e;
          suiteRatee = true;
          console.error(`[extensions] mise à jour de ${cle} inscrite, mais la suite a échoué :`, e);
        });
        // Pas chargée : l'ancienne version et son accord reviennent, la nouvelle attend de nouveau.
        return !suiteRatee && avant
          ? retablirSiNonChargee(cle, avant, { version: attendue.version, portee: attendue.portee, chemin: nouvelle }, d)
          : false;
      });
    } catch (e) {
      console.error(`[extensions] mise à jour de ${cle} non appliquée :`, e);
      d.noterErreur(cle, `Mise à jour ${attendue.version} non installée : ${(e as Error).message}`);
      return "echec";
    }
    if (retiree) return "en-attente";
    if (!suiteRatee && avant && ancienne && !d.chargee(cle)) {
      d.differer(cle, { avant, nouvelle: { version: attendue.version, portee: attendue.portee, chemin: nouvelle }, ancienne });
      ancienne = null;
    }
    if (ancienne && ancienne !== nouvelle && !suiteRatee) await rm(ancienne, { recursive: true, force: true });
    d.noterErreur(cle, null);
    return "appliquee";
  });
}

/**
 * Abandonne la mise à jour en attente `version` (ses fichiers ne correspondent plus à ce qui est inscrit), dans la file
 * de l'extension : `majEnAttente` retiré et son dossier effacé, pour qu'elle soit téléchargée de nouveau à la prochaine
 * vérification.
 */
export function abandonnerMiseAJour(cle: string, version: string, d: DependancesMiseAJour): Promise<void> {
  const id = cle.slice("store:".length);
  if (!cle.startsWith("store:") || !ID_CHROME.test(id)) return Promise.resolve();
  return enFileStore(d.dossier, id, async () => {
    const x = d.etatExtensions().extensions[cle];
    if (x?.majEnAttente?.version !== version) return;
    await d.modifier((e) => {
      const y = e.extensions[cle];
      if (y?.majEnAttente?.version !== version) return e;
      return { ...e, extensions: { ...e.extensions, [cle]: { ...y, majEnAttente: null } } };
    });
    if (d.etatExtensions().extensions[cle]?.version !== version) await rm(dossierVersion(d.dossier, id, version), { recursive: true, force: true });
  });
}
