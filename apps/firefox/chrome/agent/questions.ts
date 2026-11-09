import type { DevRight, TabInfo } from "../shims/kernel";
import type { ExtensionCard, GrantResponse } from "../../shared/extensions";
import type { Decision, PendingRequest, WindowId, TabId, Outcome, Permission } from "../../shared/model";
import { SCHEMA_SITE } from "../../shared/sites";
import { waitForRights, waitForOutcome, waitForResponse, QUESTION_DELAY_MS, allowedDecision, activeTabOf, originOf, staleQuestion, staleSiteQuestion } from "../../core/agent/bridge";
import type { SitePermission } from "../store/site-permissions";
import type { Store } from "../store/store";

type Listener = (pending: PendingRequest[]) => void;
/** The scheme of a widget page's address. */
export const SCHEMA_WIDGET = "webaios-widget";

/** The agent's « lire l'onglet » and extension grant cards waiting for the user. */
export class Questions {
  private readonly open = new Map<string, { demande: PendingRequest; repondre: (d: Outcome, rights?: DevRight[]) => void }>();
  private readonly listeners = new Set<Listener>();

  /**
   * `openSites`: the site app windows open now (`sites.forAgent`), for the questions on `site:<id>`; `openApps`: the agent
   * app windows (`apps.forAgent`), for those on `app:<dossier>`.
   */
  constructor(
    private readonly store: Store,
    private readonly openSites: () => { id: string; url: string }[] = () => [],
    private readonly openApps: () => { dossier: string; url: string }[] = () => [],
  ) {
    // A tab closed, moved to a private space or gone to another site will never be answered: its question falls (a refusal).
    store.subscribe(() => this.dropStale());
  }

  /**
   * A question that will never get a useful answer: its tab, or its site app window (`site:<id>`), is gone; its app
   * window (`app:<dossier>`) is closed or on another origin.
   */
  private stale(d: PendingRequest): boolean {
    if (d.cible?.startsWith("app:")) {
      const a = this.openApps().find((x) => `app:${x.dossier}` === d.cible);
      if (!a || originOf(a.url) !== d.origine) return true;
    }
    return staleQuestion(d, this.store.state) || staleSiteQuestion(d, this.openSites());
  }

  /** Drops the stale questions (« retirée »); called on each state change and when a site app window closes. */
  dropStale(): void {
    let changed = false;
    for (const [id, q] of this.open)
      if (this.stale(q.demande)) {
        this.open.delete(id);
        q.repondre("retiree");
        changed = true;
      }
    if (changed) this.changed();
  }

  /** Shows the card in the window and waits for the answer; false after QUESTION_DELAY_MS, or when `signal` aborts. */
  ask(o: TabInfo, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const tabId = activeTabOf(this.store.state, windowId)?.id ?? null;
    const fields = { ongletId: tabId, fenetreId: windowId, origine: originOf(o.url), permissions: ["lire-onglet" as const], titre: o.titre, cible: o.id };
    // Already stale (tab closed, private, gone elsewhere): no card, which no state change would ever take down.
    if (this.stale({ id: "", ...fields })) return Promise.resolve(false);
    return waitForResponse((reply) => this.pose(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * The dev tools card: the rights ticked when allowed, `[]` on a refusal, after
   * QUESTION_DELAY_MS, on `signal`, or when the tab closes, turns private or goes to another site.
   */
  askDevTools(o: TabInfo, d: { droits: DevRight[]; raison: string; agent: string }, windowId: WindowId, signal?: AbortSignal): Promise<DevRight[]> {
    const tabId = activeTabOf(this.store.state, windowId)?.id ?? null;
    const fields = { ongletId: tabId, fenetreId: windowId, origine: originOf(o.url), permissions: ["outils-dev" as const], titre: o.titre, cible: o.id, droits: d.droits, raison: d.raison, agent: d.agent };
    if (this.stale({ id: "", ...fields })) return Promise.resolve([]);
    return waitForRights((reply) => this.pose(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * The « donnees-widget » card: the agent wants a widget's, an
   * action's or a site app's data, read with the user's account. False after QUESTION_DELAY_MS or on `signal`.
   */
  askWidgetData(o: { id: string; nom: string; agent: string; genre?: "action" | "site" }, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const tabId = activeTabOf(this.store.state, windowId)?.id ?? null;
    const fields = { ongletId: tabId, fenetreId: windowId, permissions: ["donnees-widget" as const], titre: o.nom, agent: o.agent };
    const target =
      o.genre === "action"
        ? { origine: `webaios://action/${o.id}`, action: o.id }
        : o.genre === "site"
          ? { origine: `${SCHEMA_SITE}://${o.id}`, site: o.id }
          : { origine: `${SCHEMA_WIDGET}://${o.id}`, widget: o.id };
    return waitForResponse((reply) => this.pose({ ...fields, ...target }, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * Shows the grant card of an agent extension (ExtensionRequest) in the window; it falls (« retirée ») after
   * QUESTION_DELAY_MS, on `signal`, or when its space goes or turns private. A renforcée card needs « Je comprends ».
   */
  async askExtension(card: ExtensionCard, windowId: WindowId, signal?: AbortSignal): Promise<GrantResponse> {
    const fields = { ongletId: null, fenetreId: windowId, origine: card.cle, permissions: ["extension" as const], extension: card };
    const outcome = staleQuestion({ id: "", ...fields }, this.store.state)
      ? "retiree"
      : await waitForOutcome((reply) => this.pose(fields, reply), QUESTION_DELAY_MS, signal);
    return { accepte: outcome === "autoriser", empreinte: card.empreinte, ...(outcome === "retiree" ? { retiree: true } : {}) };
  }

  /** The console unlock card of an agent extension: Refuser is the default; it falls after QUESTION_DELAY_MS or on `signal`. */
  askConsole(o: { nom: string; espaces: string[]; raison: string; agent: string }, windowId: WindowId, signal?: AbortSignal): Promise<Outcome> {
    const fields = { ongletId: null, fenetreId: windowId, origine: o.nom, permissions: ["console-extension" as const], titre: o.nom, raison: o.raison, agent: o.agent, espaces: o.espaces };
    return waitForOutcome((reply) => this.pose(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * A site's question, shown as the banner on its tab: no delay, it waits for the answer; it falls
   * (« retiree ») on `signal` or when its tab closes. `fenetreId` is not kept: site questions with one
   * would show them on every tab of the window and move them with a closed window.
   */
  askSite(
    d: { ongletId: TabId | null; fenetreId: WindowId | null; origine: string; permissions: SitePermission[]; lien?: string },
    signal?: AbortSignal,
  ): Promise<Outcome> {
    // The three Firefox-only kinds are not kernel Permissions: the UI never shows a site question (isAgentRequest).
    const fields = { ongletId: d.ongletId, origine: d.origine, permissions: d.permissions as Permission[], ...(d.lien ? { lien: d.lien } : {}) };
    if (staleQuestion({ id: "", ...fields }, this.store.state)) return Promise.resolve("retiree");
    return waitForOutcome((reply) => this.pose(fields, reply), Infinity, signal);
  }

  private pose(fields: Omit<PendingRequest, "id">, reply: (d: Outcome, rights?: DevRight[]) => void): () => void {
    const id = crypto.randomUUID();
    this.open.set(id, { demande: { id, ...fields }, repondre: reply });
    this.changed();
    return () => {
      if (this.open.delete(id)) this.changed();
    };
  }

  /** A window closed: its questions move to `to` (on its active tab), or are refused without one. */
  windowClosed(closed: WindowId, to: WindowId | undefined): void {
    let changed = false;
    for (const [id, q] of this.open) {
      if (q.demande.fenetreId !== closed) continue;
      changed = true;
      if (to) q.demande = { ...q.demande, fenetreId: to, ongletId: activeTabOf(this.store.state, to)?.id ?? null };
      else {
        this.open.delete(id);
        q.repondre("retiree");
      }
    }
    if (changed) this.changed();
  }

  pending(): PendingRequest[] {
    return [...this.open.values()].map((q) => q.demande);
  }

  /** `droits`: the rights ticked on a dev tools card. */
  answer(id: string, d: Decision, o?: { confirme?: boolean }, rights?: DevRight[]): void {
    const q = this.open.get(id);
    if (!q) return;
    this.open.delete(id);
    // Copied into this realm: the UI's array dies with its document.
    q.repondre(allowedDecision(q.demande, d, o?.confirme), rights && Array.from(rights, String) as DevRight[]);
    this.changed();
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private changed(): void {
    const pending = this.pending();
    for (const l of [...this.listeners])
      try {
        l(pending);
      } catch (e) {
        console.error("[questions] listener failed:", e);
      }
  }
}
