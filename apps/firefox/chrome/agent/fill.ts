import type { FillSeal, PageField } from "../shims/kernel";
import { boundFields, FIELDS_MAX, originOf } from "../../core/agent/bridge";
import type { Choice, Seal } from "./fill-actor";

/** Seals not committed (a card refused) are dropped past this many, oldest first. */
const SEALS_MAX = 32;
const GONE = "Le champ n'est plus dans la page : relis l'onglet avec read_tab.";

type Login = { guid: string; username: string; password: string };
/** A passport entry whose « Remplissable sur » takes the seal's site once written (task 13b), and the card's window. */
export type Remember = { profile: string; id: string; window: string };
type Sealed = Seal & { tab: string; browser: any; origin: string; logins: string[]; remember?: Remember };
type Value = { text: string } | { savedLogin: "password" | "username"; login?: number } | { choice: Choice };

/** The current document `id` of the tab's browser, or null (another tab's, navigated away, closed). */
function windowIn(browser: any, id: number): any {
  const w = WindowGlobalParent.getByInnerWindowId(id);
  return w && w.isCurrentGlobal && w.browsingContext?.top === browser?.browsingContext ? w : null;
}

/** The document's origin, then each ancestor's up to the tab's top: computed here, never asked of a web process. Never empty. */
function frameChain(w: any): string[] {
  const out: string[] = [];
  for (let x = w; x; x = x.parentWindowContext) {
    const origin = x.documentPrincipal?.originNoSuffix;
    if (typeof origin !== "string" || !origin) throw new Error(GONE);
    out.push(origin);
  }
  if (!out.length) throw new Error(GONE);
  return out;
}

const bounded = (s: unknown, max: number) => (typeof s === "string" && s.length <= max ? s : null);

/**
 * `fill_field` in Firefox (spec § 5.4): the fields of a tab's documents, a seal of one, and the write behind it. The
 * seals stay here, single-use; a saved login is fetched here and goes only into the child's `fill` message.
 */
export function createFill(deps: {
  /** The tab's browser, loaded; throws as a read does (TabNotFound, PrivateTab). */
  browserOf(tab: string): Promise<any>;
  /** Opened or reached by the agent (TabInfo.agentReached; unknown counts as reached). */
  agentReached(tab: string): boolean;
  /** Firefox's saved logins of exactly this origin. */
  logins?(origin: string): Promise<Login[]>;
  /** A ticked « Retenir ce site » whose seal was just written: its tab, the seal's origin, the entry. */
  remembered?(tab: string, origin: string, r: Remember): Promise<unknown>;
}) {
  const logins = deps.logins ?? ((origin: string): Promise<Login[]> => Services.logins.searchLoginsAsync({ origin }));
  const seals = new Map<string, Sealed>();

  /** The value a saved login gives, under the kernel's rule checked again here, where the password lives. */
  const savedValue = async (s: Sealed, v: any): Promise<string | null> => {
    const kind = v?.savedLogin;
    // A username also goes into the field Firefox pairs with its form's password field (sealed: the pair is checked again at the write).
    const fits = kind === "password" ? s.type === "password" : kind === "username" && (s.autocomplete === "username" || s.role === "username");
    // Its exact origin only: every frame up to the top and the form's action on it.
    if (!fits || !s.frames.every((f) => f === s.origin) || (s.action !== null && originOf(s.action) !== s.origin)) return null;
    const guid = s.logins[Number.isInteger(v.login) ? v.login : 0];
    const login = guid === undefined ? undefined : (await logins(s.origin)).find((l) => l.guid === guid);
    return login ? (kind === "password" ? login.password : login.username) : null;
  };

  return {
    /** Every document's fields (each under a handle of its own document) and every frame's origin. */
    async fields(browser: any): Promise<{ fields: PageField[]; frameOrigins: string[] }> {
      const windows = (browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? []).map((bc: any) => bc.currentWindowGlobal).filter(Boolean);
      // A frame without the actor (about:blank, a frame going away) has no fields.
      const lists = await Promise.all(windows.map((w: any) => Promise.resolve().then(() => w.getActor("RessacFill").sendQuery("fields")).then((r) => boundFields(r, w.innerWindowId), () => [])));
      const origins = windows.map((w: any) => w.documentPrincipal?.originNoSuffix).filter((o: unknown): o is string => typeof o === "string" && !!o);
      return { fields: lists.flat().slice(0, FIELDS_MAX), frameOrigins: [...new Set<string>(origins)] };
    },

    async prepare(tab: string, handle: string): Promise<FillSeal> {
      const m = /^(\d+):(\d+)$/.exec(String(handle));
      if (!m) throw new Error(GONE);
      const browser = await deps.browserOf(tab);
      const w = windowIn(browser, Number(m[1]));
      if (!w) throw new Error(GONE);
      const n = Number(m[2]);
      const raw: any = await w.getActor("RessacFill").sendQuery("facts", { handle: n });
      const type = bounded(raw?.type, 30);
      const autocomplete = bounded(raw?.autocomplete, 100);
      const action = raw?.action === null ? null : bounded(raw?.action, 2_048);
      const placement = bounded(raw?.placement, 100);
      const label = bounded(raw?.label, 80);
      if (type === null || autocomplete === null || placement === null || label === null || (action === null && raw?.action !== null)) throw new Error(GONE);
      const partnerN = Number.isInteger(raw?.partner) && raw.partner >= 0 ? (raw.partner as number) : null;
      const role = partnerN !== null && (raw?.role === "username" || raw?.role === "password") ? (raw.role as "username" | "password") : null;
      const frames = frameChain(w);
      const origin = frames[0]!;
      // A login is looked up only where it could ever go: a login field whose frames are all on its origin.
      const own = frames.every((f) => f === origin) && (type === "password" || autocomplete === "username" || role === "username");
      const found = own ? await logins(origin) : [];
      // The login form's other field, in this same document (Firefox's form detection, in the child).
      const partner = own && role ? `${w.innerWindowId}:${partnerN}` : undefined;
      const seal = crypto.randomUUID();
      seals.set(seal, { tab, browser, innerWindowId: w.innerWindowId, handle: n, frames, action, type, autocomplete, label, placement, partner: role ? partnerN : null, role, origin, logins: found.map((l) => l.guid) });
      if (seals.size > SEALS_MAX) seals.delete(seals.keys().next().value!);
      return { seal, origin, path: String(w.documentURI?.filePath ?? "/"), frames, type, autocomplete, label, action, logins: found.map((l) => ({ username: l.username })), agentReached: deps.agentReached(tab), ...(partner ? { partner } : {}) };
    },

    /** The fill card ticked « Retenir ce site » for this seal: kept until its commit, dropped with it. */
    remember(id: string, r: Remember): void {
      const s = seals.get(String(id));
      if (s) s.remember = r;
    },

    /** `origin`: the one the kernel approved. Anything that moved since the seal answers « changed », nothing written. */
    async commit(id: string, v: Value, origin: string): Promise<"filled" | "changed"> {
      const s = seals.get(String(id));
      seals.delete(String(id));
      if (!s || s.origin !== origin) return "changed";
      if ((await deps.browserOf(s.tab).catch(() => null)) !== s.browser) return "changed";
      const value = typeof (v as any)?.text === "string" ? (v as { text: string }).text : "choice" in v ? v.choice : await savedValue(s, v);
      if (value === null) return "changed";
      // After every wait: the chain the value goes into is still the one sealed.
      const w = windowIn(s.browser, s.innerWindowId);
      let frames: string[] | null = null;
      try {
        frames = w && frameChain(w);
      } catch {}
      if (!frames || JSON.stringify(frames) !== JSON.stringify(s.frames)) return "changed";
      const seal: Seal = { innerWindowId: s.innerWindowId, handle: s.handle, frames: s.frames, action: s.action, type: s.type, autocomplete: s.autocomplete, label: s.label, placement: s.placement, partner: s.partner, role: s.role };
      const answer = await w.getActor("RessacFill").sendQuery("fill", { seal, value }).catch(() => "changed");
      if (answer !== "filled") return "changed";
      // Never awaited: the fill stands, and answers the agent the same, whatever the save does.
      if (s.remember && deps.remembered) void deps.remembered(s.tab, s.origin, s.remember).catch(() => {});
      return "filled";
    },
  };
}
