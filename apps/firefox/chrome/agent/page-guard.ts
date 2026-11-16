// Pages the agent serves on its container's ports run code the agent wrote, maybe from what it read: they reach only
// local addresses and a few known CDNs, so that such a page cannot send what it holds to the web.
import { localLiteral } from "./local-guard";

const CDN_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com"]);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A page on a port of the agent's range, whatever its host: a public name can resolve to 127.0.0.1 (fails closed). */
function agentPage(url: string, [min, max]: [number, number]): boolean {
  const u = parse(url);
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return false;
  const port = Number(u.port);
  return port >= min && port <= max;
}

/**
 * A request `to`, made while the top-level page is `from`: an agent page's requests stay local, or GET a known CDN;
 * its top-level navigation leaves only with a user activation on the page (a click, a key press).
 */
export function agentPageDecision(o: { from: string; to: string; document: boolean; gesture: boolean; method: string }, ports: [number, number]): "allow" | "cancel" {
  if (!agentPage(o.from, ports)) return "allow";
  const to = parse(o.to);
  if (!to) return "cancel";
  if (localLiteral(to.hostname)) return "allow";
  if (o.document && o.gesture) return "allow";
  return CDN_HOSTS.has(to.hostname) && o.method === "GET" ? "allow" : "cancel";
}

/** The container's ports, as the host reads them (host/host.ts defaults to 5300-5319, containerPortRange parses). */
export function agentPorts(): [number, number] {
  const m = /^(\d{4,5})-(\d{4,5})$/.exec(Services.env.get("RESSAC_CONTAINER_PORTS"));
  const [min, max] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  return min >= 1024 && max <= 65535 && min <= max ? [min, max] : [5300, 5319];
}

let observing = false;

/** A sandboxed document (a null principal) is judged by the page that created it. */
const principalSpec = (p: any): string => (p?.isNullPrincipal ? p.precursorPrincipal : p)?.spec ?? "";

/**
 * Before any request connects (http-on-modify-request). A top-level load is judged by the page that started it (its
 * triggering principal). Any other request by its own principals (a service worker has no browsing context; a beacon
 * sent on pagehide may run under the next page) and by the tab's top-level page, its address and its principal (an
 * about:blank window an agent page opened and writes into has the agent page's principal). What Ressac itself loads
 * (the system principal: the address bar, its own fetches) is never judged. The port range is read once.
 * shortcut: WebRTC is not guarded (no HTTP request); upgrade if agent pages must never open a socket to the web.
 */
export function installAgentPageGuard(ports: () => [number, number]): void {
  if (observing) return;
  observing = true;
  const range = ports();
  Services.obs.addObserver(
    {
      observe(subject: any) {
        const ch = subject.QueryInterface(Ci.nsIHttpChannel);
        const li = ch.loadInfo;
        if (li.triggeringPrincipal?.isSystemPrincipal) return;
        const document = li.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT;
        const top = (li.browsingContext ?? li.workerAssociatedBrowsingContext)?.top;
        const froms: string[] = document
          ? [principalSpec(li.triggeringPrincipal)]
          : [
              principalSpec(li.triggeringPrincipal),
              principalSpec(li.loadingPrincipal),
              top?.currentURI?.spec ?? "",
              principalSpec(top?.currentWindowGlobal?.documentPrincipal),
            ];
        const to: string = ch.URI.spec;
        const o = { to, document, gesture: li.hasValidUserGestureActivation, method: ch.requestMethod };
        if (froms.every((from) => agentPageDecision({ ...o, from }, range) === "allow")) return;
        ch.cancel(Cr.NS_ERROR_ABORT);
        console.warn("[agent-page] blocked: " + to.slice(0, 80));
      },
    },
    "http-on-modify-request",
  );
}
