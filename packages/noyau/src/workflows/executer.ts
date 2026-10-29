import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { DELAI_RECOLTE_S, type Atelier } from "../conteneur/atelier.js";
import { cheminOutils } from "../conteneur/executeur.js";
import type { IaLocale } from "../ia/ia-locale.js";
import { ProfilRefuse, type PontNavigateur } from "../mcp/pont.js";
import {
  MAX_LECTURES_OUVERTES,
  MAX_RECHERCHES,
  PLAFOND_RECHERCHES,
  RECHERCHE_INDISPONIBLE,
  RECHERCHES_ARRETEES,
  TROP_DE_LECTURES,
  adresseLocale,
  message,
  recuperer,
  tronquer,
  verifierPage,
  verifierUrl,
} from "./acces.js";
import { RECHERCHE_REFUSEE, RESULTATS_ILLISIBLES, URL_DUCKDUCKGO, extraireResultats, urlRecherche } from "./duckduckgo.js";
import { chaineAuFilDeLEau } from "./chaine.js";
import { Menagement } from "./menagement.js";
import { SORTIE_MAX_OCTETS, coupe, idExecution, type Execution, type TraceBloc } from "./executions.js";
import { MEMOIRE_MAX_OCTETS, empreinteParametres, type MemoireBlocs } from "./memoire.js";
import {
  ArgsChercherWeb,
  ArgsGemma,
  ArgsKev,
  ArgsLirePage,
  ArgsRecuperer,
  LIGNE_MAX_OCTETS,
  TAILLE_MAX_DONNEES,
  ligneDebut,
  ligneMemoire,
  ligneReponse,
  lireMessageRecolteur,
  type MessageRecolteur,
} from "./protocole.js";
import { REJEU_TROP_GROS } from "./rejeu.js";
import type { GenreSortie, Proprietaire } from "./schema.js";
import { WEB_REQUIS, type WorkflowValide } from "./valider.js";

/** Le processus de l'exécution (le client `docker run -i`) : son seul canal avec le noyau est stdin / stdout. */
export interface ProcessusRecolte {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  tuer(): void;
  /** Code de sortie ; null si tué par un signal ou impossible à lancer. */
  fin: Promise<number | null>;
}
export type LanceurProcessus = (cmd: string, args: string[]) => ProcessusRecolte;

export const lancerParDefaut: LanceurProcessus = (cmd, args) => {
  const enfant = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: cheminOutils() } });
  const fin = new Promise<number | null>((ok) => {
    enfant.once("close", (code) => ok(code));
    enfant.once("error", () => ok(null));
  });
  return { stdin: enfant.stdin, stdout: enfant.stdout, stderr: enfant.stderr, tuer: () => void enfant.kill("SIGKILL"), fin };
};

/** Délai côté noyau ; le conteneur s'arrête de lui-même après 180 s (+5 s). */
export const DELAI_EXECUTION_MS = 200_000;

// Recopiées dans l'interpréteur du conteneur (docker/moteur/interpreteur.mjs) : un test vérifie qu'elles s'accordent.
/** Écart entre deux publications au fil de l'eau. */
export const ECART_PUBLICATIONS_MS = 5000;
/** Écart entre deux envois de la mémoire en cours de route (exécution progressive). */
export const ECART_MEMOIRE_MS = 30_000;
/**
 * Une publication arrivée moins de 4 s après la précédente relayée est ignorée : le conteneur les espace de 5 s sur
 * son horloge, la marge couvre l'écart entre les deux horloges et le temps de transport.
 */
const ECART_PUBLICATIONS_TOLERE_MS = ECART_PUBLICATIONS_MS - 1000;

/**
 * Les délais d'une exécution. Sans `dureeMaxMinutes` : ceux d'aujourd'hui (conteneur 180 s, noyau 200 s, aucune limite
 * envoyée : l'interpréteur garde ses 150 s). Avec D minutes : plus aucun élément lancé après D × 60 s, conteneur arrêté
 * à D × 60 + 30 s, noyau à D × 60 + 50 s.
 */
export function delaisExecution(dureeMaxMinutes: number | undefined): { conteneurS: number; noyauMs: number; limiteMs?: number } {
  if (dureeMaxMinutes === undefined) return { conteneurS: DELAI_RECOLTE_S, noyauMs: DELAI_EXECUTION_MS };
  return { conteneurS: dureeMaxMinutes * 60 + 30, noyauMs: dureeMaxMinutes * 60_000 + 50_000, limiteMs: dureeMaxMinutes * 60_000 };
}

export const PROFIL_REFUSE =
  "Le profil de connexion choisi n'est plus utilisable (supprimé ou utilisé par un espace privé) : accord à redonner";

const MAX_APPELS_EN_VOL = 32;
/**
 * Plafonds effectifs du noyau : une erreur (d'exécution, de bloc, d'appel) à 500 caractères, le journal global à 2000.
 * Ceux du conteneur (2000 caractères par trace) et de l'écriture des exécutions (2 Ko par ligne) ne sont que des filets.
 */
export const JOURNAL_MAX = 2000;
export const ERREUR_MAX = 500;
/** Remarque du noyau quand la mémoire des blocs rendue est trop grosse pour son fichier. */
export const MEMOIRE_NON_GARDEE = "Mémoire des blocs non gardée : plus de 3 Mo (l'ancienne reste)";
const JOURNAL_BLOC_LIGNES = 200;
const JOURNAL_BLOC_CARACTERES = 500;

export interface ContexteWorkflow {
  proprietaire: Proprietaire;
  valide: WorkflowValide;
  /** Dossier des fichiers du propriétaire (`.mjs` des blocs `code`), monté en lecture seule sur `/widget`. */
  dossierFichiers: string;
  config: unknown;
  precedent: unknown;
  memoire: MemoireBlocs;
  /**
   * Domaines lus avec le compte de l'utilisateur, et domaines publics permis quand il y en a avec compte. `web` : recherches
   * web permises et lectures ouvertes ménagées (jamais avec un compte).
   */
  sources: { compte: readonly string[]; publiques: readonly string[]; web?: boolean };
  /** Relu à chaque lecture avec compte ; null = plus d'accord. */
  accord(): Promise<{ profil: string } | null>;
  /** Le navigateur refuse le profil de l'accord (supprimé, devenu privé). */
  surProfilRefuse(): Promise<void>;
  messageAccordRequis: string;
  declencheur: Execution["declencheur"];
  /**
   * Un essai du constructeur (plan de `planRejeu`) : seuls les blocs `relances` tournent, avec les `sorties` reprises
   * de l'exécution d'origine ; aucune mémoire envoyée ni gardée. `repris` : les blocs repris et leur nombre d'éléments.
   */
  rejeu?: { relances: string[]; sorties: Record<string, unknown>; repris: Record<string, number | null> };
  /** `recolte.dureeMaxMinutes` du widget : règle les délais et rend l'exécution progressive (hors essai). */
  dureeMaxMinutes?: number;
}

/** Une publication au fil de l'eau : les éléments déjà terminés, `faits` sur `total`. */
export type Publication = { donnees: unknown; faits: number; total: number };

/** Une trace acceptée (dans l'ordre), relayée en direct au constructeur. */
export type TraceDirecte =
  | { bloc: string; etape: "debut" }
  | { bloc: string; etape: "fin"; statut: "reussi" | "partiel" | "echoue"; elements: number | null };

export interface InfraWorkflow {
  /** Dossier du moteur sur le Mac (`docker/moteur`), monté en lecture seule. */
  moteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  /** null : pas d'IA locale, `kev` et `gemma` répondent une erreur. */
  ia: Pick<IaLocale, "kev" | "gemma"> | null;
  pont: PontNavigateur;
  horloge: () => Date;
  delaiMs?: number;
  /** Tests seulement : permet `recuperer` et `lirePage` vers des adresses locales (127.0.0.1…). */
  adressesLocales?: boolean;
  /** Ménagement des recherches et des lectures ouvertes (défaut : MENAGEMENT_PAR_DEFAUT, partagé). */
  menagement?: Menagement;
  /** Tests seulement : la base des recherches DuckDuckGo. */
  urlRecherche?: string;
  /** Appelé pour chaque trace acceptée (jamais pour une ligne rejetée) ; une erreur du relais est ignorée. */
  surTrace?: (t: TraceDirecte) => void;
  /**
   * Une publication de la chaîne au fil de l'eau (voir `executerWorkflow`). Les relais (publications et mémoire) sont
   * faits l'un après l'autre et tous finis avant que l'exécution rende ; une erreur d'un relais est ignorée.
   */
  surPublication?: (p: Publication) => Promise<void>;
  /** Exécution progressive seulement : la mémoire reçue en cours de route, au plus toutes les ECART_MEMOIRE_MS. */
  surMemoire?: (m: MemoireBlocs) => Promise<void>;
}

export type IssueWorkflow =
  | { t: "fin"; sortie: { vers: GenreSortie; valeur: unknown }; memoire: MemoireBlocs | null }
  /**
   * `erreurDuCode` : le texte vient du conteneur (le code de l'agent a pu l'écrire), pas du noyau. `memoire` (exécution
   * progressive seulement, absente sinon) : la dernière mémoire reçue, null si aucune.
   */
  | { t: "echec"; erreur: string; erreurDuCode: boolean; memoire?: MemoireBlocs | null }
  /** Arrêté par le noyau (délai, accord, profil refusé, réponse trop grande…) : le texte est du noyau. `memoire` : idem. */
  | { t: "arret"; statut: "erreur" | "accord-requis"; erreur: string; memoire?: MemoireBlocs | null };

function args<T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }, a: unknown, f: string): T {
  const r = schema.safeParse(a);
  if (!r.success) throw new Error(`Arguments invalides pour ${f}`);
  return r.data;
}

/** Le ménagement partagé par toutes les exécutions du noyau, quand l'appelant n'en donne pas. */
export const MENAGEMENT_PAR_DEFAUT = new Menagement();

type Arret = { statut: "erreur" | "accord-requis"; erreur: string };
/** L'exécution est arrêtée : l'appel ne reçoit aucune réponse. */
const SANS_REPONSE = Symbol("sans réponse");

/** Trace d'un bloc pendant l'exécution, avec ce qu'il faut pour borner son journal. */
type TraceEnCours = TraceBloc & { commence: boolean; fini: boolean; coupees: number };

/**
 * Exécute un workflow validé dans un conteneur sans réseau : envoie `debut` (workflow, config, précédent) et la
 * mémoire des blocs, répond aux appels (lirePage, recuperer, kev, gemma) avec les règles des sources et de l'accord,
 * range les traces des blocs. N'écrit rien : l'appelant décide de ce qui est gardé (vie privée).
 *
 * Exécution progressive (hors essai, avec `dureeMaxMinutes` ou une sortie au fil de l'eau) : la mémoire reçue en cours
 * de route est relayée (`surMemoire`) et la dernière revient avec un échec ou un arrêt. Une ligne `publication` n'est
 * relayée (`surPublication`) que pendant la chaîne au fil de l'eau (entre le dernier `debut` et la première `fin` de
 * ses blocs), au moins 4 s après la précédente relayée, avec `faits ≤ total` et des données de 2 Mo au plus : une
 * publication écrite par le code de l'agent hors de la chaîne, ou en retard, ne peut pas écraser la sortie finale.
 */
export async function executerWorkflow(
  ctx: ContexteWorkflow,
  infra: InfraWorkflow,
): Promise<{ issue: IssueWorkflow; execution: Execution; journal: string }> {
  const horloge = infra.horloge;
  const adressesLocales = infra.adressesLocales ?? false;
  const debut = horloge().toISOString();
  const { workflow, ordre } = ctx.valide;
  const rejeu = ctx.rejeu ?? null;
  // Pour un essai, seuls les blocs relancés envoient des traces, dans l'ordre d'exécution.
  const relances = rejeu ? new Set(rejeu.relances) : null;
  const attendu = relances ? ordre.filter((id) => relances.has(id)) : ordre;
  const types = new Map(workflow.blocs.map((b) => [b.id, b.type]));
  const auFilDeLEau = workflow.blocs.find((b) => b.id === ctx.valide.sortie.id)?.parametres.auFilDeLEau === true;
  const progressif = !rejeu && (ctx.dureeMaxMinutes !== undefined || auFilDeLEau);
  // Un essai n'a pas de chaîne : il tourne bloc par bloc et ne publie rien.
  const chaine = rejeu ? [] : chaineAuFilDeLEau(ctx.valide);
  const delais = delaisExecution(ctx.dureeMaxMinutes);
  // Les paramètres validés de cette exécution : la mémoire n'est reprise que si elle a été retenue avec les mêmes.
  const empreintes = new Map(workflow.blocs.map((b) => [b.id, empreinteParametres(b.parametres)]));
  const traces = new Map<string, TraceEnCours>(
    ordre.map((id) => [
      id,
      { id, type: types.get(id)!, statut: "pas-lance", debut: null, fin: null, elements: null, journal: [], commence: false, fini: false, coupees: 0 },
    ]),
  );
  if (rejeu) {
    for (const [id, elements] of Object.entries(rejeu.repris)) {
      const t = traces.get(id);
      if (t && !relances!.has(id)) Object.assign(t, { statut: "repris", elements });
    }
  }
  let journal = "";
  let remarque: string | null = null;

  const conclure = (issue: IssueWorkflow) => {
    const blocs: TraceBloc[] = [...traces.values()].map(({ commence, fini, coupees, ...t }) => {
      const b: TraceBloc = { ...t };
      // Commencé sans fin : le conteneur s'est arrêté pendant le bloc.
      if (commence && !fini) b.statut = "echoue";
      if (coupees > 0) b.journal = [`… ${coupees} lignes coupées`, ...t.journal];
      return b;
    });
    const statut: Execution["statut"] =
      issue.t === "fin"
        ? // Un bloc partiel, ou qui n'a pas fini (une `fin` arrivée avant lui) : la sortie n'est pas complète. Pour un
          // essai, seuls les blocs relancés comptent.
          blocs.every((b) => b.statut === "reussi" || (relances !== null && !relances.has(b.id))) ? "reussie" : "partielle"
        : issue.t === "arret" && issue.statut === "accord-requis" ? "accord-requis" : "echouee";
    const execution: Execution = {
      version: 1,
      id: idExecution(debut),
      proprietaire: ctx.proprietaire,
      declencheur: ctx.declencheur,
      debut,
      fin: horloge().toISOString(),
      statut,
      blocs,
    };
    if (issue.t !== "fin") {
      execution.erreur = issue.erreur;
      if (issue.t === "arret" || !issue.erreurDuCode) execution.erreurNoyau = true;
    }
    if (remarque) {
      journal = (journal ? journal + "\n" : "") + remarque;
      // Aussi dans l'exécution, au journal du bloc de sortie.
      blocs.find((b) => b.id === ctx.valide.sortie.id)?.journal.push(remarque);
    }
    return { issue, execution, journal: journal.slice(-JOURNAL_MAX) };
  };
  const echec = (erreur: string, erreurDuCode: boolean): IssueWorkflow => ({ t: "echec", erreur: tronquer(erreur, ERREUR_MAX), erreurDuCode });

  // Pour un propriétaire avec compte, les lectures publiques sont limitées aux domaines déclarés (vide : aucune).
  const aCompte = ctx.sources.compte.length > 0;
  const domainesPublics = aCompte ? ctx.sources.publiques : null;
  // Recherches web et lectures ouvertes ménagées : seulement pour un widget qui déclare `web`, jamais avec un compte.
  const web = ctx.sources.web === true && !aCompte;
  const menagement = infra.menagement ?? MENAGEMENT_PAR_DEFAUT;
  // Levé à l'arrêt ou à la fin : une recherche ou une lecture encore en file ne part pas.
  const finExecution = new AbortController();
  let recherches = 0;
  let rechercheRefusee = false;
  let lecturesOuvertes = 0;

  const debutLigne = ligneDebut({
    precedent: ctx.precedent,
    maintenant: debut,
    config: ctx.config ?? null,
    workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre },
    ...(rejeu ? { rejeu: { relances: rejeu.relances, sorties: rejeu.sorties } } : {}),
    ...(delais.limiteMs !== undefined ? { limiteMs: delais.limiteMs } : {}),
    ...(progressif ? { progressif: true as const } : {}),
  });
  // Filet : l'appelant mesure avant (`debutTropGros`) pour refuser sans rien écrire ; le récolteur refuserait la ligne.
  if (rejeu && Buffer.byteLength(debutLigne) > LIGNE_MAX_OCTETS) {
    return conclure({ t: "arret", statut: "erreur", erreur: REJEU_TROP_GROS });
  }

  let processus: ProcessusRecolte;
  try {
    const [cmd, ...argv] = infra.atelier.commandeRecolte(ctx.proprietaire.id, ctx.dossierFichiers, infra.moteur, delais.conteneurS);
    processus = (infra.lancer ?? lancerParDefaut)(cmd!, argv);
  } catch (e) {
    return conclure({ t: "arret", statut: "erreur", erreur: `Récolte impossible à lancer : ${message(e)}` });
  }

  let arret: Arret | null = null;
  let terminal: Extract<MessageRecolteur, { t: "fin" | "echec" }> | null = null;
  let memoireRecue: MemoireBlocs | null = null;
  let enVol = 0;
  // Relais vers l'appelant (publications, mémoire), l'un après l'autre ; tous attendus avant de rendre.
  let relais: Promise<void> = Promise.resolve();
  const enFile = (f: () => Promise<void>) => {
    relais = relais.then(f).catch(() => {});
  };
  let memoireRelayeeA: number | null = null;
  // Exécution progressive : le conteneur résout les clés des éléments qu'une publication va montrer, envoie `memoire`,
  // puis `publication`. Si le noyau rejette cette publication, ces éléments n'ont jamais été montrés : la mémoire doit
  // rester celle d'avant (R34). Une mémoire est donc tenue jusqu'à la ligne suivante :
  // - une publication acceptée la rend sûre ; rejetée, elle est écartée, et les mémoires suivantes aussi (elles
  //   retiennent encore ces clés) jusqu'à la prochaine publication acceptée, qui montre de nouveau tous les éléments ;
  // - une autre ligne (trace, appel, echec, fin…) la rend sûre : elle ne précédait pas de publication ;
  // - rien après (arrêt, conteneur tué) : écartée, elle précédait peut-être une publication jamais lue.
  // `memoireSure` est celle d'un échec ou d'un arrêt et des relais `surMemoire` ; une fin garde la dernière reçue
  // (`memoireRecue`), car la sortie montre tout.
  let memoireSure: MemoireBlocs | null = null;
  let memoireTenue: { memoire: MemoireBlocs | null; recueA: number } | null = null;
  let memoireDouteuse = false;
  // La trace `fin` du bloc de sortie est passée : une mémoire reçue ensuite (verifierMemoire, juste avant `fin`) a
  // résolu toutes les clés en suspens, que seule la sortie finale montre. Elle ne sert qu'à l'issue `fin`
  // (`memoireRecue`), jamais relayée ni sûre : si les données finales sont refusées, la mémoire sûre d'avant reste.
  let sortieFinie = false;
  // L'adoption se fait dans la file des relais, après les publications reçues avant elle : une mémoire n'est sûre que
  // si les données qu'elle suppose montrées ont bien été écrites (F1).
  const adopterDansLaFile = async (t: { memoire: MemoireBlocs | null; recueA: number }) => {
    if (!t.memoire || memoireDouteuse) return;
    const memoire = t.memoire;
    memoireSure = memoire;
    const surMemoire = infra.surMemoire;
    if (surMemoire && (memoireRelayeeA === null || t.recueA - memoireRelayeeA >= ECART_MEMOIRE_MS)) {
      memoireRelayeeA = t.recueA;
      await surMemoire(memoire);
    }
  };
  const adopterMemoire = (t: { memoire: MemoireBlocs | null; recueA: number }) => enFile(() => adopterDansLaFile(t));
  const libererMemoireTenue = () => {
    const t = memoireTenue;
    memoireTenue = null;
    if (t) adopterMemoire(t);
  };
  let publicationRelayeeA: number | null = null;
  const arreter = (a: Arret) => {
    if (arret) return;
    arret = a;
    finExecution.abort(new Error("Exécution arrêtée"));
    processus.tuer();
  };
  const minuteur = setTimeout(() => arreter({ statut: "erreur", erreur: "Délai dépassé" }), infra.delaiMs ?? delais.noyauMs);

  processus.stdin.on("error", () => {});
  processus.stdin.write(debutLigne);
  // Seulement la mémoire des blocs de ce workflow, avec leur type ; aucune pour un essai.
  processus.stdin.write(ligneMemoire(rejeu ? {} : reprendreMemoire(ctx.memoire, types, empreintes)));
  processus.stderr.setEncoding("utf8");
  processus.stderr.on("data", (d: string) => {
    journal = (journal + d).slice(-JOURNAL_MAX);
  });

  const repondre = (n: number, r: { ok: unknown } | { erreur: string }) => {
    if (arret || terminal || processus.stdin.destroyed || processus.stdin.writableEnded) return;
    let ligne = ligneReponse(n, r);
    if (Buffer.byteLength(ligne) > LIGNE_MAX_OCTETS) ligne = ligneReponse(n, { erreur: "Réponse trop grande (4 Mo maximum)" });
    processus.stdin.write(ligne);
  };

  /** Options de lecture : pour un propriétaire avec compte, le pont reçoit la liste des domaines où il peut naviguer. */
  // Tests seulement : le pont permet alors aussi les adresses locales (il les refuse sinon, redirections comprises).
  const avecDomaines = (profil: string | null, domaines: readonly string[] | null) => ({
    profil,
    ...(aCompte && domaines ? { domaines: [...domaines] } : {}),
    ...(adressesLocales ? { adressesLocales: true } : {}),
  });

  /**
   * Une lecture ouverte (page sans compte, récupération, flux) : pour un widget `web`, comptée (100 par exécution) et
   * ménagée par hôte ; sinon, faite tout de suite comme avant.
   */
  const lectureOuverte = <T>(u: URL, f: () => Promise<T>): Promise<T> => {
    if (!web) return f();
    if (lecturesOuvertes >= MAX_LECTURES_OUVERTES) throw new Error(TROP_DE_LECTURES);
    lecturesOuvertes++;
    return menagement.lire(u.hostname, f, finExecution.signal);
  };

  const lirePage = async (a: unknown): Promise<unknown> => {
    const { url, compte } = args(ArgsLirePage, a, "lirePage");
    const lire = infra.pont.lirePageInvisible?.bind(infra.pont);
    if (!lire) throw new Error("Lecture de pages indisponible");
    if (!compte) {
      const u = verifierUrl(url, domainesPublics, adressesLocales);
      const page = await lectureOuverte(u, () => lire(u.href, avecDomaines(null, domainesPublics)));
      return verifierPage(page, domainesPublics, adressesLocales);
    }
    // Le domaine doit être déclaré en `compte` ; l'accord est relu à chaque lecture (il a pu être retiré).
    const u = verifierUrl(url, ctx.sources.compte, adressesLocales);
    const accord = await ctx.accord();
    if (!accord) {
      arreter({ statut: "accord-requis", erreur: ctx.messageAccordRequis });
      return SANS_REPONSE;
    }
    if (arret) return SANS_REPONSE;
    try {
      const page = await lire(u.href, avecDomaines(accord.profil, ctx.sources.compte));
      return verifierPage(page, ctx.sources.compte, adressesLocales);
    } catch (e) {
      if (e instanceof ProfilRefuse || (e as Error)?.name === "ProfilRefuse") {
        // L'appelant retire l'accord (et ce qui a été lu avec) avant l'arrêt : quand il conclut, il n'existe plus.
        try {
          await ctx.surProfilRefuse();
        } finally {
          arreter({ statut: "accord-requis", erreur: PROFIL_REFUSE });
        }
        return SANS_REPONSE;
      }
      throw e;
    }
  };

  const chercherWeb = async (a: unknown): Promise<unknown> => {
    const { requete, nombre } = args(ArgsChercherWeb, a, "chercherWeb");
    // Refusé ici même si la validation l'a laissé passer : un bloc `code` ou un recolte.mjs peut appeler chercherWeb.
    if (!web) throw new Error(WEB_REQUIS);
    if (rechercheRefusee) throw new Error(RECHERCHES_ARRETEES);
    if (recherches >= MAX_RECHERCHES) throw new Error(PLAFOND_RECHERCHES);
    const lireHtml = infra.pont.lireHtmlInvisible?.bind(infra.pont);
    if (!lireHtml) throw new Error(RECHERCHE_INDISPONIBLE);
    recherches++;
    const { html } = await menagement.rechercher(() => {
      // Un refus arrivé pendant l'attente : celle-ci ne part pas.
      if (rechercheRefusee) throw new Error(RECHERCHES_ARRETEES);
      return lireHtml(urlRecherche(requete, infra.urlRecherche ?? URL_DUCKDUCKGO), adressesLocales ? { adressesLocales: true } : {});
    }, finExecution.signal);
    const r = extraireResultats(html, Infinity);
    if ("refus" in r) {
      rechercheRefusee = true;
      throw new Error(RECHERCHE_REFUSEE);
    }
    if ("illisible" in r) throw new Error(RESULTATS_ILLISIBLES);
    // Un résultat vers la machine ou le réseau local n'est jamais rendu (il serait lu ensuite).
    return r.resultats.filter((x) => !adresseLocale(new URL(x.url).hostname)).slice(0, nombre);
  };

  const traiterAppel = async (f: string, a: unknown): Promise<unknown> => {
    switch (f) {
      case "lirePage":
        return lirePage(a);
      case "recuperer": {
        const { url, format } = args(ArgsRecuperer, a, "recuperer");
        if (!web) return recuperer(url, format ?? "texte", domainesPublics, adressesLocales);
        const u = verifierUrl(url, domainesPublics, adressesLocales);
        return lectureOuverte(u, () => recuperer(u.href, format ?? "texte", domainesPublics, adressesLocales));
      }
      case "chercherWeb":
        return chercherWeb(a);
      case "kev": {
        const corps = args(ArgsKev, a, "kev");
        if (!infra.ia) throw new Error("IA locale indisponible");
        return infra.ia.kev(corps);
      }
      case "gemma": {
        const g = args(ArgsGemma, a, "gemma");
        if (!infra.ia) throw new Error("IA locale indisponible");
        return infra.ia.gemma(g);
      }
      default:
        throw new Error(`Fonction inconnue : ${f}`);
    }
  };

  // Les traces viennent du conteneur, où tourne le code de l'agent : il peut en écrire de fausses sur stdout. Seules
  // comptent celles des blocs de ce workflow, dans l'ordre d'exécution (un bloc à la fois), au format du protocole.
  // Pour un essai, seuls les blocs relancés : une ligne pour un bloc repris ou non relancé est rejetée. Seule exception :
  // la chaîne au fil de l'eau, dont les blocs commencent tous à la suite puis finissent dans l'ordre.
  let suivant = 0;
  /** Blocs commencés et pas encore finis, dans l'ordre : un seul, ou les blocs de la chaîne. */
  const ouverts: TraceEnCours[] = [];
  /** Une fin de la chaîne est arrivée : plus aucun début accepté avant que ses blocs aient tous fini. */
  let fermeture = false;
  /** Entre le dernier `debut` et la première `fin` de la chaîne : le seul moment où une publication compte. */
  const pendantLaChaine = () => chaine.length > 0 && !fermeture && ouverts.length === chaine.length && ouverts[0]!.id === chaine[0];
  const relayer = (t: TraceDirecte) => {
    try {
      infra.surTrace?.(t);
    } catch {
      // Le relais en direct n'arrête jamais l'exécution.
    }
  };
  const traiterTrace = (m: Exclude<MessageRecolteur, { t: "appel" | "fin" | "echec" }>) => {
    if (m.t === "memoire") {
      // Un essai ne garde aucune mémoire : ce que le conteneur en dit est ignoré.
      if (rejeu) return;
      const filtree = marquerMemoire(m.memoire as MemoireBlocs, types, empreintes);
      const tropGrosse = Buffer.byteLength(JSON.stringify({ version: 1, blocs: filtree })) > MEMOIRE_MAX_OCTETS;
      memoireRecue = tropGrosse ? null : filtree;
      remarque = tropGrosse ? MEMOIRE_NON_GARDEE : null;
      if (progressif && !sortieFinie) memoireTenue = { memoire: tropGrosse ? null : filtree, recueA: horloge().getTime() };
      return;
    }
    if (m.t === "publication") {
      const tenue = memoireTenue;
      memoireTenue = null;
      const maintenant = horloge().getTime();
      const surPublication = infra.surPublication;
      const acceptee =
        pendantLaChaine() &&
        m.faits <= m.total &&
        m.donnees !== undefined &&
        (publicationRelayeeA === null || maintenant - publicationRelayeeA >= ECART_PUBLICATIONS_TOLERE_MS) &&
        Buffer.byteLength(JSON.stringify(m.donnees)) <= TAILLE_MAX_DONNEES &&
        surPublication !== undefined;
      if (!acceptee) {
        // Le conteneur croit ces éléments montrés : sa mémoire n'est plus sûre avant la prochaine publication acceptée.
        if (progressif && (tenue || pendantLaChaine())) {
          enFile(async () => {
            memoireDouteuse = true;
          });
        }
        return;
      }
      publicationRelayeeA = maintenant;
      const p: Publication = { donnees: m.donnees, faits: m.faits, total: m.total };
      // Les données d'abord, puis la mémoire qu'elles rendent sûre ; une écriture refusée la laisse douteuse.
      enFile(async () => {
        try {
          await surPublication!(p);
        } catch {
          memoireDouteuse = true;
          return;
        }
        memoireDouteuse = false;
        if (tenue) await adopterDansLaFile(tenue);
      });
      return;
    }
    if (m.t === "journal") {
      const t = traces.get(m.bloc);
      if (!t || (relances && !relances.has(m.bloc))) return;
      t.journal.push(tronquer(m.texte, JOURNAL_BLOC_CARACTERES));
      // La place de la ligne « … N lignes coupées » est gardée : 200 lignes au plus en tout.
      while (t.journal.length + (t.coupees > 0 ? 1 : 0) > JOURNAL_BLOC_LIGNES) {
        t.journal.shift();
        t.coupees++;
      }
      return;
    }
    const t = traces.get(m.id);
    if (!t) return;
    if (m.etape === "debut") {
      if (attendu[suivant] !== m.id) return;
      // Un bloc déjà ouvert : seul le bloc suivant de la chaîne peut commencer, avant toute fin.
      if (ouverts.length > 0 && (fermeture || ouverts[0]!.id !== chaine[0] || chaine[ouverts.length] !== m.id)) return;
      suivant++;
      t.commence = true;
      t.debut = horloge().toISOString();
      ouverts.push(t);
      relayer({ bloc: m.id, etape: "debut" });
      return;
    }
    if (ouverts[0] !== t) return;
    ouverts.shift();
    fermeture = ouverts.length > 0;
    t.fini = true;
    if (t.id === ctx.valide.sortie.id) sortieFinie = true;
    t.fin = horloge().toISOString();
    t.statut = m.statut;
    if (m.erreur !== undefined) t.erreur = tronquer(m.erreur, ERREUR_MAX);
    if (m.sortieTropGrosse) t.sortieTronquee = true;
    else if (m.sortie !== undefined) {
      t.elements = Array.isArray(m.sortie) ? m.sortie.length : null;
      // Le noyau ne garde jamais plus de 256 Ko de la sortie d'un bloc : au-delà, le début de son JSON, marqué.
      const texte = JSON.stringify(m.sortie);
      if (Buffer.byteLength(texte) > SORTIE_MAX_OCTETS) {
        t.sortie = coupe(texte, SORTIE_MAX_OCTETS);
        t.sortieTronquee = true;
      } else t.sortie = m.sortie;
    }
    relayer({ bloc: m.id, etape: "fin", statut: m.statut, elements: t.elements });
  };

  const traiterLigne = (ligne: string) => {
    if (arret || terminal || !ligne.trim()) return;
    const m = lireMessageRecolteur(ligne);
    if (!m) return; // Une ligne hors protocole (le code a écrit sur stdout) est ignorée.
    // Une mémoire tenue que ne suit pas une publication : elle ne retient que des éléments déjà montrés. Suivie de
    // `fin`, elle ne sert qu'à l'issue `fin` : la sortie finale, pas encore écrite, peut encore être refusée.
    if (m.t === "fin") memoireTenue = null;
    else if (m.t !== "publication") libererMemoireTenue();
    if (m.t === "fin" || m.t === "echec") {
      terminal = m;
      processus.stdin.end();
      return;
    }
    if (m.t !== "appel") return traiterTrace(m);
    if (enVol >= MAX_APPELS_EN_VOL) return repondre(m.n, { erreur: "Trop d'appels en même temps" });
    enVol++;
    // Les appels sont traités dès leur arrivée, en parallèle ; chaque réponse porte le numéro de son appel.
    traiterAppel(m.f, m.a)
      .then(
        (ok) => ok !== SANS_REPONSE && repondre(m.n, { ok: ok ?? null }),
        (e) => repondre(m.n, { erreur: tronquer(message(e), ERREUR_MAX) }),
      )
      .finally(() => enVol--);
  };

  // Lecture ligne à ligne ; une ligne de plus de 4 Mo arrête l'exécution avant d'être accumulée en entier.
  let tampon: Buffer[] = [];
  let taille = 0;
  processus.stdout.on("data", (d: Buffer) => {
    if (arret) return;
    let debutLigne = 0;
    for (let i = d.indexOf(10); i >= 0; i = d.indexOf(10, debutLigne)) {
      const morceau = d.subarray(debutLigne, i);
      if (taille + morceau.length > LIGNE_MAX_OCTETS) return arreter({ statut: "erreur", erreur: "Réponse trop grande" });
      const ligne = Buffer.concat([...tampon, morceau]).toString("utf8");
      tampon = [];
      taille = 0;
      debutLigne = i + 1;
      traiterLigne(ligne);
      if (arret) return;
    }
    const reste = d.subarray(debutLigne);
    if (!reste.length) return;
    taille += reste.length;
    if (taille > LIGNE_MAX_OCTETS) return arreter({ statut: "erreur", erreur: "Réponse trop grande" });
    tampon.push(Buffer.from(reste));
  });

  const code = await processus.fin;
  clearTimeout(minuteur);
  finExecution.abort(new Error("Exécution finie"));
  // La sortie finale est écrite après la dernière publication.
  await relais;
  // Exécution progressive : la dernière mémoire reçue revient avec un échec ou un arrêt.
  const avecMemoire = <T extends IssueWorkflow>(issue: T): T => (progressif ? { ...issue, memoire: memoireSure } : issue);
  const fin = terminal as MessageRecolteur | null;
  const arretFinal = arret as Arret | null;
  if (arretFinal) {
    // Tuer le client docker laisse le conteneur tourner : on le supprime.
    await infra.atelier.supprimerRecolte(ctx.proprietaire.id).catch(() => {});
    return conclure(avecMemoire({ t: "arret", ...arretFinal }));
  }
  if (fin?.t === "fin" && code === 0) {
    return conclure({ t: "fin", sortie: { vers: ctx.valide.sortie.vers, valeur: fin.donnees }, memoire: memoireRecue });
  }
  if (fin?.t === "echec") return conclure(avecMemoire(echec(fin.erreur, true)));
  if (code === 124) return conclure(avecMemoire(echec("Délai dépassé", false)));
  // Le code de sortie est choisi par le code de l'agent : il pourrait y coder des données du compte.
  return conclure(avecMemoire(echec(`La récolte s'est arrêtée sans résultat (code ${code ?? "aucun"})`, true)));
}

/** Ce qui est envoyé au conteneur : les entrées de même type et, si elles en ont une, de même empreinte. Sans l'empreinte. */
function reprendreMemoire(memoire: MemoireBlocs, types: Map<string, string>, empreintes: Map<string, string>): MemoireBlocs {
  const r: MemoireBlocs = {};
  for (const [id, e] of Object.entries(memoire)) {
    if (types.get(id) !== e?.type) continue;
    if (e.empreinte !== undefined && e.empreinte !== empreintes.get(id)) continue;
    r[id] = { type: e.type, valeur: e.valeur };
  }
  return r;
}

/** La mémoire rendue par le conteneur : les entrées de ce workflow, marquées de l'empreinte de cette exécution. */
function marquerMemoire(memoire: MemoireBlocs, types: Map<string, string>, empreintes: Map<string, string>): MemoireBlocs {
  const r: MemoireBlocs = {};
  for (const [id, e] of Object.entries(memoire)) {
    if (types.get(id) === e?.type) r[id] = { type: e.type, valeur: e.valeur, empreinte: empreintes.get(id)! };
  }
  return r;
}
