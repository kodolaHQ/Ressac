const ACCEPTED_SCHEMAS = ["http:", "https:", "file:", "about:"];
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i;
const DOMAIN = /^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i;

/** The normalized URL, or `null` if it does not parse (« http:// » alone, port out of range…). */
const analyze = (text: string) => (URL.canParse(text) ? new URL(text).href : null);

/** Turns what the user types in the address bar into a URL; `null` if the input is refused. */
/** `template`: the search address (`searchTemplate`), `%s` standing for the words. */
export function toUrl(input: string, template: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^javascript:/i.test(text)) return null;
  const schema = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (schema && ACCEPTED_SCHEMAS.includes(`${schema}:`) && (schema === "about" || text.includes("//"))) {
    const url = schema === "about" ? text : analyze(text);
    if (url) return url;
  } else if (LOCAL.test(text) || DOMAIN.test(text)) {
    const url = analyze(`${LOCAL.test(text) ? "http" : "https"}://${text}`);
    if (url) return url;
  }
  // Neither a URL nor a valid domain: search the text as is.
  return template.replace("%s", encodeURIComponent(text));
}

export type Connection = "secure" | "insecure" | null;

/**
 * The address bar's guess from the URL's scheme alone, until Firefox reports the page's security state (a tab never
 * loaded, an unloaded essential): "secure" for https, "insecure" for http to a host that is not this Mac, null for
 * local and internal pages.
 */
export function connectionOf(url: string): Connection {
  if (!URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.protocol === "https:") return "secure";
  if (u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  // Loopback, as Firefox counts it trustworthy: localhost and its subdomains, 127.0.0.0/8, ::1.
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]" ? null : "insecure";
}

// nsIWebProgressListener's security flags (stable IDL values).
export const STATE_IS_BROKEN = 0x1;
export const STATE_IS_SECURE = 0x2;

/**
 * The page's connection as Firefox's identity block judges it (browser-siteIdentity.js `refreshIdentityBlock`), from
 * the top browser's `securityUI` (`state`, `isSecureContext`) and its `documentURI` (an error page's about: address):
 * secure transport → "secure"; broken (mixed content, weak cipher), a certificate error or an HTTPS-Only error page →
 * "insecure"; other error pages and potentially trustworthy pages (localhost, file, Ressac's own) → null; else "insecure".
 */
export function connectionFromSecurity(url: string, s: { state: number; secureContext: boolean; documentUri: string | null }): Connection {
  // Internal pages (about:, resource:, moz-extension:, file:…): no connection to speak of, as Firefox's chromeUI and extension cases.
  if (!URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) return null;
  if (s.state & STATE_IS_SECURE) return "secure";
  if (s.state & STATE_IS_BROKEN) return "insecure";
  const doc = s.documentUri && URL.canParse(s.documentUri) ? new URL(s.documentUri) : null;
  if (doc?.protocol === "about:") {
    if (doc.pathname === "certerror" || (doc.pathname === "neterror" && doc.searchParams.get("e") === "nssFailure2") || doc.pathname === "httpsonlyerror") return "insecure";
    // A network error or a blocked page: Firefox's neutral icon.
    if (doc.pathname === "neterror" || doc.pathname === "blocked") return null;
  }
  return s.secureContext ? null : "insecure";
}
