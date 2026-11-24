import type { DevRight, FillRemember, FillRow, TabInfo } from "../shims/kernel";
import type { ExtensionCard, GrantResponse } from "../../shared/extensions";
import type { Decision, PendingRequest, WindowId, TabId, Outcome, Permission } from "../../shared/model";
import { format } from "../../shared/i18n";
import { SCHEMA_SITE } from "../../shared/sites";
import { passportName, siteOf } from "../../shared/model";
import { waitForRights, waitForOutcome, waitForResponse, QUESTION_DELAY_MS, allowedDecision, activeTabOf, originOf, staleQuestion, staleSiteQuestion } from "../../core/agent/bridge";
import type { SitePermission } from "../store/site-permissions";
import type { Store } from "../store/store";

type Listener = (pending: PendingRequest[]) => void;
/**
 * The fill card as Firefox gets it: the saved logins' usernames stay in the host (`loginsRef`), only their count comes;
 * so do the passport values a row offers (`choices`: a reference and a masked display, ruling F10).
 */
export type FillCard = {
  name: string;
  field: string;
  where: string;
  touchId: boolean;
  labels: string[];
  loginCount?: number;
  loginsRef?: string;
  agent: string;
  danger?: string;
  passportProfile?: string;
  /** Fill by kind: the tab's passport profile. */
  profile?: string;
  /** The kernel's rows, never a choice's value. */
  rows?: (Omit<FillRow, "choices"> & { choices?: Omit<NonNullable<FillRow["choices"]>[number], "value">[] })[];
  /** « Retenir ce site » (task 13b): the rows (a kind row's choice) whose entry may remember the site, by seal and entry. */
  remember?: FillRemember[];
};
/** A ticked « Retenir ce site »: the seal whose write adds its site to that entry (chrome/agent/fill.ts). */
export type RememberedSite = Pick<FillRemember, "seal" | "profile" | "id">;
/**
 * `rights`: those ticked on a dev tools card; `login`: the saved login chosen on a fill card; `picks`: its choice per row;
 * `remember`: the rows whose « Retenir ce site » is ticked.
 */
type Reply = (d: Outcome, rights?: DevRight[], login?: number, picks?: (string | null)[], remember?: number[]) => void;
/** The scheme of a widget page's address. */
export const SCHEMA_WIDGET = "ressac-widget";

/** The agent's « lire l'onglet » and extension grant cards waiting for the user. */
export class Questions {
  private readonly open = new Map<string, { request: PendingRequest; reply: Reply }>();
  private readonly listeners = new Set<Listener>();

  /**
   * `openSites`: the site app windows open now (`sites.forAgent`), for the questions on `site:<id>`; `openApps`: the agent
   * app windows (`apps.forAgent`), for those on `app:<dossier>`; `reauth`: Touch ID after a masking card's « Oui »
   * (chrome/agent/reauth.ts), false by default.
   */
  constructor(
    private readonly store: Store,
    private readonly openSites: () => { id: string; url: string }[] = () => [],
    private readonly openApps: () => { folder: string; url: string }[] = () => [],
    private readonly reauth: (reason: string) => Promise<boolean> = async () => false,
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
  askAddress(o: { url: string; reason: string; agent: string; danger?: string; found?: true }, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const fields = { tabId: null, windowId: windowId, origin: o.url, permissions: ["agent-address" as const], title: o.url, reason: o.reason, agent: o.agent, ...(o.danger ? { danger: o.danger } : {}), ...(o.found === true ? { found: true as const } : {}) };
    return waitForResponse((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /** Touch ID with the reason shown by macOS; any failure is a no, and so is a card taken down meanwhile (`signal`). */
  private async confirmed(id: string, args: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
    const ok = await this.reauth(format(this.store.state.locale, id, args)).catch(() => false);
    return ok === true && !signal?.aborted;
  }

  /** The reveal card (spec § 8): « Montrer », then Touch ID; no on a refusal, after QUESTION_DELAY_MS or on `signal`. */
  async askReveal(o: { name: string; reason: string; agent: string; text: string; label: string }, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const fields = { tabId: null, windowId: windowId, origin: "ressac://mask", permissions: ["mask-reveal" as const], reason: o.reason, agent: o.agent, mask: { text: o.text, name: o.name, labels: [o.label] } };
    return (await waitForResponse((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal)) && this.confirmed("chrome-mask-reauth-reveal", { name: o.name }, signal);
  }

  /** The alert for a label the agent sends (never its value): Refuser is the default, no Touch ID. */
  askLabelAlert(o: { name: string; destination: string; text: string }, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const fields = { tabId: null, windowId: windowId, origin: o.destination, permissions: ["mask-label-alert" as const], mask: { text: o.text, name: o.name } };
    return waitForResponse((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal);
  }

  /**
   * The fill card: « Remplir », then Touch ID when `touchId`; `login`: the chosen saved login, if one of the list; `picks`:
   * per row, the passport entry chosen among its `choices` (its only one by default), null for a row without.
   */
  async askFill(o: FillCard, windowId: WindowId, signal?: AbortSignal): Promise<{ yes: boolean; login?: number; picks?: (string | null)[]; remember?: RememberedSite[] }> {
    const count = o.loginCount ?? 0;
    const say = (id: string, args: Record<string, string | number>) => format(this.store.state.locale, id, args);
    const site = siteOf(o.where);
    const rows: NonNullable<PendingRequest["mask"]>["rows"] = o.rows?.map((r) => ({
      line: say("chrome-mask-fill-row", { field: r.field, name: r.name }),
      ...(!r.choices ? {} : r.choices.length ? { choices: r.choices.map((c) => ({ ref: c.ref, shown: c.shown })) } : { missing: o.profile === undefined ? say("chrome-mask-fill-no-passport", {}) : say("chrome-mask-fill-missing", { kind: r.kind ?? "" }) }),
    }));
    const passport = rows ? { text: rows.length === 1 ? say("chrome-mask-fill-kind", { name: o.name, site }) : say("chrome-mask-fill-rows", { n: rows.length, site }), rows } : {};
    const note = o.passportProfile !== undefined ? { note: say("chrome-mask-fill-other-profile", { profile: passportName(this.store.state.spaces, o.passportProfile, format(this.store.state.locale, "agent-mask-passport-no-space")) }) } : {};
    const open = o.passportProfile ?? o.profile;
    // The card gets each box's row and text only; the entry stays here.
    const boxes = (o.remember ?? []).map((r) => ({ row: r.row, ...(r.choice !== undefined ? { choice: r.choice } : {}), text: say("chrome-mask-fill-remember", { site, name: o.rows?.[r.row]?.name ?? o.name }) }));
    const mask = { name: o.name, field: o.field, where: o.where, labels: o.labels, ...(count > 0 ? { loginCount: count, ...(o.loginsRef ? { loginsRef: o.loginsRef } : {}) } : {}), ...passport, ...note, ...(open !== undefined ? { profile: open } : {}), ...(boxes.length ? { remember: boxes } : {}) };
    const fields = { tabId: null, windowId: windowId, origin: o.where, permissions: ["mask-fill" as const], agent: o.agent, mask, ...(o.danger ? { danger: o.danger } : {}) };
    let login: number | undefined;
    let picks: (string | null)[] | undefined;
    let ticked: number[] | undefined;
    const outcome = await waitForOutcome((reply) => this.post(fields, (d, _rights, l, p, r) => ((login = l), (picks = p), (ticked = r), reply(d))), QUESTION_DELAY_MS, signal);
    // A kind with nothing to pick only refuses, Touch ID untouched: the agent gets the refusal text either way (design § 7, point 4).
    if (outcome !== "allow" || rows?.some((r) => r.missing) || (o.touchId && !(await this.confirmed("chrome-mask-reauth-fill", { name: o.name, where: o.where }, signal)))) return { yes: false };
    const chosen = Number.isInteger(login) && login! >= 0 && login! < count ? login : undefined;
    // Complete for the kernel: a pick off its row's choices is none, and a row with one choice takes it.
    const settled = rows?.map((r, i) => r.choices?.find((c) => c.ref === picks?.[i])?.ref ?? (r.choices?.length === 1 ? r.choices[0]!.ref : null));
    // A ticked box counts for its row's settled entry only: another pick has no box of its own.
    const remember = (o.remember ?? []).filter((r) => ticked?.includes(r.row) && (r.choice === undefined || r.choice === settled?.[r.row])).map(({ seal, profile, id }) => ({ seal, profile, id }));
    return { yes: true, ...(chosen !== undefined ? { login: chosen } : {}), ...(settled ? { picks: settled } : {}), ...(remember.length ? { remember } : {}) };
  }

  /** The dev tools unlock of a tab that shows the user's data: « Débloquer », then Touch ID; falls with its tab's site. */
  async askDevUnlock(o: TabInfo, d: { agent: string; text: string }, windowId: WindowId, signal?: AbortSignal): Promise<boolean> {
    const tabId = activeTabOf(this.store.state, windowId)?.id ?? null;
    const fields = { tabId: tabId, windowId: windowId, origin: originOf(o.url), permissions: ["mask-devtools" as const], title: o.title, target: o.id, agent: d.agent, mask: { text: d.text } };
    if (this.stale({ id: "", ...fields })) return false;
    return (await waitForResponse((reply) => this.post(fields, reply), QUESTION_DELAY_MS, signal)) && this.confirmed("chrome-mask-reauth-devtools", { site: fields.origin }, signal);
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

  private post(fields: Omit<PendingRequest, "id">, reply: Reply): () => void {
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

  /**
   * `rights`: those ticked on a dev tools card; `o.login`, `o.picks`: the saved login and passport entries chosen on a fill
   * card; `o.remember`: its rows ticked « Retenir ce site », kept only from the card's own window (`o.window`).
   */
  answer(id: string, d: Decision, o?: { confirmed?: boolean; login?: number; picks?: (string | null)[]; remember?: number[]; window?: WindowId }, rights?: DevRight[]): void {
    const q = this.open.get(id);
    if (!q) return;
    this.open.delete(id);
    // Copied into this realm: the UI's array dies with its document.
    q.reply(
      allowedDecision(q.request, d, o?.confirmed),
      rights && (Array.from(rights, String) as DevRight[]),
      o?.login === undefined ? undefined : Number(o.login),
      o?.picks && Array.from(o.picks, (p) => (typeof p === "string" ? p : null)),
      o?.remember && o.window === q.request.windowId ? Array.from(o.remember, Number) : undefined,
    );
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
