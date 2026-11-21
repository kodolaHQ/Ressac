import type { DevRight, TabInfo } from "../shims/kernel";
import type { ExtensionCard, GrantResponse } from "../../shared/extensions";
import type { Decision, PendingRequest, WindowId, TabId, Outcome, Permission } from "../../shared/model";
import { SCHEMA_SITE } from "../../shared/sites";
import { waitForRights, waitForOutcome, waitForResponse, QUESTION_DELAY_MS, allowedDecision, activeTabOf, originOf, staleQuestion, staleSiteQuestion } from "../../core/agent/bridge";
import type { SitePermission } from "../store/site-permissions";
import type { Store } from "../store/store";

type Listener = (pending: PendingRequest[]) => void;
/** The scheme of a widget page's address. */
export const SCHEMA_WIDGET = "ressac-widget";

/** The agent's « lire l'onglet » and extension grant cards waiting for the user. */
export class Questions {
  private readonly open = new Map<string, { request: PendingRequest; reply: (d: Outcome, rights?: DevRight[]) => void }>();
  private readonly listeners = new Set<Listener>();

  /**
   * `openSites`: the site app windows open now (`sites.forAgent`), for the questions on `site:<id>`; `openApps`: the agent
   * app windows (`apps.forAgent`), for those on `app:<dossier>`.
   */
  constructor(
    private readonly store: Store,
    private readonly openSites: () => { id: string; url: string }[] = () => [],
    private readonly openApps: () => { folder: string; url: string }[] = () => [],
  ) {
    // A tab closed, moved to a private space or gone to another site will never be answered: its question falls (a refusal).
    store.subscribe(() => this.dropStale());
  }

  /**
   * A question that will never get a useful answer: its tab, or its site app window (`site:<id>`), is gone; its app
   * window (`app:<dossier>`) is closed or on another origin.
   */
  private stale(d: PendingRequest): boolean {
    if (d.target?.startsWith("app:")) {
      const a = this.openApps().find((x) => `app:${x.folder}` === d.target);
      if (!a || originOf(a.url) !== d.origin) return true;
    }
    return staleQuestion(d, this.store.state) || staleSiteQuestion(d, this.openSites());
  }

  /** Drops the stale questions (« retirée »); called on each state change and when a site app window closes. */
  dropStale(): void {
    let changed = false;
    for (const [id, q] of this.open)
      if (this.stale(q.request)) {
        this.open.delete(id);
        q.reply("withdrawn");
        changed = true;
      }
    if (changed) this.changed();
  }

  /** Shows the card in the window and waits for the answer; false after QUESTION_DELAY_MS, or when `signal` aborts. */
  ask(o: TabInfo, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const tabId = activeTabOf(this.store.state, windowId)?.id ?? null;
    const fields = { tabId: tabId, windowId: windowId, origin: originOf(o.url), permissions: ["read-tab" as const], title: o.title, target: o.id };
    // Already stale (tab closed, private, gone elsewhere): no card, which no state change would ever take down.
    if (this.stale({ id: "", ...fields })) return Promise.resolve(false);
    return waitForResponse((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * The dev tools card: the rights ticked when allowed, `[]` on a refusal, after
   * QUESTION_DELAY_MS, on `signal`, or when the tab closes, turns private or goes to another site.
   */
  askDevTools(o: TabInfo, d: { rights: DevRight[]; reason: string; agent: string }, windowId: WindowId, signal?: AbortSignal): Promise<DevRight[]> {
    const tabId = activeTabOf(this.store.state, windowId)?.id ?? null;
    const fields = { tabId: tabId, windowId: windowId, origin: originOf(o.url), permissions: ["devtools" as const], title: o.title, target: o.id, rights: d.rights, reason: d.reason, agent: d.agent };
    if (this.stale({ id: "", ...fields })) return Promise.resolve([]);
    return waitForRights((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /** The card for an address the agent composed: false on a refusal, after QUESTION_DELAY_MS or on `signal`. */
  askAddress(o: { url: string; reason: string; agent: string; danger?: string }, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const fields = { tabId: null, windowId: windowId, origin: o.url, permissions: ["agent-address" as const], title: o.url, reason: o.reason, agent: o.agent, ...(o.danger ? { danger: o.danger } : {}) };
    return waitForResponse((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * The « donnees-widget » card: the agent wants a widget's, an
   * action's or a site app's data, read with the user's account. False after QUESTION_DELAY_MS or on `signal`.
   */
  askWidgetData(o: { id: string; name: string; agent: string; kind?: "action" | "site" | "history" }, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const tabId = activeTabOf(this.store.state, windowId)?.id ?? null;
    const fields = { tabId: tabId, windowId: windowId, permissions: ["widget-data" as const], title: o.name, agent: o.agent };
    const target =
      o.kind === "action"
        ? { origin: `ressac://action/${o.id}`, action: o.id }
        : o.kind === "site"
          ? { origin: `${SCHEMA_SITE}://${o.id}`, site: o.id }
          : o.kind === "history"
            ? { origin: "ressac://history", history: true }
            : { origin: `${SCHEMA_WIDGET}://${o.id}`, widget: o.id };
    return waitForResponse((reply) => this.post({ ...fields, ...target }, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * Shows the grant card of an agent extension (ExtensionRequest) in the window; it falls (« retirée ») after
   * QUESTION_DELAY_MS, on `signal`, or when its space goes or turns private. A renforcée card needs « Je comprends ».
   */
  async askExtension(card: ExtensionCard, windowId: WindowId, signal?: AbortSignal): Promise<GrantResponse> {
    const fields = { tabId: null, windowId: windowId, origin: card.key, permissions: ["extension" as const], extension: card };
    const outcome = staleQuestion({ id: "", ...fields }, this.store.state)
      ? "withdrawn"
      : await waitForOutcome((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal);
    return { accepted: outcome === "allow", ...(outcome === "withdrawn" ? { removed: true } : {}) };
  }

  /** The console unlock card of an agent extension: Refuser is the default; it falls after QUESTION_DELAY_MS or on `signal`. */
  askConsole(o: { name: string; spaces: string[]; reason: string; agent: string }, windowId: WindowId, signal?: AbortSignal): Promise<Outcome> {
    const fields = { tabId: null, windowId: windowId, origin: o.name, permissions: ["extension-console" as const], title: o.name, reason: o.reason, agent: o.agent, spaces: o.spaces };
    return waitForOutcome((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * A site's question, shown as the banner on its tab: no delay, it waits for the answer; it falls
   * (`withdrawn`) on `signal` or when its tab closes. `windowId` is not kept: site questions with one
   * would show them on every tab of the window and move them with a closed window.
   */
  askSite(
    d: { tabId: TabId | null; windowId: WindowId | null; origin: string; permissions: SitePermission[]; link?: string },
    signal?: AbortSignal,
  ): Promise<Outcome> {
    // The three Firefox-only kinds are not kernel Permissions: the UI never shows a site question (isAgentRequest).
    const fields = { tabId: d.tabId, origin: d.origin, permissions: d.permissions as Permission[], ...(d.link ? { link: d.link } : {}) };
    if (staleQuestion({ id: "", ...fields }, this.store.state)) return Promise.resolve("withdrawn");
    return waitForOutcome((reply) => this.post(fields, reply), Infinity, signal);
  }

  private post(fields: Omit<PendingRequest, "id">, reply: (d: Outcome, rights?: DevRight[]) => void): () => void {
    const id = crypto.randomUUID();
    this.open.set(id, { request: { id, ...fields }, reply: reply });
    this.changed();
    return () => {
      if (this.open.delete(id)) this.changed();
    };
  }

  /** A window closed: its questions move to `to` (on its active tab), or are refused without one. */
  windowClosed(closed: WindowId, to: WindowId | undefined): void {
    let changed = false;
    for (const [id, q] of this.open) {
      if (q.request.windowId !== closed) continue;
      changed = true;
      if (to) q.request = { ...q.request, windowId: to, tabId: activeTabOf(this.store.state, to)?.id ?? null };
      else {
        this.open.delete(id);
        q.reply("withdrawn");
      }
    }
    if (changed) this.changed();
  }

  pending(): PendingRequest[] {
    return [...this.open.values()].map((q) => q.request);
  }

  /** `droits`: the rights ticked on a dev tools card. */
  answer(id: string, d: Decision, o?: { confirmed?: boolean }, rights?: DevRight[]): void {
    const q = this.open.get(id);
    if (!q) return;
    this.open.delete(id);
    // Copied into this realm: the UI's array dies with its document.
    q.reply(allowedDecision(q.request, d, o?.confirmed), rights && Array.from(rights, String) as DevRight[]);
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
