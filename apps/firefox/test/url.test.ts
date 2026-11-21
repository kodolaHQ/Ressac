import { expect, test } from "vitest";
import { connectionFromSecurity, connectionOf, shownConnection, STATE_IS_BROKEN, STATE_IS_SECURE, toUrl as toUrlWith } from "../core/url";
import { customEngineError, searchTemplate, type SearchEngine } from "../shared/search";

const toUrl = (input: string, engine: SearchEngine) => toUrlWith(input, searchTemplate({ engine, customEngine: null }));

test.each([
  ["https://github.com", "https://github.com/"],
  ["github.com", "https://github.com/"],
  ["  github.com/sveltejs  ", "https://github.com/sveltejs"],
  ["localhost:5280", "http://localhost:5280/"],
  ["localhost", "http://localhost/"],
  ["127.0.0.1:8080/x", "http://127.0.0.1:8080/x"],
  ["file:///Users/t/doc.pdf", "file:///Users/t/doc.pdf"],
  ["about:blank", "about:blank"],
  ["fr.wikipedia.org/wiki/Arc", "https://fr.wikipedia.org/wiki/Arc"],
])("%s → %s", (input, expected) => expect(toUrl(input, "google")).toBe(expected));

test("free text → search with the chosen engine", () => {
  expect(toUrl("svelte 5 runes", "google")).toBe("https://www.google.com/search?q=svelte%205%20runes");
  expect(toUrl("svelte", "duckduckgo")).toBe("https://duckduckgo.com/?q=svelte");
  expect(toUrl("c'est quoi ?", "qwant")).toBe(`https://www.qwant.com/?q=${encodeURIComponent("c'est quoi ?")}`);
});

test("javascript: refused, whatever the case", () => {
  expect(toUrl("javascript:alert(1)", "google")).toBeNull();
  expect(toUrl("  JavaScript:alert(1)", "google")).toBeNull();
});

test("empty entry → null", () => expect(toUrl("   ", "google")).toBeNull());

test("an invalid URL (« http:// » alone) → search instead of an exception", () => {
  expect(toUrl("http://", "google")).toBe("https://www.google.com/search?q=http%3A%2F%2F");
  expect(toUrl("https://exa mple.com", "google")).toBe("https://www.google.com/search?q=https%3A%2F%2Fexa%20mple.com");
});

test("a custom address gets the words encoded once; custom without a valid address searches with Google", () => {
  expect(toUrlWith("a & b#c", "https://kagi.com/search?q=%s")).toBe("https://kagi.com/search?q=a%20%26%20b%23c");
  expect(searchTemplate({ engine: "custom", customEngine: null })).toBe("https://www.google.com/search?q=%s");
  expect(searchTemplate({ engine: "custom", customEngine: "http://x.com/?q=%s" })).toBe("https://www.google.com/search?q=%s");
  expect(searchTemplate({ engine: "custom", customEngine: " https://kagi.com/search?q=%s " })).toBe("https://kagi.com/search?q=%s");
  expect(searchTemplate({ engine: "ecosia", customEngine: null })).toBe("https://www.ecosia.org/search?q=%s");
});

test("a custom address must be https, carry %s and stay under 2 000 characters", () => {
  expect(customEngineError("http://x.com/?q=%s")).toBe("agent-engine-custom-https");
  expect(customEngineError("https://x.com/")).toBe("agent-engine-custom-missing-s");
  expect(customEngineError("https://x.com/?q=%s&p=" + "a".repeat(2000))).toBe("agent-engine-custom-too-long");
  expect(customEngineError("https://kagi.com/search?q=%s")).toBeNull();
});

test("connectionOf: https is secure, http elsewhere than this Mac is not, local and internal pages say nothing", () => {
  expect(connectionOf("https://exemple.fr/a")).toBe("secure");
  expect(connectionOf("http://exemple.fr/")).toBe("insecure");
  expect(connectionOf("http://192.168.1.5:8080/")).toBe("insecure");
  for (const url of ["http://localhost:5300/", "http://app.localhost/", "http://127.0.0.1/", "http://[::1]:80/", "about:blank", "file:///tmp/a.html", "resource://ressac/home.html", "moz-extension://x/p.html", "pas une adresse"]) {
    expect(connectionOf(url)).toBeNull();
  }
});

test("connectionFromSecurity follows Firefox's identity block", () => {
  const INSECURE = 0x4;
  const MIXED_ACTIVE = 0x20;
  const on = (url: string, state: number, o: { secureContext?: boolean; documentUri?: string } = {}) =>
    connectionFromSecurity(url, { state, secureContext: o.secureContext ?? false, documentUri: o.documentUri ?? url });
  expect(on("https://exemple.fr/", STATE_IS_SECURE, { secureContext: true })).toBe("secure");
  // Mixed active content or a weak cipher: broken.
  expect(on("https://exemple.fr/", STATE_IS_BROKEN | MIXED_ACTIVE, { secureContext: true })).toBe("insecure");
  expect(on("https://expired.badssl.com/", INSECURE, { documentUri: "about:certerror?e=nssBadCert&u=https%3A//expired.badssl.com/" })).toBe("insecure");
  expect(on("https://exemple.fr/", INSECURE, { documentUri: "about:neterror?e=nssFailure2&u=x" })).toBe("insecure");
  expect(on("http://exemple.fr/", INSECURE, { documentUri: "about:httpsonlyerror?e=x" })).toBe("insecure");
  expect(on("https://nulle-part.invalid/", INSECURE, { documentUri: "about:neterror?e=dnsNotFound&u=x" })).toBeNull();
  expect(on("http://exemple.fr/", INSECURE)).toBe("insecure");
  expect(on("http://localhost:5300/", INSECURE, { secureContext: true })).toBeNull();
  for (const url of ["about:blank", "resource://ressac/home.html", "moz-extension://x/p.html", "file:///tmp/a.html"]) expect(on(url, INSECURE, { secureContext: true })).toBeNull();
});

test("shownConnection: Firefox's report first, the scheme before it, never a padlock over a failed load", () => {
  expect(shownConnection({ url: "https://a.fr/", error: null })).toBe("secure");
  expect(shownConnection({ url: "https://a.fr/", error: null, security: "insecure" })).toBe("insecure");
  expect(shownConnection({ url: "https://a.fr/", error: null, security: null })).toBeNull();
  expect(shownConnection({ url: "https://a.fr/", error: "SEC_ERROR_EXPIRED_CERTIFICATE" })).toBeNull();
  expect(shownConnection({ url: "https://a.fr/", error: "ERR_NAME_NOT_RESOLVED", security: "secure" })).toBeNull();
  expect(shownConnection({ url: "https://a.fr/", error: "SEC_ERROR_UNKNOWN_ISSUER", security: "insecure" })).toBe("insecure");
});
