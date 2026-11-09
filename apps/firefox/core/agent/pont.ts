import type { DroitDev, OngletInfo } from "@webaios/noyau";
import { ongletPrive, type Decision, type DemandeEnAttente, type Issue, type EtatFenetre, type EtatNavigateur, type IdEspace, type IdFenetre, type Onglet } from "../../shared/modele";

const info = (etat: EtatNavigateur, o: Onglet): OngletInfo => ({
  id: o.id,
  titre: o.titre,
  url: o.url,
  espace: etat.espaces.find((e) => e.id === o.espaceId)?.nom ?? "",
});

/** Pages internes de WebAiOs (`webaios:`) : l'agent ne les voit jamais. */
const interne = (o: Onglet) => o.url.startsWith("webaios:");

/** L'agent voit l'onglet : ni page interne, ni onglet d'un espace privé (spec §3.3). */
const visible = (etat: EtatNavigateur, o: Onglet) => !interne(o) && !ongletPrive(etat, o);

/** Tous les onglets, toutes fenêtres confondues, tels que l'agent les voit. */
export function infosOnglets(etat: EtatNavigateur): OngletInfo[] {
  return Object.values(etat.onglets).filter((o) => visible(etat, o)).map((o) => info(etat, o));
}

/** L'onglet que l'utilisateur regarde dans la fenêtre, page interne comprise. */
function ongletAffiche(etat: EtatNavigateur, fenetreId: IdFenetre | undefined): Onglet | undefined {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const id = f?.actif[f.espaceActif];
  return id ? etat.onglets[id] : undefined;
}

export function ongletActifDe(etat: EtatNavigateur, fenetreId: IdFenetre | undefined): OngletInfo | null {
  const o = ongletAffiche(etat, fenetreId);
  return o && visible(etat, o) ? info(etat, o) : null;
}

/** L'espace demandé par l'agent : par id, puis par nom (sans casse), sinon l'espace actif. Un espace privé compte comme inconnu. */
export function resoudreEspace(etat: EtatNavigateur, f: EtatFenetre, espace?: string): IdEspace {
  if (!espace) return f.espaceActif;
  const ouverts = etat.espaces.filter((x) => !x.prive);
  const e = ouverts.find((x) => x.id === espace) ?? ouverts.find((x) => x.nom.toLowerCase() === espace.toLowerCase());
  return e?.id ?? f.espaceActif;
}

/**
 * Ce que la politique d'accès doit apprendre d'un changement d'état : navigations et fermetures. Un onglet passé dans
 * un espace privé est fermé pour l'agent : lecture et outils de développement tombent.
 */
export function changementsPolitique(avant: EtatNavigateur, apres: EtatNavigateur): { navigues: { id: string; url: string }[]; fermes: string[] } {
  const navigues: { id: string; url: string }[] = [];
  const fermes: string[] = [];
  for (const [id, o] of Object.entries(avant.onglets)) {
    const n = apres.onglets[id];
    if (!n || (!ongletPrive(avant, o) && ongletPrive(apres, n))) fermes.push(id);
    else if (n.url !== o.url) navigues.push({ id, url: n.url });
  }
  return { navigues, fermes };
}

/** Les espaces qui viennent de passer de non privé à privé (le sens inverse ne change rien à l'historique). */
export function espacesDevenusPrives(avant: EtatNavigateur, apres: EtatNavigateur): string[] {
  return apres.espaces.filter((n) => n.prive && avant.espaces.some((o) => o.id === n.id && !o.prive)).map((n) => n.id);
}

/**
 * Une question qui ne recevra plus de réponse utile : son onglet visé est fermé. Une demande de l'agent s'affiche
 * dans sa fenêtre, quel que soit l'onglet affiché : fermer celui-ci ne la concerne pas.
 */
export function questionCaduque(d: DemandeEnAttente, etat: EtatNavigateur): boolean {
  // Carte d'accord d'une extension : elle tombe avec son espace ; celle de l'agent aussi quand le profil de l'espace
  // devient privé (aucune extension de l'agent n'y est chargée). Retrait du registre et coupure : ServiceExtensions.
  if (d.extension) {
    const espace = etat.espaces.find((e) => e.id === d.extension!.espaceId);
    if (!espace) return true;
    if (d.extension.source === "agent" && etat.espaces.some((e) => e.profil === espace.profil && e.prive)) return true;
  }
  // Une fenêtre d'appli (`app:<dossier>`) ou d'appli de site (`site:<id>`) n'est pas un onglet : sa fermeture et ses
  // navigations sont suivies à part.
  const fenetre = d.cible !== undefined && (d.cible.startsWith(PREFIXE_APP) || d.cible.startsWith(PREFIXE_SITE));
  const onglet = d.cible && !fenetre ? etat.onglets[d.cible] : undefined;
  if (d.cible && !fenetre && !onglet) return true;
  // Passé dans un espace privé : l'agent n'y a plus accès, la question n'a plus d'objet.
  if (onglet && ongletPrive(etat, onglet)) return true;
  // Les droits portent sur le site que l'utilisateur a vu : l'onglet est parti ailleurs, la carte tombe.
  if (onglet && (d.permissions.includes("outils-dev") || d.permissions.includes("lire-onglet")) && origineDe(onglet.url) !== d.origine) return true;
  return !d.fenetreId && d.ongletId !== null && !etat.onglets[d.ongletId];
}

/**
 * La décision retenue pour une réponse de l'interface : un « oui » à une carte d'extension renforcée n'est reçu que s'il
 * porte la case « Je comprends » cochée (`confirme`) ; sinon c'est un refus, quel que soit ce qu'affiche l'interface.
 */
export function decisionPermise(d: DemandeEnAttente, decision: Decision, confirme?: boolean): Decision {
  if (decision === "autoriser" && d.extension?.renforce && confirme !== true) return "refuser";
  return decision;
}

/** L'origine d'une URL, ou l'URL telle quelle si elle n'en a pas. */
export function origineDe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Une demande de lecture sans réponse au bout de ce délai est refusée : l'agent ne reste pas bloqué. */
export const DELAI_QUESTION_MS = 120_000;

/**
 * Pose une question à l'utilisateur et attend sa réponse. `poser` affiche la question, reçoit de quoi y répondre, et
 * renvoie de quoi la retirer (appelé si le délai expire, ou si `signal` est levé : la réponse est alors un refus).
 * `delaiMs` vaut `Infinity` pour une question sans délai.
 */
export function attendreReponse(
  poser: (repondre: (d: Issue) => void) => () => void,
  delaiMs = DELAI_QUESTION_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  return attendreIssue(poser, delaiMs, signal).then((d) => d === "autoriser");
}

/**
 * Comme `attendreReponse`, mais dit si la question est tombée sans réponse de l'utilisateur (« retiree » : délai, `signal`,
 * ou retirée par celui qui l'a posée).
 */
export function attendreIssue(
  poser: (repondre: (d: Issue) => void) => () => void,
  delaiMs = DELAI_QUESTION_MS,
  signal?: AbortSignal,
): Promise<Issue> {
  if (signal?.aborted) return Promise.resolve("retiree");
  return new Promise((ok) => {
    let finie = false;
    const repondre = (d: Issue) => {
      if (finie) return;
      finie = true;
      clearTimeout(minuterie);
      signal?.removeEventListener("abort", abandon);
      ok(d);
    };
    const abandon = () => {
      if (finie) return;
      retirer();
      repondre("retiree");
    };
    // `Infinity` : aucun délai (une question venue d'un clic de l'utilisateur attend sa réponse).
    const minuterie = Number.isFinite(delaiMs) ? setTimeout(abandon, delaiMs) : undefined;
    const retirer = poser(repondre);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

/**
 * Comme `attendreReponse`, pour la carte des outils de développement : renvoie les droits cochés si l'utilisateur autorise,
 * `[]` s'il refuse, si le délai expire ou si `signal` est levé (la carte est alors retirée).
 */
export function attendreDroits(
  poser: (repondre: (d: Issue, droits?: DroitDev[]) => void) => () => void,
  delaiMs = DELAI_QUESTION_MS,
  signal?: AbortSignal,
): Promise<DroitDev[]> {
  if (signal?.aborted) return Promise.resolve([]);
  return new Promise((ok) => {
    let finie = false;
    const repondre = (d: Issue, droits: DroitDev[] = []) => {
      if (finie) return;
      finie = true;
      clearTimeout(minuterie);
      signal?.removeEventListener("abort", abandon);
      ok(d === "autoriser" ? droits : []);
    };
    const abandon = () => {
      if (finie) return;
      retirer();
      repondre("refuser");
    };
    const minuterie = setTimeout(abandon, delaiMs);
    const retirer = poser(repondre);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

const PREFIXE_APP = "app:";
/** Id d'onglet, pour l'agent, de la fenêtre d'une appli de site : `site:<id>`. */
export const PREFIXE_SITE = "site:";

/** La fenêtre d'une appli de site vue comme un onglet `site:<id>` : son titre est le nom de l'appli, jamais celui de la page. */
export function ongletSite(s: { id: string; nom: string; url: string; domaine: string; empreinte: string }): OngletInfo {
  return { id: PREFIXE_SITE + s.id, titre: s.nom, url: s.url, espace: "", site: s.id, domaine: s.domaine, empreinte: s.empreinte };
}

/**
 * Une question de l'agent sur une fenêtre d'appli de site (`cible: site:<id>`) qui n'a plus d'objet : la fenêtre est
 * fermée, ou (outils de développement) sa page est partie sur une autre origine. La carte de l'appli (sans cible) n'est
 * pas concernée : son accord vaut pour l'appli, fenêtre ouverte ou non.
 */
export function questionSiteCaduque(d: DemandeEnAttente, ouvertes: { id: string; url: string }[]): boolean {
  if (!d.cible?.startsWith(PREFIXE_SITE)) return false;
  const site = ouvertes.find((s) => PREFIXE_SITE + s.id === d.cible);
  return !site || (d.permissions.includes("outils-dev") && origineDe(site.url) !== d.origine);
}

/** La fenêtre d'une appli vue comme un onglet `app:<dossier>` par l'agent. */
export function ongletApplication(a: { dossier: string; titre: string; url: string }): OngletInfo {
  return { id: PREFIXE_APP + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier };
}
