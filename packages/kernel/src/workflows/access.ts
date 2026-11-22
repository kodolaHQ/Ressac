import dns from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { ChangeHost } from "./pacing.js";
import type { ReadPage } from "./protocol.js";

// Container access to the outside, all kernel-side: verified URLs, raw fetch, page read and re-checked.

const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_DELAY_MS = 20_000;
const MAX_REDIRECTIONS = 5;

/** Web searches and open reads (without `domaines`) of a run, at most. */
export const MAX_SEARCHES = 30;
export const MAX_OPEN_READS = 100;
// The first two are copied into docker/engine/errors.mjs: the item is not run, it is not a failure.
export const SEARCHES_CAP = "Plafond de recherches atteint (30 par exécution)";
export const SEARCHES_STOPPED = "Recherches arrêtées : DuckDuckGo a refusé une recherche de cette exécution";
export const TOO_MANY_READS = "Trop de lectures dans cette exécution (100)";
export const SEARCH_UNAVAILABLE = "Recherche web indisponible";

/** A text of at most `n` characters, « … » at the end if it is cut. */
export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** The message of an exception, or its value as text. */
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Address of the machine or the local network, from its text alone (the name is not resolved: `fetch` re-checks
 * the address resolved at connection, with `lookupSansLocal`).
 */
export function localUrl(host: string): boolean {
  // « localhost. » (trailing dot) designates the same machine as « localhost ».
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/(?<!\.)\.+$/, "");
  if (!h || h === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(h)) return true;
  if (isIP(h) === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(h) === 6) {
    return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89a-f]/.test(h) || /^ff/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b:") ||
      // 6to4 and Teredo carry a v4 address inside (a private one reaches the local network): both are obsolete
      h.startsWith("2002:") || /^2001:0*:/.test(h);
  }
  return false;
}

/**
 * An address of this machine, or a global IPv6 address on the same /64 as one of its own (a neighbour on the local
 * network): public by its text, local in fact.
 */
export function onOwnNetwork(address: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  const family = isIP(a);
  if (!family) return false;
  // One list per family: Node checks a v4 address as v4-mapped v6, which `::1/64` would cover.
  const own = new BlockList();
  for (const i of Object.values(interfaces).flat()) {
    if (!i || (i.family === "IPv6") !== (family === 6)) continue;
    // The interface's own network (a public IPv4 one too: a university's), else its address alone or its IPv6 /64.
    const [ip = "", prefix] = (i.cidr ?? i.address).replace(/%[^/]*/, "").split("/");
    own.addSubnet(ip, prefix ? Number(prefix) : family === 6 ? 64 : 32, family === 6 ? "ipv6" : "ipv4");
  }
  return own.check(a, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Checks a URL requested by the harvest: http(s), no credentials, no local address, and, if `domaines` is
 * given, a host name exactly in this list. Returns the normalized URL, the one that will be read.
 */
export function checkUrl(raw: string, domains: readonly string[] | null, localUrls: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`URL invalide : ${truncate(raw, 200)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Seules les URL http(s) sont permises");
  if (u.username || u.password) throw new Error("URL avec identifiants refusée");
  // The trailing dot (« app.daily.dev. ») does not change the name: it is removed before any comparison.
  const host = u.hostname.toLowerCase().replace(/(?<!\.)\.+$/, "");
  if (domains && !domains.includes(host)) throw new Error(`Domaine non déclaré : ${host}`);
  if (!localUrls && (localUrl(host) || onOwnNetwork(host))) throw new Error(`Adresse locale refusée : ${host}`);
  return u;
}

/**
 * Resolution done at connection: a name that leads to the machine or the local network (« 127.0.0.1.nip.io », DNS
 * rebinding) is refused, even if only one of its addresses is.
 */
export const lookupWithoutLocal: LookupFunction = (host, options, callback) => {
  dns.lookup(host, { ...options, all: true }, (err, urls) => {
    if (err) return callback(err, "");
    const locale = urls.find((a) => localUrl(a.address) || onOwnNetwork(a.address));
    if (locale) return callback(new Error(`Adresse locale refusée : ${host} (${locale.address})`), "");
    if (options.all) return callback(null, urls);
    const [first] = urls;
    if (!first) return callback(new Error(`Nom introuvable : ${host}`), "");
    callback(null, first.address, first.family);
  });
};

// http(s) rather than fetch: fetch (undici) does not let us choose the resolution without the undici package.
function ask(url: URL, localUrls: boolean, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((ok, ko) => {
    const options = { signal, headers: { "user-agent": "node", accept: "*/*" }, ...(localUrls ? {} : { lookup: lookupWithoutLocal }) };
    (url.protocol === "https:" ? https : http).get(url, options, ok).on("error", ko);
  });
}

async function readBody(r: IncomingMessage): Promise<Buffer> {
  if (Number(r.headers["content-length"]) > FETCH_MAX_BYTES) {
    r.destroy();
    throw new Error("Réponse trop grande (5 Mo maximum)");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of r as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > FETCH_MAX_BYTES) {
      r.destroy();
      throw new Error("Réponse trop grande (5 Mo maximum)");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** `p`, or rejected with `signal.reason` as soon as the signal is raised (its outcome is then ignored). */
function untilSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((ok, ko) => {
    const stop = () => ko(signal.reason);
    p.then(ok, ko).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Raw fetch, without cookie or credentials; each redirect is re-checked with the same rule. `arret` raised
 * (the run is stopped): the request is abandoned and the promise rejected with `arret.reason`. `changeHost`
 * (paced read): awaited before following a redirect to another host, within the 20 s delay.
 */
export async function fetch(
  raw: string,
  format: "text" | "json",
  domains: readonly string[] | null,
  localUrls: boolean,
  stop?: AbortSignal,
  changeHost?: ChangeHost,
) {
  const delay = AbortSignal.timeout(FETCH_DELAY_MS);
  const deadline = stop ? AbortSignal.any([delay, stop]) : delay;
  let url = checkUrl(raw, domains, localUrls);
  try {
    for (let redirections = 0; ; redirections++) {
      const r = await ask(url, localUrls, deadline);
      const target = r.headers.location;
      const status = r.statusCode ?? 0;
      if (status >= 300 && status < 400 && target) {
        r.destroy();
        if (redirections >= MAX_REDIRECTIONS) throw new Error("Trop de redirections");
        const next = checkUrl(new URL(target, url).href, domains, localUrls);
        // Waiting for the other site's turn counts in the delay, and yields to the stop.
        if (changeHost && next.hostname !== url.hostname) await untilSignal(changeHost(next.hostname), deadline);
        url = next;
        continue;
      }
      if (status < 200 || status >= 300) {
        r.destroy();
        throw new Error(`HTTP ${status}`);
      }
      const text = (await readBody(r)).toString("utf8");
      if (format === "text") return text;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("La réponse n'est pas du JSON");
      }
    }
  } catch (e) {
    if (stop?.aborted) throw stop.reason;
    if (delay.aborted) throw new Error("Délai dépassé (20 s)");
    throw e;
  }
}

/** The page's final address (after redirects) must respect the same rule; otherwise its text does not go out. */
export function checkPage(page: ReadPage, domains: readonly string[] | null, localUrls: boolean): ReadPage {
  try {
    checkUrl(String(page?.url), domains, localUrls);
  } catch (e) {
    throw new Error(`Page refusée : elle a mené hors des domaines permis (${message(e)})`);
  }
  return page;
}
