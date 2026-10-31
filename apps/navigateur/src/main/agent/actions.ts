import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTION_INCONNUE,
  chainesDe,
  COMPOSANT_HTML_MAX,
  ID_ACTION,
  ID_EXECUTION,
  lireAccords,
  lireAction,
  lireActions,
  lireExecution,
  lireResultat,
  listerExecutions,
  retirerAccord,
  supprimerDonneesAction,
  type ActionLue,
  type ActionsNoyau,
  type CheminsEspace,
  type EtatActions,
  type Execution,
  type PageAction,
  type ResultatLancement,
  type ResumeExecution,
} from "@webaios/noyau";
import type { Accord, Action, ProfilPourAccord } from "../../commun/api";
import { ACTIONS_EN_ESPACE_PRIVE, composantDuCadre, SCHEMA_COMPOSANT, SCHEMA_IMAGE, urlComposant, urlImage, type ActionAffichee } from "../../commun/actions";
import type { EtatNavigateur, IdFenetre } from "../../commun/modele";
import { corpsBorne } from "../reseau-interface";
import { lireConfine, profilsPourAccord, reponseAffichage, urlOuvrable } from "./accueil";
import { profilsLisibles } from "./lecture-invisible";

export { SCHEMA_COMPOSANT, SCHEMA_IMAGE, urlComposant, urlImage, COMPOSANT_HTML_MAX };

/** Taille au plus d'une image des résultats servie à l'interface. */
export const IMAGE_MAX = 5 * 1024 * 1024;
const DELAI_IMAGE_MS = 10_000;
/** Redirections suivies au plus pour une image, chacune revérifiée (https, ni locale ni du réseau privé). */
export const REDIRECTIONS_IMAGE = 3;
/** Cherche une adresse sans cookies et sans suivre les redirections (elles sont suivies et vérifiées ici). */
export type ChercherImage = (url: string, init: { signal: AbortSignal; credentials: "omit"; redirect: "manual" }) => Promise<Response>;
/** Une image ne se cherche qu'en https, jamais sur la machine ni sur le réseau local. */
const adresseImagePermise = (url: string) => url.startsWith("https://") && urlOuvrable(url);
const MESSAGE_SANS_NOYAU = "Le service des actions ne répond pas (agent arrêté ?)";
const AUCUNE_ACTION: EtatActions = { courantes: [], enAttente: [] };

/** L'action, l'exécution et l'adresse d'une URL `webaios-image://<id>/<exécution>?u=<url>`, sinon null. */
export function cibleImage(url: string): { id: string; execution: string; cible: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const execution = u.pathname.slice(1);
  const cible = u.searchParams.get("u");
  if (u.protocol !== `${SCHEMA_IMAGE}:` || !ID_ACTION.test(u.hostname) || execution.length > 64 || !ID_EXECUTION.test(execution) || !cible) return null;
  return { id: u.hostname, execution, cible };
}

/**
 * Réponse du schéma `webaios-image:`. Une image se charge sans clic : son adresse pourrait porter des données vers un
 * tiers. Donc 404 sans rien chercher, sauf pour une action actuelle sans compte, une exécution gardée, et une adresse
 * `https` (ni locale) présente telle quelle dans ses résultats, sans accord du compte. Cherchée sans cookies (`chercher` :
 * la session à part des favicons), redirections suivies ici (`REDIRECTIONS_IMAGE`, chacune revérifiée), `image/*`
 * seulement, `IMAGE_MAX` au plus.
 */
export async function repondreImage(
  o: { dossierActions: string; lireAction: (id: string) => Promise<ActionLue | null>; chercher: ChercherImage },
  url: string,
): Promise<Response> {
  const refus = () => new Response("", { status: 404 });
  const c = cibleImage(url);
  if (!c || !adresseImagePermise(c.cible)) return refus();
  const action = await o.lireAction(c.id);
  if (!action || "erreur" in action || action.declaration.sources.compte.length > 0) return refus();
  // Une action réécrite sans compte garde peut-être des résultats lus avec : un accord encore là suffit à refuser.
  const accords = await lireAccords(o.dossierActions).catch(() => null);
  if (!accords || Object.hasOwn(accords, c.id)) return refus();
  const [resultat, execution] = await Promise.all([lireResultat(o.dossierActions, c.id, c.execution), lireExecution(join(o.dossierActions, c.id), c.execution)]);
  if (!resultat || !execution || !chainesDe(resultat.resultats).has(c.cible)) return refus();
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), DELAI_IMAGE_MS);
  try {
    let adresse = c.cible;
    let r = await o.chercher(adresse, { signal: arret.signal, credentials: "omit", redirect: "manual" });
    for (let sauts = 0; r.status >= 300 && r.status < 400; sauts++) {
      await r.body?.cancel().catch(() => {});
      const location = r.headers.get("location");
      if (!location || sauts >= REDIRECTIONS_IMAGE) return refus();
      let suivante: string;
      try {
        suivante = new URL(location, adresse).href;
      } catch {
        return refus();
      }
      // Une page hostile pourrait rediriger vers le réseau local ou un port de WebAiOs : chaque saut est revérifié.
      if (!adresseImagePermise(suivante)) return refus();
      adresse = suivante;
      r = await o.chercher(adresse, { signal: arret.signal, credentials: "omit", redirect: "manual" });
    }
    const type = r.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!r.ok || !type.startsWith("image/")) {
      await r.body?.cancel().catch(() => {});
      return refus();
    }
    const corps = await corpsBorne(r, IMAGE_MAX);
    if (!corps) return refus();
    return new Response(corps, { headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff" } });
  } catch {
    return refus();
  } finally {
    clearTimeout(minuterie);
  }
}

/**
 * Réponse du schéma `webaios-composant:` : seulement `<composants>/<nom>/composant.html` (mêmes gardes que l'affichage
 * d'un widget : liens symboliques, CSP sans réseau, indice réseau refusé), `COMPOSANT_HTML_MAX` au plus. `composants` :
 * null tant que l'agent n'est pas prêt.
 */
export async function repondreComposant(composants: string | null, url: string): Promise<Response> {
  const nom = composantDuCadre(url);
  if (!nom || !composants) return reponseAffichage(null);
  return reponseAffichage(await lireConfine(composants, join(composants, nom, "composant.html"), COMPOSANT_HTML_MAX));
}

/** Un lien de la page d'une action s'ouvre seulement si son adresse figure telle quelle dans les résultats, en http(s). */
export async function lienPermis(dossierActions: string, id: string, execution: string, url: string): Promise<boolean> {
  if (!urlOuvrable(url)) return false;
  const r = await lireResultat(dossierActions, id, execution);
  return !!r && chainesDe(r.resultats).has(url);
}

/**
 * L'utilisateur supprime une action : son dossier part dans `actions/.corbeille` (rien n'est détruit), puis `oublier` retire son
 * accord et ses données (une action recréée sous le même id ne doit pas en hériter).
 */
export async function retirerAction(c: CheminsEspace, id: string, oublier: (id: string) => Promise<void>): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const corbeille = join(c.actions, ".corbeille");
  await mkdir(corbeille, { recursive: true });
  await rename(join(c.actions, id), join(corbeille, `${id}-${Date.now()}`));
  await oublier(id);
}

/** Les actions du disque, prêtes à afficher : déclaration, accord et dernière vraie exécution. Lues sans le noyau. */
export async function lireActionsAffichees(c: CheminsEspace, dossierActions: string): Promise<ActionAffichee[]> {
  const [lues, accords] = await Promise.all([lireActions(c), lireAccords(dossierActions).catch(() => ({}) as Record<string, unknown>)]);
  return Promise.all(
    lues.map(async (a): Promise<ActionAffichee> => {
      const derniere = (await listerExecutions(join(dossierActions, a.id))).find((e) => !e.essai && !e.id.endsWith("-essai"));
      const dernier = derniere ? { execution: derniere.id, debut: derniere.debut, statut: derniere.statut } : null;
      if ("erreur" in a) return { id: a.id, nom: a.id, description: "", motsCles: [], saisie: null, compte: [], publiques: [], accord: false, dernier, erreur: a.erreur };
      const d = a.declaration;
      return {
        id: a.id,
        nom: d.nom,
        description: d.description,
        motsCles: d.motsCles,
        saisie: d.saisie ?? null,
        compte: d.sources.compte,
        publiques: d.sources.publiques,
        accord: Object.hasOwn(accords, a.id),
        dernier,
      };
    }),
  );
}

/** L'espace actif de la fenêtre est privé ; une fenêtre ou un espace inconnus comptent comme privés. */
export function espaceActifPrive(etat: Pick<EtatNavigateur, "espaces" | "fenetres">, f: IdFenetre): boolean {
  const fenetre = etat.fenetres.find((x) => x.id === f);
  return !fenetre || (etat.espaces.find((e) => e.id === fenetre.espaceActif)?.prive ?? true);
}

type Resultat = { ok: true } | { ok: false; erreur: string };

/** Le service des actions pour l'interface : chaque appel nomme la fenêtre d'où il vient. */
export interface ServiceActions {
  liste(f: IdFenetre): Promise<ActionAffichee[]>;
  ouvrir(f: IdFenetre, id: string, saisie: string | null): Promise<Resultat>;
  lancer(f: IdFenetre, id: string, saisie: string | null): Promise<ResultatLancement>;
  arreter(f: IdFenetre, id: string): void;
  page(f: IdFenetre, id: string, execution: string | null): Promise<PageAction | null>;
  executions(f: IdFenetre, id: string): Promise<ResumeExecution[]>;
  /** Une exécution complète, pour le constructeur de l'action. */
  execution(f: IdFenetre, id: string, execution: string): Promise<Execution | null>;
  direct(f: IdFenetre): Promise<EtatActions>;
  ouvrirLien(f: IdFenetre, id: string, execution: string, url: string): Promise<void>;
  profilsPourAccord(f: IdFenetre): ProfilPourAccord[];
  accorder(f: IdFenetre, a: Accord): Promise<Resultat>;
  refuserAccord(f: IdFenetre, id: string): Promise<void>;
  supprimer(f: IdFenetre, id: string): Promise<Resultat>;
  voirWorkflow(f: IdFenetre, id: string): Promise<void>;
}

/**
 * Le service des actions. Tout appel venu d'une fenêtre dont l'espace actif est privé est refusé : les actions n'y sont
 * pas disponibles (ni liste, ni lancement, ni résultats).
 */
export function creerServiceActions(o: {
  etat: () => EtatNavigateur;
  agir: (a: Action) => void;
  noyau: () => { actions: ActionsNoyau } | null;
  chemins: () => CheminsEspace | null;
  dossierActions: string;
  maintenant?: () => number;
  /** Un lancement refusé sans exécution écrite vient d'être noté : les pages des actions se relisent. */
  surChange?: () => void;
}): ServiceActions {
  const maintenant = o.maintenant ?? Date.now;
  /**
   * Par action, le dernier lancement refusé sans rien écrire (atelier arrêté, workflow.json absent ou invalide…) : la
   * page ne peut pas le relire sur le disque, `liste` le lui donne tant qu'aucune exécution plus récente n'existe.
   */
  const refusLancement = new Map<string, { erreur: string; quand: string }>();
  /** Lancements suivis, par action : une suppression les oublie, leur fin ne note plus rien (action recréée sous le même id). */
  const lancementsSuivis = new Map<string, Set<Promise<ResultatLancement>>>();
  const suivreLancement = (id: string, fin: Promise<ResultatLancement>): Promise<ResultatLancement> => {
    refusLancement.delete(id);
    const suivis = lancementsSuivis.get(id) ?? new Set();
    lancementsSuivis.set(id, suivis.add(fin));
    return fin.then((r) => {
      const suivi = lancementsSuivis.get(id)?.delete(fin) ?? false;
      if (lancementsSuivis.get(id)?.size === 0) lancementsSuivis.delete(id);
      if (suivi && !r.execution) {
        refusLancement.set(id, { erreur: r.erreur ?? "L'action n'a pas pu être lancée", quand: new Date(maintenant()).toISOString() });
        o.surChange?.();
      }
      return r;
    });
  };
  const prive = (f: IdFenetre) => espaceActifPrive(o.etat(), f);
  const refus = { ok: false as const, erreur: ACTIONS_EN_ESPACE_PRIVE };
  const lire = async (id: string) => {
    const c = o.chemins();
    return c ? lireAction(c, id) : null;
  };
  const nomDe = (a: ActionLue) => ("erreur" in a ? a.id : a.declaration.nom);
  /** Dernier lien ouvert depuis la page d'une action, par fenêtre : un par seconde au plus. */
  const dernierLien = new Map<IdFenetre, number>();
  return {
    async liste(f) {
      const c = o.chemins();
      if (prive(f) || !c) return [];
      return (await lireActionsAffichees(c, o.dossierActions)).map((a) => {
        const r = refusLancement.get(a.id);
        return r && (!a.dernier || a.dernier.debut < r.quand) ? { ...a, refus: r.erreur } : a;
      });
    },
    async ouvrir(f, id, saisie) {
      if (prive(f)) return refus;
      const noyau = o.noyau();
      if (!noyau) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      const a = await lire(id);
      if (!a) return { ok: false, erreur: ACTION_INCONNUE };
      // Relu après la lecture du disque : la fenêtre a pu passer dans un espace privé entre-temps.
      if (prive(f)) return refus;
      const d = noyau.actions.direct();
      const tourne = d.courantes.some((x) => x.action === id) || d.enAttente.some((x) => x.action === id);
      o.agir({ type: "ouvrirAction", fenetreId: f, id, nom: nomDe(a) });
      if (tourne) return { ok: true };
      // Saisie requise et absente : la page s'ouvre avec son champ à remplir, rien n'est lancé.
      if (!("erreur" in a) && a.declaration.saisie && !saisie?.trim()) return { ok: true };
      suivreLancement(id, noyau.actions.lancer(id, { ...(saisie?.trim() ? { saisie } : {}), declencheur: "manuelle" }).fin).catch((e) =>
        console.error(`[webaios] action ${id} :`, e),
      );
      return { ok: true };
    },
    async lancer(f, id, saisie) {
      if (prive(f)) return { statut: "invalide", erreur: ACTIONS_EN_ESPACE_PRIVE };
      const noyau = o.noyau();
      if (!noyau) return { statut: "invalide", erreur: MESSAGE_SANS_NOYAU };
      return suivreLancement(id, noyau.actions.lancer(id, { ...(saisie?.trim() ? { saisie } : {}), declencheur: "manuelle" }).fin);
    },
    arreter(f, id) {
      if (!prive(f)) o.noyau()?.actions.arreter(id);
    },
    async page(f, id, execution) {
      if (prive(f)) return null;
      return (await o.noyau()?.actions.page(id, execution)) ?? null;
    },
    async executions(f, id) {
      if (prive(f)) return [];
      const noyau = o.noyau();
      if (noyau) return noyau.actions.executions(id);
      return ID_ACTION.test(id) ? listerExecutions(join(o.dossierActions, id)) : [];
    },
    async execution(f, id, execution) {
      if (prive(f) || !ID_ACTION.test(id) || !ID_EXECUTION.test(execution)) return null;
      const noyau = o.noyau();
      return noyau ? noyau.actions.execution(id, execution) : lireExecution(join(o.dossierActions, id), execution);
    },
    async direct(f) {
      if (prive(f)) return AUCUNE_ACTION;
      return o.noyau()?.actions.direct() ?? AUCUNE_ACTION;
    },
    async ouvrirLien(f, id, execution, url) {
      if (prive(f)) return;
      // Une page qui ouvrirait des liens en rafale (pour faire sortir des données) : un par seconde au plus.
      if (maintenant() - (dernierLien.get(f) ?? -Infinity) < 1000) return console.warn("[webaios] lien d'action ignoré (trop rapproché) :", url);
      if (!(await lienPermis(o.dossierActions, id, execution, url))) return console.warn("[webaios] lien d'action refusé :", url);
      if (prive(f)) return;
      dernierLien.set(f, maintenant());
      o.agir({ type: "ouvrirOnglet", fenetreId: f, url, activer: true });
    },
    profilsPourAccord(f) {
      return prive(f) ? [] : profilsPourAccord(o.etat(), f);
    },
    async accorder(f, a) {
      if (prive(f)) return refus;
      const noyau = o.noyau();
      // Jamais un profil utilisé par un espace privé : l'état est relu au moment de l'accord.
      if (!noyau) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      if (!profilsLisibles(o.etat()).includes(a.profil)) return { ok: false, erreur: "Ce profil ne peut pas servir à un accord" };
      try {
        // Le noyau refuse si la déclaration n'est plus celle que la carte a montrée.
        await noyau.actions.accorder(a);
        return { ok: true };
      } catch (e) {
        return { ok: false, erreur: (e as Error).message };
      }
    },
    async refuserAccord(f, id) {
      if (prive(f)) return;
      const noyau = o.noyau();
      // Une exécution en cours garderait sa place dans la file et sa priorité sur l'IA jusqu'à sa fin.
      noyau?.actions.arreter(id);
      await noyau?.actions.refuserAccord(id);
    },
    async supprimer(f, id) {
      if (prive(f)) return refus;
      const c = o.chemins();
      if (!c) return { ok: false, erreur: MESSAGE_SANS_NOYAU };
      if (!(await lire(id))) return { ok: false, erreur: ACTION_INCONNUE };
      // Arrêtée d'abord : sinon elle tournerait jusqu'à sa durée maximale, sans que rien ne permette plus de l'arrêter.
      o.noyau()?.actions.arreter(id);
      refusLancement.delete(id);
      lancementsSuivis.delete(id);
      const oublier = async (x: string) => {
        const noyau = o.noyau();
        if (noyau) return noyau.actions.refuserAccord(x);
        await retirerAccord(o.dossierActions, x);
        await supprimerDonneesAction(o.dossierActions, x);
      };
      try {
        await retirerAction(c, id, oublier);
        return { ok: true };
      } catch (e) {
        console.error(`[webaios] action ${id} non supprimée :`, e);
        return { ok: false, erreur: "L'action n'a pas pu être supprimée" };
      }
    },
    async voirWorkflow(f, id) {
      if (prive(f)) return;
      const a = await lire(id);
      if (a && !prive(f)) o.agir({ type: "ouvrirWorkflow", fenetreId: f, id, nom: nomDe(a).slice(0, 60), proprietaire: "action" });
    },
  };
}
