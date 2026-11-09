import { isIP } from "../shims/net";
import { localUrl } from "../shims/noyau";

const TEST_PUBLIC = "WEBAIOS_TEST_ADRESSES_PUBLIQUES";

/**
 * Addresses e2e tests serve their "public" pages from (comma separated). Firefox honours them only under automation:
 * Cu.isInAutomation, or Marionette running (the e2e tests: isInAutomation also needs MOZ_DISABLE_NONLOCAL_CONNECTIONS,
 * which crashes on Firefox's own update checks). Remote control by Marionette already gives the browser away.
 */
const automated = () => Cu.isInAutomation || Cc["@mozilla.org/remote/marionette;1"].getService(Ci.nsIMarionette).running;
function testPublic(): Set<string> {
  const raw: string =
    typeof Services !== "undefined" ? (automated() ? Services.env.get(TEST_PUBLIC) : "") : ((globalThis as any).process?.env[TEST_PUBLIC] ?? "");
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** A local address or name from its text alone (`adresseLocale`), unless tests declared it public. */
export function localLiteral(host: string): boolean {
  return localUrl(host) && !testPublic().has(host.replace(/^\[|\]$/g, ""));
}

/**
 * The host is local by its text, or one of the addresses it resolves to is (a public name to 127.0.0.1, DNS
 * rebinding). Fails closed: a resolution that fails or gives nothing is refused too.
 */
export async function isLocalHost(host: string, resolve: (h: string) => Promise<string[]>): Promise<boolean> {
  if (localLiteral(host)) return true;
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return false; // an address is its own resolution
  const addresses = await resolve(bare).catch(() => []);
  return addresses.length === 0 || addresses.some(localLiteral);
}

/** Firefox's resolver, the one the connection uses (same cache, same overrides). */
function resolveDns(originAttributes: object) {
  return (host: string) =>
    new Promise<string[]>((ok) => {
      Services.dns.asyncResolve(
        host,
        Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
        0,
        null,
        {
          onLookupComplete(_request: unknown, record: any, status: number) {
            if (!Components.isSuccessCode(status)) return ok([]); // refused by isLocalHost
            const r = record.QueryInterface(Ci.nsIDNSAddrRecord);
            const all: string[] = [];
            while (r.hasMore()) all.push(r.getNextAddrAsString());
            ok(all);
          },
        },
        Services.tm.mainThread,
        originAttributes,
      );
    });
}

interface Watch {
  allowLocal: boolean;
  allowTop: (url: string) => boolean;
  onBlocked: (url: string) => void;
}
/**
 * Reads' <browser>s by browserId. A finished read keeps a `null` entry, which still guards local addresses: requests
 * sent while its page unloads (a pagehide beacon) come after it closed. One number per read, never removed.
 */
const browsers = new Map<number, Watch | null>();
/** Private containers of public reads: guarded for good, so a service worker outliving its read stays guarded. */
const containers = new Set<number>();
let observing = false;

/**
 * Before any request connects (http-on-modify-request): the page, each redirect hop (a new channel), frames,
 * images, fetch, beacons, workers. A request is ours when its channel's browserId is a read's <browser>, or when
 * its container is a reading container. A top-level document a running read's `allowTop` refuses is cancelled and
 * reported. Unless the running read has `allowLocal`, the request waits for its host's resolution and is cancelled
 * if an address is local, or if resolution fails.
 * shortcut: preconnects, Alt-Svc and WebRTC never reach http-on-modify-request, so they are not guarded; upgrade
 * if a read must never open a socket to the local network at all.
 * shortcut: a service worker of a login profile's container is not guarded (the container is the user's tabs' too),
 * upgrade if profile reads go untrusted.
 */
const observer = {
  observe(subject: any) {
    const ch = subject.QueryInterface(Ci.nsIHttpChannel);
    const li = ch.loadInfo;
    const browserId = ch.browserId || (li.browsingContext ?? li.workerAssociatedBrowsingContext)?.browserId;
    const w = browsers.get(browserId);
    if (w === undefined && !containers.has(li.originAttributes.userContextId)) return;
    const url: string = ch.URI.spec;
    if (w && li.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT && !w.allowTop(url)) {
      ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED);
      return w.onBlocked(url);
    }
    if (w?.allowLocal) return;
    ch.suspend();
    isLocalHost(ch.URI.host, resolveDns(li.originAttributes))
      .then(
        (local) => local && ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED),
        () => ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED),
      )
      .finally(() => ch.resume());
  },
};
function observe(): void {
  if (observing) return;
  observing = true;
  Services.obs.addObserver(observer, "http-on-modify-request");
}

/** Guards every request of this reading container from now on. */
export function guardContainer(userContextId: number): void {
  containers.add(userContextId);
  observe();
}

/** Guards the requests of one read's <browser>; the returned function ends the read's own checks, not the guard. */
export function watchReading(browser: any, w: Watch): () => void {
  const id: number = browser.browserId;
  browsers.set(id, w);
  observe();
  return () => browsers.set(id, null);
}
