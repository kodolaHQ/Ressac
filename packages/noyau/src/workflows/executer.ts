import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Atelier } from "../conteneur/atelier.js";
import { cheminOutils } from "../conteneur/executeur.js";
import type { IaLocale } from "../ia/ia-locale.js";
import { ProfilRefuse, type PontNavigateur } from "../mcp/pont.js";
import { recuperer, verifierPage, verifierUrl } from "./acces.js";
import { SORTIE_MAX_OCTETS, coupe, idExecution, type Execution, type TraceBloc } from "./executions.js";
import { MEMOIRE_MAX_OCTETS, type MemoireBlocs } from "./memoire.js";
import {
  ArgsGemma,
  ArgsKev,
  ArgsLirePage,
  ArgsRecuperer,
  LIGNE_MAX_OCTETS,
  ligneDebut,
  ligneMemoire,
  ligneReponse,
  lireMessageRecolteur,
  type MessageRecolteur,
} from "./protocole.js";
import type { GenreSortie, Proprietaire } from "./schema.js";
import type { WorkflowValide } from "./valider.js";

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
export const PROFIL_REFUSE =
  "Le profil de connexion choisi n'est plus utilisable (supprimé ou utilisé par un espace privé) : accord à redonner";

const MAX_APPELS_EN_VOL = 32;
const JOURNAL_MAX = 2000;
const ERREUR_MAX = 500;
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
  /** Domaines lus avec le compte de l'utilisateur, et domaines publics permis quand il y en a avec compte. */
  sources: { compte: readonly string[]; publiques: readonly string[] };
  /** Relu à chaque lecture avec compte ; null = plus d'accord. */
  accord(): Promise<{ profil: string } | null>;
  /** Le navigateur refuse le profil de l'accord (supprimé, devenu privé). */
  surProfilRefuse(): Promise<void>;
  messageAccordRequis: string;
  declencheur: Execution["declencheur"];
}

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
}

export type IssueWorkflow =
  | { t: "fin"; sortie: { vers: GenreSortie; valeur: unknown }; memoire: MemoireBlocs | null }
  /** `erreurDuCode` : le texte vient du conteneur (le code de l'agent a pu l'écrire), pas du noyau. */
  | { t: "echec"; erreur: string; erreurDuCode: boolean }
  /** Arrêté par le noyau (délai, accord, profil refusé, réponse trop grande…) : le texte est du noyau. */
  | { t: "arret"; statut: "erreur" | "accord-requis"; erreur: string };

const tronquer = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function args<T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }, a: unknown, f: string): T {
  const r = schema.safeParse(a);
  if (!r.success) throw new Error(`Arguments invalides pour ${f}`);
  return r.data;
}

type Arret = { statut: "erreur" | "accord-requis"; erreur: string };
/** L'exécution est arrêtée : l'appel ne reçoit aucune réponse. */
const SANS_REPONSE = Symbol("sans réponse");

/** Trace d'un bloc pendant l'exécution, avec ce qu'il faut pour borner son journal. */
type TraceEnCours = TraceBloc & { commence: boolean; fini: boolean; coupees: number };

/**
 * Exécute un workflow validé dans un conteneur sans réseau : envoie `debut` (workflow, config, précédent) et la
 * mémoire des blocs, répond aux appels (lirePage, recuperer, kev, gemma) avec les règles des sources et de l'accord,
 * range les traces des blocs. N'écrit rien : l'appelant décide de ce qui est gardé (vie privée).
 */
export async function executerWorkflow(
  ctx: ContexteWorkflow,
  infra: InfraWorkflow,
): Promise<{ issue: IssueWorkflow; execution: Execution; journal: string }> {
  const horloge = infra.horloge;
  const adressesLocales = infra.adressesLocales ?? false;
  const debut = horloge().toISOString();
  const { workflow, ordre } = ctx.valide;
  const types = new Map(workflow.blocs.map((b) => [b.id, b.type]));
  const traces = new Map<string, TraceEnCours>(
    ordre.map((id) => [
      id,
      { id, type: types.get(id)!, statut: "pas-lance", debut: null, fin: null, elements: null, journal: [], commence: false, fini: false, coupees: 0 },
    ]),
  );
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
        ? // Un bloc partiel, ou qui n'a pas fini (une `fin` arrivée avant lui) : la sortie n'est pas complète.
          blocs.every((b) => b.statut === "reussi") ? "reussie" : "partielle"
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
    if (remarque) journal = (journal ? journal + "\n" : "") + remarque;
    return { issue, execution, journal: journal.slice(-JOURNAL_MAX) };
  };
  const echec = (erreur: string, erreurDuCode: boolean): IssueWorkflow => ({ t: "echec", erreur: tronquer(erreur, ERREUR_MAX), erreurDuCode });

  // Pour un propriétaire avec compte, les lectures publiques sont limitées aux domaines déclarés (vide : aucune).
  const aCompte = ctx.sources.compte.length > 0;
  const domainesPublics = aCompte ? ctx.sources.publiques : null;

  let processus: ProcessusRecolte;
  try {
    const [cmd, ...argv] = infra.atelier.commandeRecolte(ctx.proprietaire.id, ctx.dossierFichiers, infra.moteur);
    processus = (infra.lancer ?? lancerParDefaut)(cmd!, argv);
  } catch (e) {
    return conclure({ t: "arret", statut: "erreur", erreur: `Récolte impossible à lancer : ${message(e)}` });
  }

  let arret: Arret | null = null;
  let terminal: Extract<MessageRecolteur, { t: "fin" | "echec" }> | null = null;
  let memoireRecue: MemoireBlocs | null = null;
  let enVol = 0;
  const arreter = (a: Arret) => {
    if (arret) return;
    arret = a;
    processus.tuer();
  };
  const minuteur = setTimeout(() => arreter({ statut: "erreur", erreur: "Délai dépassé" }), infra.delaiMs ?? DELAI_EXECUTION_MS);

  processus.stdin.on("error", () => {});
  processus.stdin.write(
    ligneDebut({
      precedent: ctx.precedent,
      maintenant: debut,
      config: ctx.config ?? null,
      workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre },
    }),
  );
  // Seulement la mémoire des blocs de ce workflow, avec leur type.
  processus.stdin.write(ligneMemoire(memoireDuWorkflow(ctx.memoire, types)));
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

  const lirePage = async (a: unknown): Promise<unknown> => {
    const { url, compte } = args(ArgsLirePage, a, "lirePage");
    const lire = infra.pont.lirePageInvisible?.bind(infra.pont);
    if (!lire) throw new Error("Lecture de pages indisponible");
    if (!compte) {
      const page = await lire(verifierUrl(url, domainesPublics, adressesLocales).href, avecDomaines(null, domainesPublics));
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

  const traiterAppel = async (f: string, a: unknown): Promise<unknown> => {
    switch (f) {
      case "lirePage":
        return lirePage(a);
      case "recuperer": {
        const { url, format } = args(ArgsRecuperer, a, "recuperer");
        return recuperer(url, format ?? "texte", domainesPublics, adressesLocales);
      }
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
  let suivant = 0;
  let enCours: TraceEnCours | null = null;
  const traiterTrace = (m: Exclude<MessageRecolteur, { t: "appel" | "fin" | "echec" }>) => {
    if (m.t === "memoire") {
      const filtree = memoireDuWorkflow(m.memoire as MemoireBlocs, types);
      if (Buffer.byteLength(JSON.stringify({ version: 1, blocs: filtree })) > MEMOIRE_MAX_OCTETS) {
        memoireRecue = null;
        remarque = "Mémoire des blocs non gardée : plus de 3 Mo (l'ancienne reste)";
      } else {
        memoireRecue = filtree;
        remarque = null;
      }
      return;
    }
    if (m.t === "journal") {
      const t = traces.get(m.bloc);
      if (!t) return;
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
      if (enCours || ordre[suivant] !== m.id) return;
      suivant++;
      t.commence = true;
      t.debut = horloge().toISOString();
      enCours = t;
      return;
    }
    if (enCours !== t) return;
    enCours = null;
    t.fini = true;
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
  };

  const traiterLigne = (ligne: string) => {
    if (arret || terminal || !ligne.trim()) return;
    const m = lireMessageRecolteur(ligne);
    if (!m) return; // Une ligne hors protocole (le code a écrit sur stdout) est ignorée.
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
  const fin = terminal as MessageRecolteur | null;
  const arretFinal = arret as Arret | null;
  if (arretFinal) {
    // Tuer le client docker laisse le conteneur tourner : on le supprime.
    await infra.atelier.supprimerRecolte(ctx.proprietaire.id).catch(() => {});
    return conclure({ t: "arret", ...arretFinal });
  }
  if (fin?.t === "fin" && code === 0) {
    return conclure({ t: "fin", sortie: { vers: ctx.valide.sortie.vers, valeur: fin.donnees }, memoire: memoireRecue });
  }
  if (fin?.t === "echec") return conclure(echec(fin.erreur, true));
  if (code === 124) return conclure(echec("Délai dépassé", false));
  // Le code de sortie est choisi par le code de l'agent : il pourrait y coder des données du compte.
  return conclure(echec(`La récolte s'est arrêtée sans résultat (code ${code ?? "aucun"})`, true));
}

/** Les entrées d'une mémoire qui sont à un bloc de ce workflow, avec son type. */
function memoireDuWorkflow(memoire: MemoireBlocs, types: Map<string, string>): MemoireBlocs {
  const r: MemoireBlocs = {};
  for (const [id, e] of Object.entries(memoire)) if (types.get(id) === e?.type) r[id] = { type: e.type, valeur: e.valeur };
  return r;
}
