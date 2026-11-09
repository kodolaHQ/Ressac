import type { DevRight, TabInfo } from "@webaios/kernel";
import { privateTab, type Decision, type PendingRequest, type Outcome, type WindowState, type BrowserState, type SpaceId, type WindowId, type Tab } from "../../shared/model";

const info = (state: BrowserState, o: Tab): TabInfo => ({
  id: o.id,
  titre: o.titre,
  url: o.url,
  espace: state.espaces.find((e) => e.id === o.espaceId)?.nom ?? "",
});

/** WebAiOs internal pages (`webaios:`): the agent never sees them. */
const internal = (o: Tab) => o.url.startsWith("webaios:");

/** The agent sees the tab: neither an internal page, nor a tab of a private space (spec §3.3). */
const visible = (state: BrowserState, o: Tab) => !internal(o) && !privateTab(state, o);

/** All the tabs, all windows combined, as the agent sees them. */
export function tabInfos(state: BrowserState): TabInfo[] {
  return Object.values(state.onglets).filter((o) => visible(state, o)).map((o) => info(state, o));
}

/** The tab the user is looking at in the window, internal page included. */
function shownTab(state: BrowserState, windowId: WindowId | undefined): Tab | undefined {
  const f = state.fenetres.find((x) => x.id === windowId);
  const id = f?.actif[f.espaceActif];
  return id ? state.onglets[id] : undefined;
}

export function activeTabOf(state: BrowserState, windowId: WindowId | undefined): TabInfo | null {
  const o = shownTab(state, windowId);
  return o && visible(state, o) ? info(state, o) : null;
}

/** The space requested by the agent: by id, then by name (case-insensitive), otherwise the active space. A private space counts as unknown. */
export function resolveSpace(state: BrowserState, f: WindowState, space?: string): SpaceId {
  if (!space) return f.espaceActif;
  const opened = state.espaces.filter((x) => !x.prive);
  const e = opened.find((x) => x.id === space) ?? opened.find((x) => x.nom.toLowerCase() === space.toLowerCase());
  return e?.id ?? f.espaceActif;
}

/**
 * What the access policy must learn from a state change: navigations and closings. A tab moved into
 * a private space is closed to the agent: read and developer tools drop.
 */
export function policyChanges(before: BrowserState, after: BrowserState): { navigues: { id: string; url: string }[]; fermes: string[] } {
  const navigated: { id: string; url: string }[] = [];
  const closed: string[] = [];
  for (const [id, o] of Object.entries(before.onglets)) {
    const n = after.onglets[id];
    if (!n || (!privateTab(before, o) && privateTab(after, n))) closed.push(id);
    else if (n.url !== o.url) navigated.push({ id, url: n.url });
  }
  return { navigues: navigated, fermes: closed };
}

/** The spaces that just went from non-private to private (the reverse changes nothing in the history). */
export function spacesBecamePrivate(before: BrowserState, after: BrowserState): string[] {
  return after.espaces.filter((n) => n.prive && before.espaces.some((o) => o.id === n.id && !o.prive)).map((n) => n.id);
}

/**
 * A question that will no longer get a useful answer: its targeted tab is closed. An agent request is displayed
 * in its window, whatever tab is displayed: closing that one does not concern it.
 */
export function staleQuestion(d: PendingRequest, state: BrowserState): boolean {
  // An extension's grant card: it drops with its space; the agent's also when the space's profile
  // becomes private (no agent extension is loaded there). Registry removal and cut-off: ServiceExtensions.
  if (d.extension) {
    const space = state.espaces.find((e) => e.id === d.extension!.espaceId);
    if (!space) return true;
    if (d.extension.source === "agent" && state.espaces.some((e) => e.profil === space.profil && e.prive)) return true;
  }
  // An app window (`app:<folder>`) or site app window (`site:<id>`) is not a tab: its closing and its
  // navigations are tracked separately.
  const win = d.cible !== undefined && (d.cible.startsWith(APP_PREFIX) || d.cible.startsWith(SITE_PREFIX));
  const tab = d.cible && !win ? state.onglets[d.cible] : undefined;
  if (d.cible && !win && !tab) return true;
  // Moved into a private space: the agent no longer has access there, the question is moot.
  if (tab && privateTab(state, tab)) return true;
  // The rights cover the site the user saw: the tab went elsewhere, the card drops.
  if (tab && (d.permissions.includes("outils-dev") || d.permissions.includes("lire-onglet")) && originOf(tab.url) !== d.origine) return true;
  return !d.fenetreId && d.ongletId !== null && !state.onglets[d.ongletId];
}

/**
 * The decision kept for a UI answer: a « yes » to a hardened extension card is received only if it
 * carries the « Je comprends » box checked (`confirme`); otherwise it is a refusal, whatever the UI shows.
 */
export function allowedDecision(d: PendingRequest, decision: Decision, confirmed?: boolean): Decision {
  if (decision === "autoriser" && d.extension?.renforce && confirmed !== true) return "refuser";
  return decision;
}

/** The origin of a URL, or the URL as is if it has none. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** A read request with no answer after this delay is refused: the agent does not stay blocked. */
export const QUESTION_DELAY_MS = 120_000;

/**
 * Asks the user a question and waits for their answer. `poser` displays the question, receives what is needed to answer it, and
 * returns what is needed to withdraw it (called if the delay expires, or if `signal` is raised: the answer is then a refusal).
 * `delaiMs` is `Infinity` for a question with no delay.
 */
export function waitForResponse(
  ask: (reply: (d: Outcome) => void) => () => void,
  delayMs = QUESTION_DELAY_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  return waitForOutcome(ask, delayMs, signal).then((d) => d === "autoriser");
}

/**
 * Like `attendreReponse`, but tells whether the question lapsed without an answer from the user (« retiree »: delay, `signal`,
 * or withdrawn by whoever asked it).
 */
export function waitForOutcome(
  ask: (reply: (d: Outcome) => void) => () => void,
  delayMs = QUESTION_DELAY_MS,
  signal?: AbortSignal,
): Promise<Outcome> {
  if (signal?.aborted) return Promise.resolve("retiree");
  return new Promise((ok) => {
    let finished = false;
    const reply = (d: Outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      ok(d);
    };
    const abandon = () => {
      if (finished) return;
      remove();
      reply("retiree");
    };
    // `Infinity`: no delay (a question coming from a click by the user waits for their answer).
    const timer = Number.isFinite(delayMs) ? setTimeout(abandon, delayMs) : undefined;
    const remove = ask(reply);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

/**
 * Like `attendreReponse`, for the developer tools card: returns the checked rights if the user allows,
 * `[]` if they refuse, if the delay expires or if `signal` is raised (the card is then withdrawn).
 */
export function waitForRights(
  ask: (reply: (d: Outcome, rights?: DevRight[]) => void) => () => void,
  delayMs = QUESTION_DELAY_MS,
  signal?: AbortSignal,
): Promise<DevRight[]> {
  if (signal?.aborted) return Promise.resolve([]);
  return new Promise((ok) => {
    let finished = false;
    const reply = (d: Outcome, rights: DevRight[] = []) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      ok(d === "autoriser" ? rights : []);
    };
    const abandon = () => {
      if (finished) return;
      remove();
      reply("refuser");
    };
    const timer = setTimeout(abandon, delayMs);
    const remove = ask(reply);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

const APP_PREFIX = "app:";
/** Tab id, for the agent, of a site app's window: `site:<id>`. */
export const SITE_PREFIX = "site:";

/** A site app's window seen as a `site:<id>` tab: its title is the app's name, never the page's. */
export function siteTab(s: { id: string; nom: string; url: string; domaine: string; empreinte: string }): TabInfo {
  return { id: SITE_PREFIX + s.id, titre: s.nom, url: s.url, espace: "", site: s.id, domaine: s.domaine, empreinte: s.empreinte };
}

/**
 * A question from the agent about a site app window (`cible: site:<id>`) that is moot: the window is
 * closed, or (developer tools) its page went to another origin. The app's card (without a target) is not
 * concerned: its grant is valid for the app, window open or not.
 */
export function staleSiteQuestion(d: PendingRequest, opened: { id: string; url: string }[]): boolean {
  if (!d.cible?.startsWith(SITE_PREFIX)) return false;
  const site = opened.find((s) => SITE_PREFIX + s.id === d.cible);
  return !site || (d.permissions.includes("outils-dev") && originOf(site.url) !== d.origine);
}

/** An app's window seen as an `app:<folder>` tab by the agent. */
export function appTab(a: { dossier: string; titre: string; url: string }): TabInfo {
  return { id: APP_PREFIX + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier };
}
