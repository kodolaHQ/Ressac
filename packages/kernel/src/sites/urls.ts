import { domainToASCII } from "node:url";
import { localUrl } from "../workflows/access.js";
import { trueDomain, type DeclarationSite, type Tweak } from "./schemas.js";

/** The app's domains, never in site.json: the current one, and the old ones that must still be recognized. */
export type UrlState = { current: string; previous: string[]; since: string | null };

const VALID_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** Lowercase, trailing dot removed, Unicode converted to ASCII (punycode); "" if the name is invalid. */
const clean = (h: string) => {
  const b = h.toLowerCase().replace(/\.+$/, "");
  if (/[\/@:?#\s%\\*\[\]]/.test(b)) return "";
  const a = /^[a-z0-9.-]*$/.test(b) ? b : domainToASCII(b);
  return VALID_HOST.test(a) ? a : "";
};

/** https, or (tests) http of a local host; never credentials. */
function acceptedSchema(u: URL, localUrls: boolean): boolean {
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && localUrls && localUrl(u.hostname);
}

/** Exact or subdomain, case-insensitive, trailing dot removed. */
export function hostInSite(host: string, domains: readonly string[]): boolean {
  const h = clean(host);
  if (!h) return false;
  return domains.some((d) => {
    const n = clean(d);
    return n !== "" && (h === n || h.endsWith(`.${n}`));
  });
}

export function effectiveDomains(d: DeclarationSite, e: UrlState | null): string[] {
  const all = [...d.domains, ...(e ? [...e.previous, e.current] : [])].map(clean);
  return [...new Set(all)];
}

/** The declared address, whose host is replaced by the current address when the site changed domain. */
export function startUrl(d: DeclarationSite, e: UrlState | null): string {
  if (!e) return d.url;
  let u: URL;
  try {
    u = new URL(d.url);
  } catch {
    return d.url;
  }
  if (hostInSite(u.hostname, [e.current])) return d.url;
  u.hostname = e.current;
  return u.href;
}

function analyze(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Path + query (without #) if the host is in the site, otherwise null. */
export function relativeUrl(url: string, domains: readonly string[]): string | null {
  const u = analyze(url);
  if (!u || !hostInSite(u.hostname, domains)) return null;
  return u.pathname + u.search;
}

/**
 * A relative address (« /… », never « //… ») or absolute on a domain of the site, rendered on the current domain with the
 * scheme and port of the start address. Everything else is refused.
 */
export function urlOnDomain(
  url: string,
  current: string,
  domains: readonly string[],
  start: string,
  o: { localAddresses: boolean },
): string | null {
  const base = analyze(start);
  if (!base) return null;
  // An invalid `actuel` leaves the start host.
  const n = clean(current);
  const valid = VALID_HOST.test(n) && (o.localAddresses || !localUrl(n));
  const outputHost = valid ? n : base.hostname;
  let u: URL;
  if (url.startsWith("/")) {
    if (url.startsWith("//") || url.startsWith("/\\")) return null;
    const r = analyze(`${base.protocol}//${base.host}${url}`);
    if (!r || clean(r.hostname) !== clean(base.hostname)) return null;
    u = r;
  } else {
    const r = analyze(url);
    if (!r || !hostInSite(r.hostname, domains) || !acceptedSchema(r, o.localAddresses)) return null;
    u = r;
  }
  const output = analyze(`${base.protocol}//${base.host}${u.pathname}${u.search}${u.hash}`);
  if (!output) return null;
  output.hostname = outputHost;
  // `actuel` in numeric notation (0x7f.1, 2130706433) is only normalized here: checked again, otherwise the start host.
  if (!o.localAddresses && localUrl(output.hostname)) output.hostname = base.hostname;
  if (!acceptedSchema(output, o.localAddresses)) return null;
  return output.href;
}

/**
 * Iterative glob matching (two pointers, O(n·m), no exponential backtracking). `*` = any sequence of characters
 * outside `interdits`.
 */
function glob(pattern: string, text: string, forbidden = ""): boolean {
  let m = 0, t = 0, star = -1, resume = 0;
  while (t < text.length) {
    if (m < pattern.length && pattern[m] === "*") {
      star = m++;
      resume = t;
    } else if (m < pattern.length && pattern[m] === text[t]) {
      m++;
      t++;
    } else if (star >= 0 && !forbidden.includes(text[resume]!)) {
      m = star + 1;
      t = ++resume;
    } else return false;
  }
  while (m < pattern.length && pattern[m] === "*") m++;
  return m === pattern.length;
}

/**
 * Wildcard `*` anchored at both ends. Path: case-sensitive. Full address: scheme, host and path compared
 * separately; a `*` in the host never passes `/ ? # @ :`; a URL with credentials is refused.
 */
export function matchesPattern(pattern: string, text: string): boolean {
  const full = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(pattern);
  if (!full) return glob(pattern, text);
  const u = analyze(text);
  if (!u || u.username || u.password) return false;
  const [, schema, host, rest] = full as unknown as [string, string, string, string];
  if (u.protocol !== `${schema.toLowerCase()}:`) return false;
  const hostText = (clean(u.hostname) || u.hostname) + (u.port ? `:${u.port}` : "");
  if (!glob(host.toLowerCase(), hostText, "/?#@:")) return false;
  return glob(rest === "" ? "/" : rest, u.pathname + u.search);
}

/** The tweaks that apply to a frame: main frame by path, subframe by full-address pattern. */
export function tweaksFor(
  d: DeclarationSite,
  frame: { url: string; main: boolean },
  domains: readonly string[],
  o: { localAddresses: boolean } = { localAddresses: false },
): Tweak[] {
  const u = analyze(frame.url);
  if (!u || !acceptedSchema(u, o.localAddresses)) return [];
  if (frame.main) {
    const rel = relativeUrl(frame.url, domains);
    if (rel === null) return [];
    return d.tweaks.filter((r) => r.matches.some((m) => matchesPattern(m, rel)));
  }
  return d.tweaks.filter((r) => r.frames !== false && r.frames.some((m) => matchesPattern(m, frame.url)));
}

/**
 * The new address of a site according to the links of its reference page (hostile): the first https link whose host
 * contains the pattern, outside the reference page, its subdomains and its parent domain (same last two labels),
 * outside local addresses. `hostname` is clean (no port or trailing dot); `port` only exists in test mode.
 */
export function findUrl(
  links: readonly string[],
  o: { page: string; pattern: string; localAddresses: boolean },
): { hostname: string; origin: string; port: string | null } | null {
  const page = analyze(o.page);
  const pattern = o.pattern.toLowerCase();
  if (!page || !pattern) return null;
  const two = (h: string) => h.split(".").slice(-2).join(".");
  const pageHost = clean(page.hostname);
  for (const link of links) {
    const u = analyze(link);
    if (!u || !acceptedSchema(u, o.localAddresses)) continue;
    const h = clean(u.hostname);
    if (!h || !VALID_HOST.test(h) || !h.includes(pattern) || two(h) === two(pageHost)) continue;
    if (!trueDomain(h, o.localAddresses)) continue;
    const port = o.localAddresses && u.port ? u.port : null;
    return { hostname: h, origin: `${u.protocol}//${h}${port ? `:${port}` : ""}/`, port };
  }
  return null;
}
