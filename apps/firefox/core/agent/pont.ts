import type { DroitDev, TabInfo } from "@webaios/noyau";
import { ongletPrive, type Decision, type DemandeEnAttente, type Issue, type EtatFenetre, type EtatNavigateur, type IdEspace, type IdFenetre, type Onglet } from "../../shared/modele";

const info = (etat: EtatNavigateur, o: Onglet): TabInfo => ({
  id: o.id,
  titre: o.titre,
  url: o.url,
  espace: etat.espaces.find((e) => e.id === o.espaceId)?.nom ?? "",
});

/** WebAiOs internal pages (`webaios:`): the agent never sees them. */
const interne = (o: Onglet) => o.url.startsWith("webaios:");

/** The agent sees the tab: neither an internal page, nor a tab of a private space (spec §3.3). */
const visible = (etat: EtatNavigateur, o: Onglet) => !interne(o) && !ongletPrive(etat, o);

/** All the tabs, all windows combined, as the agent sees them. */
export function infosOnglets(etat: EtatNavigateur): TabInfo[] {
  return Object.values(etat.onglets).filter((o) => visible(etat, o)).map((o) => info(etat, o));
}

/** The tab the user is looking at in the window, internal page included. */
function ongletAffiche(etat: EtatNavigateur, fenetreId: IdFenetre | undefined): Onglet | undefined {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const id = f?.actif[f.espaceActif];
  return id ? etat.onglets[id] : undefined;
}

export function ongletActifDe(etat: EtatNavigateur, fenetreId: IdFenetre | undefined): TabInfo | null {
  const o = ongletAffiche(etat, fenetreId);
  return o && visible(etat, o) ? info(etat, o) : null;
}

/** The space requested by the agent: by id, then by name (case-insensitive), otherwise the active space. A private space counts as unknown. */
export function resoudreEspace(etat: EtatNavigateur, f: EtatFenetre, espace?: string): IdEspace {
  if (!espace) return f.espaceActif;
  const ouverts = etat.espaces.filter((x) => !x.prive);
  const e = ouverts.find((x) => x.id === espace) ?? ouverts.find((x) => x.nom.toLowerCase() === espace.toLowerCase());
  return e?.id ?? f.espaceActif;
}

/**
 * What the access policy must learn from a state change: navigations and closings. A tab moved into
 * a private space is closed to the agent: read and developer tools drop.
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

/** The spaces that just went from non-private to private (the reverse changes nothing in the history). */
export function espacesDevenusPrives(avant: EtatNavigateur, apres: EtatNavigateur): string[] {
  return apres.espaces.filter((n) => n.prive && avant.espaces.some((o) => o.id === n.id && !o.prive)).map((n) => n.id);
}

/**
 * A question that will no longer get a useful answer: its targeted tab is closed. An agent request is displayed
 * in its window, whatever tab is displayed: closing that one does not concern it.
 */
export function questionCaduque(d: DemandeEnAttente, etat: EtatNavigateur): boolean {
  // An extension's grant card: it drops with its space; the agent's also when the space's profile
  // becomes private (no agent extension is loaded there). Registry removal and cut-off: ServiceExtensions.
  if (d.extension) {
    const espace = etat.espaces.find((e) => e.id === d.extension!.espaceId);
    if (!espace) return true;
    if (d.extension.source === "agent" && etat.espaces.some((e) => e.profil === espace.profil && e.prive)) return true;
  }
  // An app window (`app:<folder>`) or site app window (`site:<id>`) is not a tab: its closing and its
  // navigations are tracked separately.
  const fenetre = d.cible !== undefined && (d.cible.startsWith(PREFIXE_APP) || d.cible.startsWith(PREFIXE_SITE));
  const onglet = d.cible && !fenetre ? etat.onglets[d.cible] : undefined;
  if (d.cible && !fenetre && !onglet) return true;
  // Moved into a private space: the agent no longer has access there, the question is moot.
  if (onglet && ongletPrive(etat, onglet)) return true;
  // The rights cover the site the user saw: the tab went elsewhere, the card drops.
  if (onglet && (d.permissions.includes("outils-dev") || d.permissions.includes("lire-onglet")) && origineDe(onglet.url) !== d.origine) return true;
  return !d.fenetreId && d.ongletId !== null && !etat.onglets[d.ongletId];
}

/**
 * The decision kept for a UI answer: a « yes » to a hardened extension card is received only if it
 * carries the « Je comprends » box checked (`confirme`); otherwise it is a refusal, whatever the UI shows.
 */
export function decisionPermise(d: DemandeEnAttente, decision: Decision, confirme?: boolean): Decision {
  if (decision === "autoriser" && d.extension?.renforce && confirme !== true) return "refuser";
  return decision;
}

/** The origin of a URL, or the URL as is if it has none. */
export function origineDe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** A read request with no answer after this delay is refused: the agent does not stay blocked. */
export const DELAI_QUESTION_MS = 120_000;

/**
 * Asks the user a question and waits for their answer. `poser` displays the question, receives what is needed to answer it, and
 * returns what is needed to withdraw it (called if the delay expires, or if `signal` is raised: the answer is then a refusal).
 * `delaiMs` is `Infinity` for a question with no delay.
 */
export function attendreReponse(
  poser: (repondre: (d: Issue) => void) => () => void,
  delaiMs = DELAI_QUESTION_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  return attendreIssue(poser, delaiMs, signal).then((d) => d === "autoriser");
}

/**
 * Like `attendreReponse`, but tells whether the question lapsed without an answer from the user (« retiree »: delay, `signal`,
 * or withdrawn by whoever asked it).
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
    // `Infinity`: no delay (a question coming from a click by the user waits for their answer).
    const minuterie = Number.isFinite(delaiMs) ? setTimeout(abandon, delaiMs) : undefined;
    const retirer = poser(repondre);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

/**
 * Like `attendreReponse`, for the developer tools card: returns the checked rights if the user allows,
 * `[]` if they refuse, if the delay expires or if `signal` is raised (the card is then withdrawn).
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
/** Tab id, for the agent, of a site app's window: `site:<id>`. */
export const PREFIXE_SITE = "site:";

/** A site app's window seen as a `site:<id>` tab: its title is the app's name, never the page's. */
export function ongletSite(s: { id: string; nom: string; url: string; domaine: string; empreinte: string }): TabInfo {
  return { id: PREFIXE_SITE + s.id, titre: s.nom, url: s.url, espace: "", site: s.id, domaine: s.domaine, empreinte: s.empreinte };
}

/**
 * A question from the agent about a site app window (`cible: site:<id>`) that is moot: the window is
 * closed, or (developer tools) its page went to another origin. The app's card (without a target) is not
 * concerned: its grant is valid for the app, window open or not.
 */
export function questionSiteCaduque(d: DemandeEnAttente, ouvertes: { id: string; url: string }[]): boolean {
  if (!d.cible?.startsWith(PREFIXE_SITE)) return false;
  const site = ouvertes.find((s) => PREFIXE_SITE + s.id === d.cible);
  return !site || (d.permissions.includes("outils-dev") && origineDe(site.url) !== d.origine);
}

/** An app's window seen as an `app:<folder>` tab by the agent. */
export function ongletApplication(a: { dossier: string; titre: string; url: string }): TabInfo {
  return { id: PREFIXE_APP + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier };
}
