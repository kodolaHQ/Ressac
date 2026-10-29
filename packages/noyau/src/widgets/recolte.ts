import { dirname } from "node:path";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget, supprimerDonnees } from "../accueil/donnees.js";
import type { DeclarationWidget, EtatWidget, WidgetLu } from "../accueil/schemas.js";
import type { Atelier } from "../conteneur/atelier.js";
import type { IaLocale } from "../ia/ia-locale.js";
import { ProfilRefuse, type PontNavigateur } from "../mcp/pont.js";
import { accordValide, lireAccords, retirerAccord } from "./accords.js";
import { recuperer, verifierPage, verifierUrl } from "../workflows/acces.js";
import { DELAI_EXECUTION_MS, PROFIL_REFUSE, lancerParDefaut, type LanceurProcessus, type ProcessusRecolte } from "../workflows/executer.js";
import {
  ArgsGemma,
  ArgsKev,
  ArgsLirePage,
  ArgsRecuperer,
  LIGNE_MAX_OCTETS,
  ligneDebut,
  ligneReponse,
  lireMessageRecolteur,
  type MessageRecolteur,
} from "../workflows/protocole.js";

// Déplacés dans le moteur des workflows ; réexportés pour les modules et tests qui les prennent ici.
export { adresseLocale } from "../workflows/acces.js";
export { PROFIL_REFUSE, lancerParDefaut, type LanceurProcessus, type ProcessusRecolte } from "../workflows/executer.js";

export interface OptionsRecolte {
  id: string;
  widget: WidgetLu;
  dossierWidgets: string;
  /** Chemin du récolteur sur le Mac, monté en lecture seule dans le conteneur. */
  recolteur: string;
  atelier: Pick<Atelier, "commandeRecolte" | "supprimerRecolte">;
  lancer?: LanceurProcessus;
  /** null : pas d'IA locale, `kev` et `gemma` répondent une erreur. */
  ia: Pick<IaLocale, "kev" | "gemma"> | null;
  pont: PontNavigateur;
  horloge?: () => Date;
  /** Délai côté noyau ; le conteneur s'arrête de lui-même après 180 s (+5 s). */
  delaiMs?: number;
  /** Appelé après chaque écriture de l'état ou des données du widget (rafraîchir l'affichage). */
  surChange?: () => void;
  /** Tests seulement : permet `recuperer` et `lirePage` vers des adresses locales (127.0.0.1…). */
  adressesLocales?: boolean;
}

export const DELAI_RECOLTE_MS = DELAI_EXECUTION_MS;
const MAX_APPELS_EN_VOL = 32;
const JOURNAL_MAX = 2000;
const ERREUR_MAX = 500;
const ID = /^[a-z0-9-]+$/;

export const accordRequis = (d: DeclarationWidget) => `Accord requis pour lire avec ton compte : ${d.sources.compte.join(", ")}`;
export const ERREUR_ATELIER_ARRETE = "Mise à jour impossible : atelier arrêté";
export const ERREUR_RECOLTE_INTERNE = "Mise à jour impossible : erreur interne du navigateur";

/** Messages d'erreur fixes écrits par le noyau ; tout autre texte d'erreur a pu être écrit par le widget. */
const ERREURS_FIXES = new Set([
  "Délai dépassé",
  "Réponse trop grande",
  PROFIL_REFUSE,
  ERREUR_ATELIER_ARRETE,
  ERREUR_RECOLTE_INTERNE,
  "Ce widget n'a pas de recolte.mjs",
  "Données trop grosses (2 Mo au plus)",
]);
const ERREURS_MOTIFS = [
  // Les domaines déclarés n'ont que [a-z0-9.-] ; le message a pu être tronqué (« … »).
  /^Accord requis pour lire avec ton compte : [a-z0-9., -]*…?$/,
];

/**
 * L'erreur vient-elle du noyau, sans rien que le widget ait pu écrire ? Pour un widget qui lit avec le compte de l'utilisateur,
 * seule une telle erreur est montrée à l'agent sans accord (un widget peut lever une erreur faite de ses données).
 */
export function erreurDuNoyau(erreur: string): boolean {
  return ERREURS_FIXES.has(erreur) || ERREURS_MOTIFS.some((m) => m.test(erreur));
}

const tronquer = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function args<T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false } }, a: unknown, f: string): T {
  const r = schema.safeParse(a);
  if (!r.success) throw new Error(`Arguments invalides pour ${f}`);
  return r.data;
}

type Arret = { statut: "erreur" | "accord-requis"; erreur: string };
/** La récolte est arrêtée : l'appel ne reçoit aucune réponse. */
const SANS_REPONSE = Symbol("sans réponse");

/**
 * Exécute une récolte dans un conteneur sans réseau et répond à ses appels (lirePage, recuperer, kev, gemma) en
 * appliquant les règles de la déclaration et des accords. Écrit `etat.json` (en-cours au début) puis, en cas de
 * réussite, `donnees.json` ; les données précédentes sont gardées en cas d'échec.
 */
export async function executerRecolte(o: OptionsRecolte): Promise<{ etat: EtatWidget; donnees?: unknown }> {
  const { id, widget, dossierWidgets } = o;
  if (!ID.test(id) || widget.id !== id) throw new Error(`id de widget invalide : ${id}`);
  const horloge = o.horloge ?? (() => new Date());
  const adressesLocales = o.adressesLocales ?? false;
  const precedent = await lireEtatWidget(dossierWidgets, id);
  const debut = horloge().toISOString();
  await ecrireEtatWidget(dossierWidgets, id, { statut: "en-cours", derniereMaj: precedent.derniereMaj, derniereTentative: debut });
  o.surChange?.();

  /** `erreurWidget` : le texte de l'erreur vient du widget ou du conteneur (sinon, il est écrit par le noyau). */
  const conclure = async (r: { statut: EtatWidget["statut"]; erreur?: string; erreurWidget?: boolean; journal?: string; donnees?: unknown }) => {
    const etat: EtatWidget = {
      statut: r.statut,
      derniereMaj: r.statut === "ok" ? horloge().toISOString() : precedent.derniereMaj,
      derniereTentative: debut,
    };
    if (r.erreur) {
      etat.erreur = tronquer(r.erreur, ERREUR_MAX);
      if (!r.erreurWidget) etat.erreurNoyau = true;
    }
    if (r.journal) etat.journal = r.journal;
    await ecrireEtatWidget(dossierWidgets, id, etat);
    o.surChange?.();
    return r.statut === "ok" ? { etat, donnees: r.donnees } : { etat };
  };

  // L'erreur de lecture du widget peut citer ses fichiers : elle compte comme écrite par le widget.
  if ("erreur" in widget) return conclure({ statut: "erreur", erreur: widget.erreur, erreurWidget: true });
  if (!widget.aRecolte) return conclure({ statut: "erreur", erreur: "Ce widget n'a pas de recolte.mjs" });
  const declaration = widget.declaration;
  const aCompte = declaration.sources.compte.length > 0;
  // Un accord qui ne vaut plus pour la déclaration actuelle (domaines changés, compte retiré) est retiré, et les données
  // lues avec lui effacées : elles ne passent ni à la récolte suivante (precedent) ni, plus tard, à l'agent.
  const accordEnregistre = (await lireAccords(dossierWidgets))[id];
  if (accordEnregistre && !accordValide(declaration, accordEnregistre)) {
    await retirerAccord(dossierWidgets, id);
    await supprimerDonnees(dossierWidgets, id);
  }
  // Un widget qui lit avec le compte de l'utilisateur ne tourne qu'avec son accord, qui couvre aussi ses domaines publics.
  if (aCompte && !accordValide(declaration, (await lireAccords(dossierWidgets))[id])) {
    return conclure({ statut: "accord-requis", erreur: accordRequis(declaration) });
  }
  // Pour un widget avec compte, les lectures publiques sont limitées aux domaines déclarés (vide : aucune).
  const domainesPublics = aCompte ? declaration.sources.publiques : null;

  const accordToujoursValide = async () => accordValide(declaration, (await lireAccords(dossierWidgets))[id]);
  const refuseeEnCours = async () => {
    await supprimerDonnees(dossierWidgets, id);
    return conclure({ statut: "accord-requis", erreur: accordRequis(declaration) });
  };

  const donneesPrecedentes = await lireDonnees(dossierWidgets, id);
  let processus: ProcessusRecolte;
  try {
    const [cmd, ...argv] = o.atelier.commandeRecolte(id, widget.dossier, dirname(o.recolteur));
    processus = (o.lancer ?? lancerParDefaut)(cmd!, argv);
  } catch (e) {
    return conclure({ statut: "erreur", erreur: `Récolte impossible à lancer : ${message(e)}` });
  }

  let arret: Arret | null = null;
  let terminal: Extract<MessageRecolteur, { t: "fin" | "echec" }> | null = null;
  let journal = "";
  let enVol = 0;
  const arreter = (a: Arret) => {
    if (arret) return;
    arret = a;
    processus.tuer();
  };
  const minuteur = setTimeout(() => arreter({ statut: "erreur", erreur: "Délai dépassé" }), o.delaiMs ?? DELAI_RECOLTE_MS);

  processus.stdin.on("error", () => {});
  processus.stdin.write(ligneDebut({ precedent: donneesPrecedentes, maintenant: debut, config: declaration.config ?? null }));
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

  /** Options de lecture : pour un widget avec compte, le pont reçoit la liste des domaines où il peut naviguer. */
  // Tests seulement : le pont permet alors aussi les adresses locales (il les refuse sinon, redirections comprises).
  const avecDomaines = (profil: string | null, domaines: readonly string[] | null) => ({
    profil,
    ...(aCompte && domaines ? { domaines: [...domaines] } : {}),
    ...(adressesLocales ? { adressesLocales: true } : {}),
  });
  const lirePage = async (a: unknown): Promise<unknown> => {
    const { url, compte } = args(ArgsLirePage, a, "lirePage");
    const lire = o.pont.lirePageInvisible?.bind(o.pont);
    if (!lire) throw new Error("Lecture de pages indisponible");
    if (!compte) {
      const page = await lire(verifierUrl(url, domainesPublics, adressesLocales).href, avecDomaines(null, domainesPublics));
      return verifierPage(page, domainesPublics, adressesLocales);
    }
    // Le domaine doit être déclaré en `compte` ; l'accord est relu à chaque lecture (il a pu être retiré).
    const u = verifierUrl(url, declaration.sources.compte, adressesLocales);
    const accord = (await lireAccords(dossierWidgets))[id];
    if (!accordValide(declaration, accord)) {
      arreter({ statut: "accord-requis", erreur: accordRequis(declaration) });
      return SANS_REPONSE;
    }
    if (arret) return SANS_REPONSE;
    try {
      const page = await lire(u.href, avecDomaines(accord.profil, declaration.sources.compte));
      return verifierPage(page, declaration.sources.compte, adressesLocales);
    } catch (e) {
      if (e instanceof ProfilRefuse || (e as Error)?.name === "ProfilRefuse") {
        // L'accord est retiré avant l'arrêt : quand l'état est écrit, il n'existe plus. Les données lues avec ce compte
        // partent avec lui (le widget montre son exemple jusqu'au nouvel accord).
        try {
          await retirerAccord(dossierWidgets, id);
          await supprimerDonnees(dossierWidgets, id);
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
        if (!o.ia) throw new Error("IA locale indisponible");
        return o.ia.kev(corps);
      }
      case "gemma": {
        const g = args(ArgsGemma, a, "gemma");
        if (!o.ia) throw new Error("IA locale indisponible");
        return o.ia.gemma(g);
      }
      default:
        throw new Error(`Fonction inconnue : ${f}`);
    }
  };

  const traiterLigne = (ligne: string) => {
    if (arret || terminal || !ligne.trim()) return;
    const m = lireMessageRecolteur(ligne);
    if (!m) return; // Une ligne hors protocole (le widget a écrit sur stdout) est ignorée.
    // Les traces d'un workflow (bloc, journal, memoire) ne terminent rien ; seules fin et echec le font.
    if (m.t === "fin" || m.t === "echec") {
      terminal = m;
      processus.stdin.end();
      return;
    }
    if (m.t !== "appel") return;
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

  // Lecture ligne à ligne ; une ligne de plus de 4 Mo arrête la récolte avant d'être accumulée en entier.
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
    await o.atelier.supprimerRecolte(id).catch(() => {});
    return conclure({ ...arretFinal, journal });
  }
  if (fin?.t === "fin" && code === 0) {
    // L'accord a pu être retiré pendant la récolte (refuserAccord efface les données) : ce qui a été lu avec ne s'écrit pas.
    if (aCompte && !(await accordToujoursValide())) return refuseeEnCours();
    try {
      await ecrireDonnees(dossierWidgets, id, fin.donnees);
    } catch (e) {
      return conclure({ statut: "erreur", erreur: message(e), journal });
    }
    // Retiré pendant l'écriture : refuserAccord a pu effacer avant elle. Relu après, les données écrites partent.
    if (aCompte && !(await accordToujoursValide())) return refuseeEnCours();
    const ok = await conclure({ statut: "ok", donnees: fin.donnees, journal });
    // Retiré pendant l'écriture de l'état : « ok » ne doit pas recouvrir l'accord-requis écrit par refuserAccord.
    if (aCompte && !(await accordToujoursValide())) return refuseeEnCours();
    return ok;
  }
  if (fin?.t === "echec") return conclure({ statut: "erreur", erreur: fin.erreur, erreurWidget: true, journal });
  if (code === 124) return conclure({ statut: "erreur", erreur: "Délai dépassé", journal });
  // Le code de sortie est choisi par le widget : il pourrait y coder des données du compte.
  return conclure({ statut: "erreur", erreur: `La récolte s'est arrêtée sans résultat (code ${code ?? "aucun"})`, erreurWidget: true, journal });
}
