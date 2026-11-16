import type { TabInfo } from "../mcp/bridge.js";
import { containerPortRange } from "../container/workshop.js";

function origin(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** The agent's demos run in the container and open locally. */
export function isLocal(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export type DevRight = "console" | "network" | "performance" | "act";
export const DEV_RIGHTS: readonly DevRight[] = ["console", "network", "performance", "act"];

export interface TabAccessState {
  read: boolean;
  rights: DevRight[];
  built: boolean;
  running: boolean;
}

/** Default ports of the agent's demos: those of the container. */
const portDemo = (port: number): boolean => {
  const [min, max] = containerPortRange();
  return port >= min && port <= max;
};

/**
 * What the agent may read (spec §8.2): a tab the user gave it, from which the user
 * spoke to it, or a local demo the agent opened itself. An outside site opened by
 * the agent (Gmail, its bank…) still needs a request. A permission holds for one site (origin):
 * if the user changes site, it lapses.
 */
export class AccessPolicy {
  /** tab id → authorized origin */
  private readonly permissions = new Map<string, string>();
  /** tab id → origin where the agent built what it shows */
  private readonly builtTabs = new Map<string, string>();
  /** tab id → rights granted by the user, valid for one origin */
  private readonly rights = new Map<string, { origin: string; list: Set<DevRight> }>();
  /** tab id → rights denied, not askable again before the user's next message */
  private readonly denial = new Map<string, Set<DevRight>>();
  /** tab id → rights cut (a built one stays cut until the next conversation) */
  private readonly cuts = new Map<string, Set<DevRight>>();
  /**
   * Rights cut on what the agent built, by app window (`app:<folder>`) and by origin: they survive
   * the tab closing, so the agent does not get its rights back by relaunching the app or reopening its demo.
   */
  private readonly builtCuts = new Map<string, Set<DevRight>>();
  /** tab id → number of tools running */
  private readonly uses = new Map<string, number>();
  /** Widgets with an account whose data the user showed the agent (card « donnees-widget »), for this conversation. */
  private readonly widgetsData = new Set<string>();
  /**
   * Site apps the user opened to the agent (pages and memory), for this conversation, and the hash of their
   * declaration when the card was shown (`empreinteLectureSite`; null if the browser gives none).
   */
  private readonly sitesRead = new Map<string, string | null>();
  /** Withdrawals of the read grant per app (deletions): a card posted before one of them grants nothing. */
  private readonly siteRemovals = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private conversationNumber = 0;
  private readonly portBuilt: (port: number) => boolean;

  constructor(o: { portBuilt?: (port: number) => boolean } = {}) {
    this.portBuilt = o.portBuilt ?? portDemo;
  }

  private change(): void {
    for (const callback of [...this.listeners]) callback();
  }

  private qualify(url: string): boolean {
    if (!isLocal(url)) return false;
    const port = Number(new URL(url).port);
    return port > 0 && this.portBuilt(port);
  }

  private add<T>(m: Map<string, Set<T>>, id: string, v: T): void {
    const s = m.get(id) ?? new Set<T>();
    s.add(v);
    m.set(id, s);
  }

  private forget(id: string): void {
    this.permissions.delete(id);
    this.builtTabs.delete(id);
    this.rights.delete(id);
    this.denial.delete(id);
    this.cuts.delete(id);
    this.uses.delete(id);
  }

  /** Number of the current conversation: changes on every `reinitialiser()`. A reply from a past conversation is worth nothing. */
  get conversation(): number {
    return this.conversationNumber;
  }

  /** Subscription to changes; returns the unsubscribe. */
  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => void this.listeners.delete(callback);
  }

  /** Marks the tab as built by the agent (app window, or local demo on an agent port). */
  built(o: TabInfo): void {
    const org = origin(o.url);
    // A site app is never what the agent built (no rights by default), even served locally.
    if (!org || o.site !== undefined || !(o.app || this.qualify(o.url))) return;
    if (this.builtTabs.get(o.id) === org) return;
    this.builtTabs.set(o.id, org);
    this.change();
  }

  isBuilt(o: TabInfo): boolean {
    const org = origin(o.url);
    return org !== null && this.builtTabs.get(o.id) === org;
  }

  /** Keys under which a cut on a built one is kept: the app window, and the origin. */
  private builtKeys(id: string, org: string): string[] {
    return id.startsWith("app:") ? [id, org] : [org];
  }

  private isCutBuilt(id: string, org: string, d: DevRight): boolean {
    return this.cuts.get(id)?.has(d) === true || this.builtKeys(id, org).some((c) => this.builtCuts.get(c)?.has(d));
  }

  private rightsOf(id: string, org: string | null, built: boolean): DevRight[] {
    if (!org) return [];
    const grants = this.rights.get(id);
    return DEV_RIGHTS.filter(
      (d) => (grants?.origin === org && grants.list.has(d)) || (built && !this.isCutBuilt(id, org, d)),
    );
  }

  /** Development tool rights valid now for this tab; none on a site app without its grant. */
  devRights(o: TabInfo): DevRight[] {
    if (o.site !== undefined && !this.grantedSiteRead(o.site, o.hash)) return [];
    return this.rightsOf(o.id, origin(o.url), this.isBuilt(o));
  }

  /** The user ticked `accordes` and left `refuses`: the latter are no longer askable until the user's next message. */
  grantDev(o: TabInfo, grants: DevRight[], refuses: DevRight[]): void {
    const org = origin(o.url);
    if (org) {
      const current = this.rights.get(o.id);
      const list = current?.origin === org ? current.list : new Set<DevRight>();
      for (const d of grants) {
        list.add(d);
        this.cuts.get(o.id)?.delete(d);
        for (const c of this.builtKeys(o.id, org)) this.builtCuts.get(c)?.delete(d);
      }
      this.rights.set(o.id, { origin: org, list: list });
    }
    for (const d of refuses) this.add(this.denial, o.id, d);
    this.change();
  }

  canAsk(id: string, d: DevRight): boolean {
    return !this.denial.get(id)?.has(d);
  }

  /** Cuts one right, or all (read included) if `d` is absent. */
  cut(id: string, d?: DevRight): void {
    const targets = d ? [d] : DEV_RIGHTS;
    const built = this.builtTabs.get(id);
    for (const c of targets) {
      this.rights.get(id)?.list.delete(c);
      this.add(this.cuts, id, c);
      if (built) for (const key of this.builtKeys(id, built)) this.add(this.builtCuts, key, c);
    }
    if (!d) this.permissions.delete(id);
    this.change();
  }

  /** A tool starts (`true`) or ends (`false`) on the tab: drives the indicator's pulse. */
  use(id: string, active: boolean): void {
    const n = Math.max(0, (this.uses.get(id) ?? 0) + (active ? 1 : -1));
    if (n) this.uses.set(id, n);
    else this.uses.delete(id);
    this.change();
  }

  /** Tabs on which the agent has read access, a right, or a running tool. */
  state(): Record<string, TabAccessState> {
    const ids = new Set([...this.permissions.keys(), ...this.builtTabs.keys(), ...this.rights.keys(), ...this.uses.keys()]);
    const r: Record<string, TabAccessState> = {};
    for (const id of ids) {
      const built = this.builtTabs.has(id);
      const reading = this.permissions.has(id);
      const rights = this.rightsOf(id, this.rights.get(id)?.origin ?? this.builtTabs.get(id) ?? null, built);
      const running = this.uses.has(id);
      if (reading || rights.length || running) r[id] = { read: reading, rights: rights, built: built, running: running };
    }
    return r;
  }

  private allow(o: TabInfo): boolean {
    // A site app window only opens through the app's grant (accorderLectureSite), never through an origin.
    if (o.site !== undefined) return false;
    const org = origin(o.url);
    if (!org || this.permissions.get(o.id) === org) return false;
    this.permissions.set(o.id, org);
    return true;
  }

  /** The user authorized reading: the badge follows. */
  grant(o: TabInfo): void {
    if (this.allow(o)) this.change();
  }

  userInteraction(o: TabInfo): void {
    this.denial.clear();
    this.allow(o);
    this.change();
  }

  tabOpenedByAgent(o: TabInfo): void {
    // Only what the agent serves (its app ports, its app windows): another local port is the user's (a dev
    // server, an admin page) and asks like any site.
    if (this.qualify(o.url) || (o.app && isLocal(o.url))) this.allow(o);
    this.built(o);
    this.change();
  }

  /** The agent navigated a tab it had access to itself: access follows on the same site or to one of its apps. */
  navigationByAgent(id: string, url: string): void {
    const org = origin(url);
    this.leaveOrigin(id, org);
    if (org && this.qualify(url)) this.builtTabs.set(id, org);
    if (this.permissions.has(id)) {
      if (org && (org === this.permissions.get(id) || this.qualify(url))) this.permissions.set(id, org);
      else this.permissions.delete(id);
    }
    this.change();
  }

  /** Development rights and the « built » mark do not survive an origin change. */
  private leaveOrigin(id: string, org: string | null): void {
    if (this.rights.get(id)?.origin !== org) this.rights.delete(id);
    if (this.builtTabs.get(id) !== org) this.builtTabs.delete(id);
  }

  /** Navigation done by the user: changing site removes the authorization. */
  tabNavigated(id: string, url: string): void {
    const org = origin(url);
    if (this.permissions.get(id) !== org) this.permissions.delete(id);
    this.leaveOrigin(id, org);
    this.change();
  }

  tabClosed(id: string): void {
    this.forget(id);
    this.change();
  }

  /**
   * A site app (`o.site`) is read only with its grant, whatever the origin of its page: an
   * authorization given to a tab of the same domain does not open it.
   */
  canRead(o: TabInfo): boolean {
    if (o.site !== undefined) return this.grantedSiteRead(o.site, o.hash);
    const org = origin(o.url);
    return org !== null && this.permissions.get(o.id) === org;
  }

  /** The user shows the agent the data of this widget with an account, until the next conversation. */
  grantWidgetData(id: string): void {
    this.widgetsData.add(id);
    this.change();
  }

  widgetDataGranted(id: string): boolean {
    return this.widgetsData.has(id);
  }

  /** As for a widget, with a separate key: granting an action's results does not grant those of a widget of the same name. */
  grantActionData(id: string): void {
    this.widgetsData.add(`action:${id}`);
    this.change();
  }

  actionDataGranted(id: string): boolean {
    return this.widgetsData.has(`action:${id}`);
  }

  /** The user shows the agent their history and bookmarks (card « donnees-widget », kind history), until the next conversation. */
  grantHistory(): void {
    this.widgetsData.add("history:");
    this.change();
  }

  historyGranted(): boolean {
    return this.widgetsData.has("history:");
  }

  /** The user lets the agent open a web address it composed, outside a search, until the next conversation. */
  grantAddress(url: string): void {
    this.widgetsData.add(`address:${url}`);
    this.change();
  }

  addressGranted(url: string): boolean {
    return this.widgetsData.has(`address:${url}`);
  }

  /**
   * The user opens the site app `id` to the agent (its pages and memory), until the next conversation, as
   * the card showed it (`empreinte` of its declaration): a different hash afterwards does not count.
   */
  grantSiteRead(id: string, hash?: string): void {
    const e = hash ?? null;
    if (this.sitesRead.has(id) && this.sitesRead.get(id) === e) return;
    this.sitesRead.set(id, e);
    this.change();
  }

  /** Does the app's read grant hold, for the declaration hash `empreinte` (today's)? */
  grantedSiteRead(id: string, hash?: string): boolean {
    return this.sitesRead.has(id) && this.sitesRead.get(id) === (hash ?? null);
  }

  /**
   * The site app is deleted: its read grant lapses, and its cards still pending (all conversations)
   * are withdrawn and count as denials. An app recreated with the same id asks for the card again.
   */
  removeSiteRead(id: string): void {
    this.sitesRead.delete(id);
    this.siteRemovals.set(id, this.siteReadRemovals(id) + 1);
    this.change();
  }

  /** Number of withdrawals of the app's read grant: a card reads it when posted. */
  siteReadRemovals(id: string): number {
    return this.siteRemovals.get(id) ?? 0;
  }

  /** New conversation: no more authorizations, denials or cuts. The « built » ones stay: they belong to the tab. */
  reset(): void {
    this.permissions.clear();
    this.rights.clear();
    this.denial.clear();
    this.cuts.clear();
    this.builtCuts.clear();
    this.widgetsData.clear();
    this.sitesRead.clear();
    this.conversationNumber++;
    this.change();
  }
}
