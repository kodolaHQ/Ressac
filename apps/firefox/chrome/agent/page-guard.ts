// Pages the agent serves on its container's ports run code the agent wrote, maybe from what it read: they reach only
// the agent's own ports on the loopback and a few known CDNs, so that such a page cannot send what it holds to the web,
// nor through another local service (Ollama pulls a model from any registry it is given).
import { portRange } from "../shims/kernel";
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

/** The machine itself by its literal name (not a LAN address, nor `[::ffff:8.8.8.8]`, which is any IPv4 host). */
const loopback = (host: string): boolean => localLiteral(host) && (host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host));

/**
 * A request `to`, made while the top-level page is `from`: an agent page's requests stay on the agent's own ports, or GET a known CDN;
 * its top-level navigation leaves only with a user activation on the page (a click, a key press).
 */
export function agentPageDecision(o: { from: string; to: string; document: boolean; gesture: boolean; method: string }, ports: [number, number]): "allow" | "cancel" {
  if (!agentPage(o.from, ports)) return "allow";
  const to = parse(o.to);
  if (!to) return "cancel";
  if (loopback(to.hostname) && agentPage(o.to, ports)) return "allow";
  if (o.document && o.gesture) return "allow";
  return CDN_HOSTS.has(to.hostname) && o.method === "GET" ? "allow" : "cancel";
}

/** The container's ports from the variable's raw value, as the kernel reads them; unset is host/host.ts's default. */
export const agentPortRange = (raw: string): [number, number] => portRange(raw || "5300-5319");
export const agentPorts = (): [number, number] => agentPortRange(Services.env.get("RESSAC_CONTAINER_PORTS"));

let observing = false;

/** A sandboxed document (a null principal) is judged by the page that created it. */
const principalSpec = (p: any): string => (p?.isNullPrincipal ? p.precursorPrincipal : p)?.spec ?? "";

/** Whether an agent page's request must not leave (see installAgentPageGuard). */
function blocked(ch: any, range: [number, number]): boolean {
  const li = ch.loadInfo;
  if (!li || li.triggeringPrincipal?.isSystemPrincipal) return false;
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
  const o = { to: ch.URI.spec as string, document, gesture: li.hasValidUserGestureActivation, method: ch.requestMethod ?? "GET" };
  return !froms.every((from) => agentPageDecision({ ...o, from }, range) === "allow");
}

/**
 * Before any request connects (http-on-modify-request). The channel's own DNS prefetch would come first: it is off
 * (network.dns.disablePrefetch, ressac.js; e2e/agent-page-guard.e2e.ts checks no name is resolved). A top-level load is judged by the page that started it (its
 * triggering principal). Any other request by its own principals (a service worker has no browsing context; a beacon
 * sent on pagehide may run under the next page) and by the tab's top-level page, its address and its principal (an
 * about:blank window an agent page opened and writes into has the agent page's principal). What Ressac itself loads
 * (the system principal: the address bar, its own fetches) is never judged. The port range is read once.
 * A WebSocket resolves its host (WebSocketChannel::DoAdmissionDNS) before that observer, unless a proxy is set
 * (OnProxyAvailable skips the lookup): a blocked channel gets a dead proxy from a channel filter, then the cancel.
 * shortcut: WebRTC is not guarded (no HTTP request); upgrade if agent pages must never open a socket to the web.
 */
export function installAgentPageGuard(ports: () => [number, number]): void {
  if (observing) return;
  observing = true;
  const range = ports();
  const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(Ci.nsIProtocolProxyService);
  // Port 9 (discard) on the loopback: nothing listens, the connection is refused, and no name is resolved.
  const dead = pps.newProxyInfo("http", "127.0.0.1", 9, "", "", 0, 0, null);
  pps.registerChannelFilter(
    {
      QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]),
      applyFilter(ch: any, proxy: any, cb: any) {
        let out = proxy;
        try {
          if (blocked(ch.QueryInterface(Ci.nsIHttpChannel), range)) out = dead;
        } catch {
          // not an HTTP channel: nothing to judge
        }
        cb.onProxyFilterResult(out);
      },
    },
    0,
  );
  Services.obs.addObserver(
    {
      observe(subject: any) {
        const ch = subject.QueryInterface(Ci.nsIHttpChannel);
        if (!blocked(ch, range)) return;
        ch.cancel(Cr.NS_ERROR_ABORT);
        console.warn("[agent-page] blocked: " + String(ch.URI.spec).slice(0, 80));
      },
    },
    "http-on-modify-request",
  );
}
