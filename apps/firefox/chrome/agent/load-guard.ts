// The parent judges each hop of an agent load against the conversation lock (spec § 3, masking step 1): the kernel
// judged the address the agent asked for, a server's redirect or meta refresh can still carry the tab elsewhere.
import { LoadRefused } from "../shims/kernel";
import { originOf } from "../../core/agent/bridge";

/** An agent load waiting in a Ressac tab: its start (no fragment), where its hops may go, and its refusal. */
export type AgentLoad = { start: string; allow: string[]; started: boolean; refuse: (hop: string) => void };
/**
 * A top-level document request of that tab: its address (no fragment); whether a redirect made it (internal ones
 * included: an HSTS or HTTPS-First upgrade, a service worker), or a meta refresh; whether a user activation started it.
 */
export type Hop = { url: string; redirected: boolean; metaRefresh: boolean; gesture: boolean };

/**
 * What the guard does with a top-level document request of a tab that has an agent load:
 * - a fresh request for the start is the load itself, once;
 * - a fresh request with a user activation (a click, a key) is the user's: the agent load is over;
 * - anything else is a hop, the server's or the page's choice (a redirect, a meta refresh, a script's `location`
 *   without activation, an open redirect): it passes on the start's origin or an allowed one (an allowed origin's
 *   https upgrade included), else it is cancelled.
 * A meta refresh fires after the page's STATE_STOP (nsDocShell::EndPageLoad → RefreshURIFromQueue), so the load is not
 * over at STATE_STOP: it ends at a user-activated load, a typed address or another agent load.
 */
export function judgeHop(load: Pick<AgentLoad, "start" | "allow" | "started">, hop: Hop): "start" | "pass" | "cancel" | "end" {
  if (!hop.redirected && !hop.metaRefresh) {
    if (!load.started && hop.url === load.start) return "start";
    if (hop.gesture) return "end";
  }
  const allowed = new Set([originOf(load.start), ...load.allow]);
  const to = originOf(hop.url);
  return allowed.has(to) || (to.startsWith("https://") && allowed.has(to.replace(/^https:/, "http:"))) ? "pass" : "cancel";
}

/**
 * A channel's browsing context → its top's <browser> → that browser's XUL tab → its Ressac tab id (`idAttr`). Called
 * only while an agent load waits, so a document that cannot be named (no embedder, window or gBrowser) throws and the
 * guard cancels it. null: a window that is not Ressac's, or a parking tab: nothing to judge.
 */
export function tabIdOf(bc: any, idAttr: string, parkingAttr: string): string | null {
  const browser = bc.top?.embedderElement;
  // Not ownerGlobal: undefined from the store module (chrome/store/sites.ts, gone()), so no tab was ever named.
  const win = browser?.ownerDocument?.defaultView;
  if (!win?.gBrowser) throw new Error("unnamed document");
  const tab = win.gBrowser.getTabForBrowser(browser);
  const id = tab?.getAttribute(idAttr);
  if (id) return id;
  if (tab && win.ressacWindow && !tab.hasAttribute(parkingAttr)) throw new Error("unnamed tab");
  return null;
}

/** By Ressac tab id: a tab without its XUL tab yet is judged when TabSync loads it. */
const loads = new Map<string, AgentLoad>();
let installed = false;

/**
 * Registers the agent's next load of `url` in Ressac tab `tabId`, before it starts, in place of any earlier one. With
 * `allow`, a hop of it off the start's origin and `allow` is cancelled and the promise rejects with LoadRefused; it
 * never resolves. null: nothing judged (no lock, no handle).
 */
export function expectAgentLoad(tabId: string, url: string, allow: string[] | null): Promise<never> {
  loads.delete(tabId);
  if (allow === null) return new Promise<never>(() => {});
  // Fails closed: a restricted load never starts without the guard.
  if (!installed) throw new Error("load guard not installed");
  const start: string = Services.io.newURI(url).specIgnoringRef;
  return new Promise<never>((_, reject) => {
    loads.set(tabId, { start, allow: [...allow], started: false, refuse: (hop) => reject(new LoadRefused(hop)) });
  });
}

/** The user takes the tab (an address typed): what follows is theirs. */
export const forgetAgentLoad = (tabId: string): void => void loads.delete(tabId);

/** Drops the records of tabs `keep` refuses (closed, or their window gone): a stale one would keep the guard armed. */
export function pruneAgentLoads(keep: (tabId: string) => boolean): void {
  for (const id of loads.keys()) if (!keep(id)) loads.delete(id);
}

/**
 * Before any request connects (http-on-modify-request; each redirect hop is a new channel, its loadInfo carrying the
 * redirect chain, internal redirects in redirectChainIncludingInternalRedirects only; a meta refresh has
 * loadInfo.isMetaRefresh). Only a top-level TYPE_DOCUMENT request of a browser whose Ressac tab (`lookupTab`, from the
 * browsing context) has an agent load is judged (judgeHop). A cancelled hop is aborted (no error page: the tab stays
 * where it was) and rejects the load. Fails closed while an agent load waits: a document request with no browsing
 * context, a tab `lookupTab` cannot name (it throws), or any error while judging cancels the request. Logs never carry an address.
 */
export function installAgentLoadGuard(lookupTab: (bc: any) => string | null): void {
  if (installed) return;
  installed = true;
  Services.obs.addObserver(
    {
      observe(subject: any) {
        let ch: any;
        let tabId: string | null = null;
        let load: AgentLoad | undefined;
        try {
          ch = subject.QueryInterface(Ci.nsIHttpChannel);
          const li = ch.loadInfo;
          if (!loads.size || !li || li.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT) return;
          const bc = li.browsingContext;
          if (!bc) throw new Error("no browsing context");
          if (bc.parent) return;
          tabId = lookupTab(bc);
          load = tabId === null ? undefined : loads.get(tabId);
          if (!load) return;
          const d = judgeHop(load, {
            url: ch.URI.specIgnoringRef,
            redirected: li.redirectChainIncludingInternalRedirects.length > 0,
            metaRefresh: !!li.isMetaRefresh,
            gesture: !!li.hasValidUserGestureActivation,
          });
          if (d === "start") load.started = true;
          else if (d === "end") loads.delete(tabId!);
          else if (d === "cancel") {
            loads.delete(tabId!);
            ch.cancel(Cr.NS_ERROR_ABORT);
            load.refuse(ch.URI.spec);
          }
        } catch (e) {
          if (ch && loads.size) ch.cancel(Cr.NS_ERROR_ABORT);
          if (load) {
            loads.delete(tabId!);
            load.refuse("");
          }
          console.error("[load-guard] a request could not be judged:", (e as Error)?.name);
        }
      },
    },
    "http-on-modify-request",
  );
}
