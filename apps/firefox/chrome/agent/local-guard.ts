import { adresseLocale } from "../shims/noyau";

const TEST_PUBLIC = "WEBAIOS_TEST_ADRESSES_PUBLIQUES";

/** Addresses e2e tests serve their "public" pages from (comma separated): never set outside tests. */
function testPublic(): Set<string> {
  const raw: string = typeof Services !== "undefined" ? Services.env.get(TEST_PUBLIC) : ((globalThis as any).process?.env[TEST_PUBLIC] ?? "");
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** A local address or name from its text alone (`adresseLocale`), unless tests declared it public. */
export function localLiteral(host: string): boolean {
  return adresseLocale(host) && !testPublic().has(host.replace(/^\[|\]$/g, ""));
}

/** The host is local by its text, or one of the addresses it resolves to is (a public name to 127.0.0.1, DNS rebinding). */
export async function isLocalHost(host: string, resolve: (h: string) => Promise<string[]>): Promise<boolean> {
  if (localLiteral(host)) return true;
  // A failed resolution is not local: the connection fails by itself.
  const addresses = await resolve(host.replace(/^\[|\]$/g, "")).catch(() => []);
  return addresses.some(localLiteral);
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
            if (!Components.isSuccessCode(status)) return ok([]);
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

/**
 * Guards every HTTP request of one invisible read, before it connects: the page, each redirect hop (a new channel),
 * frames, images, fetch. A top-level document `allowTop` refuses is cancelled and reported to `onBlocked`. Unless
 * `allowLocal`, each request waits for its host's resolution and is cancelled if an address is local.
 * Requests are matched by the <browser>'s browserId, or, without a browsing context (a service worker), by the
 * read's own `userContextId` when it has a private one.
 * shortcut: a service worker of a login profile's container is not guarded, upgrade if profile reads go untrusted.
 */
export function watchReading(
  browser: any,
  o: { allowLocal: boolean; userContextId?: number; allowTop: (url: string) => boolean; onBlocked: (url: string) => void },
): () => void {
  const observer = {
    observe(subject: any) {
      const ch = subject.QueryInterface(Ci.nsIHttpChannel);
      const li = ch.loadInfo;
      const bc = li.browsingContext ?? li.workerAssociatedBrowsingContext;
      if (bc ? bc.browserId !== browser.browserId : o.userContextId === undefined || li.originAttributes.userContextId !== o.userContextId) return;
      const url: string = ch.URI.spec;
      if (li.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT && !o.allowTop(url)) {
        ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED);
        return o.onBlocked(url);
      }
      if (o.allowLocal) return;
      ch.suspend();
      isLocalHost(ch.URI.host, resolveDns(li.originAttributes))
        .then(
          (local) => local && ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED),
          () => ch.cancel(Cr.NS_ERROR_CONNECTION_REFUSED),
        )
        .finally(() => ch.resume());
    },
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  return () => Services.obs.removeObserver(observer, "http-on-modify-request");
}
