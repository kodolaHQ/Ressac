import { expect, test, vi } from "vitest";
import { apply } from "../../core/state/actions";
import { initialState } from "../../core/state/initial-state";
import type { Action } from "../../shared/api";
import { siteOf, urlRecap, type BrowserState } from "../../shared/model";
import { waitForRights, waitForResponse, policyChanges, allowedDecision, spacesBecamePrivate, tabInfos, activeTabOf, siteTab, SITE_PREFIX, staleQuestion, staleSiteQuestion, resolveSpace, boundLinks, boundCapture, closedRecaps, activeRecap, shownRecaps } from "../../core/agent/bridge";

/** Sets a space's private flag, leaving the rest untouched. */
function setPrivate(e: BrowserState, ag: (a: Action) => unknown, id: string, isPrivate: boolean) {
  const space = e.spaces.find((x) => x.id === id)!;
  ag({ type: "updateSpace", id, name: space.name, icon: space.icon, private: isPrivate, profile: space.profile });
}

function prepare() {
  let n = 0;
  const g = () => `g${++n}`;
  let e: BrowserState = initialState(g);
  const ag = (a: Action) => (e = apply(e, a, g));
  const F = e.windows[0]!.id;
  ag({ type: "openTab", windowId: F, url: "https://a.test/" });
  ag({ type: "openWindow", id: "F2" });
  ag({ type: "openTab", windowId: "F2", url: "https://b.test/" });
  return { e: () => e, ag, F };
}

test("tabInfos: all tabs of all windows, espace = name", () => {
  const { e } = prepare();
  expect(tabInfos(e()).map((o) => ({ url: o.url, space: o.space }))).toEqual([
    { url: "https://a.test/", space: "Perso" },
    { url: "https://b.test/", space: "Perso" },
  ]);
  expect(tabInfos(e())[0]).toEqual({ id: expect.any(String), title: "https://a.test/", url: "https://a.test/", space: "Perso" });
});

test("activeTabOf: null on an empty page, the active space's active tab otherwise", () => {
  const { e, ag, F } = prepare();
  expect(activeTabOf(e(), F)?.url).toBe("https://a.test/");
  expect(activeTabOf(e(), undefined)).toBeNull();
  ag({ type: "showBlankPage", windowId: F });
  expect(activeTabOf(e(), F)).toBeNull();
});

test("resolveSpace: by id, by name ignoring case, otherwise the active space", () => {
  const { e, ag, F } = prepare();
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default" });
  const f = e().windows.find((x) => x.id === F)!;
  const work = e().spaces.find((x) => x.name === "Boulot")!.id;
  expect(resolveSpace(e(), f, "boulot")).toBe(work);
  expect(resolveSpace(e(), f, work)).toBe(work);
  expect(resolveSpace(e(), f, "inconnu")).toBe(f.activeSpace);
  expect(resolveSpace(e(), f)).toBe(f.activeSpace);
});

test("policyChanges: URL changed and tab closed; nothing for a title", () => {
  const { e, ag } = prepare();
  const before = e();
  const [a, b] = Object.keys(before.tabs);
  ag({ type: "updateTab", id: a!, fields: { url: "https://autre.test/" } });
  ag({ type: "closeTab", id: b! });
  expect(policyChanges(before, e())).toEqual({ navigated: [{ id: a, url: "https://autre.test/" }], closed: [b] });
  const middle = e();
  ag({ type: "updateTab", id: a!, fields: { title: "Autre" } });
  expect(policyChanges(middle, e())).toEqual({ navigated: [], closed: [] });
});

const R1 = "0b6f4a52-3c1d-4e8f-9a7b-2c5d6e7f8a90";
const R2 = "1c7a5b63-4d2e-4f90-8b8c-3d6e7f809ba1";

test("closedRecaps: a closed recap tab gives its id; a tab moved to a private space or a recap still shown elsewhere, nothing", () => {
  const { e, ag, F } = prepare();
  ag({ type: "openRecap", windowId: F, id: R1, title: "Sommets" });
  const tab = Object.keys(e().tabs).at(-1)!;
  let before = e();
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new" });
  ag({ type: "moveTabToSpace", id: tab, spaceId: e().spaces.at(-1)!.id });
  expect(closedRecaps(before, e())).toEqual([]);
  // The same recap in two tabs (reopened): closing one keeps it.
  ag({ type: "openTab", windowId: F, url: urlRecap(R1) });
  before = e();
  ag({ type: "closeTab", id: tab });
  expect(closedRecaps(before, e())).toEqual([]);
  before = e();
  ag({ type: "closeTab", id: Object.keys(e().tabs).at(-1)! });
  expect(closedRecaps(before, e())).toEqual([R1]);
});

test("closedRecaps: a recap tab navigated to another address gives its id", () => {
  const { e, ag, F } = prepare();
  ag({ type: "openRecap", windowId: F, id: R1, title: "Sommets" });
  const before = e();
  ag({ type: "updateTab", id: Object.keys(e().tabs).at(-1)!, fields: { url: "https://ailleurs.test/" } });
  expect(closedRecaps(before, e())).toEqual([R1]);
});

test("closedRecaps: a closed window's recaps move to the remaining window, none is closed", () => {
  const { e, ag, F } = prepare();
  ag({ type: "openRecap", windowId: "F2", id: R1, title: "Sommets" });
  ag({ type: "openRecap", windowId: "F2", id: R2, title: "Refuges" });
  const before = e();
  ag({ type: "closeWindow", id: "F2" });
  expect(closedRecaps(before, e())).toEqual([]);
  expect(Object.values(e().tabs).filter((o) => o.windowId === F)).toHaveLength(4);
});

test("activeRecap and shownRecaps: the recap of a window's active tab, the recaps on screen", () => {
  const { e, ag, F } = prepare();
  ag({ type: "openRecap", windowId: F, id: R1, title: "Sommets" });
  ag({ type: "openRecap", windowId: "F2", id: R2, title: "Refuges" });
  expect(activeRecap(e(), F)).toBe(R1);
  expect(shownRecaps(e()).sort()).toEqual([R1, R2].sort());
  ag({ type: "openTab", windowId: F, url: "https://c.test/" });
  expect(activeRecap(e(), F)).toBeNull();
  expect(shownRecaps(e())).toEqual([R2]);
});

test("waitForResponse: with no answer by the deadline, the question is withdrawn and the answer is no", async () => {
  vi.useFakeTimers();
  try {
    let removed = false;
    const response = waitForResponse(() => () => (removed = true), 120_000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(removed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(removed).toBe(true);
    await expect(response).resolves.toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("waitForResponse: allow → yes, deny → no", async () => {
  await expect(waitForResponse((reply) => (reply("allow"), () => {}), 1000)).resolves.toBe(true);
  await expect(waitForResponse((reply) => (reply("deny"), () => {}), 1000)).resolves.toBe(false);
});

test("waitForResponse: signal raised (donnees-widget card of a past conversation) → card withdrawn, answer no", async () => {
  const removal = new AbortController();
  let removed = false;
  let replyLate: ((d: "allow" | "deny") => void) | undefined;
  const response = waitForResponse((reply) => ((replyLate = reply), () => (removed = true)), 1000, removal.signal);
  removal.abort();
  expect(removed).toBe(true);
  replyLate?.("allow"); // a late answer grants nothing
  await expect(response).resolves.toBe(false);
  let asked = false;
  await expect(waitForResponse(() => ((asked = true), () => {}), 1000, removal.signal)).resolves.toBe(false);
  expect(asked).toBe(false);
});

test("staleQuestion: an agent request only lapses with its target tab; a site permission, with its tab", () => {
  const { e, ag, F } = prepare();
  const [a, b] = Object.keys(e().tabs);
  const reading = { id: "q", tabId: a!, windowId: F, target: b!, origin: "https://b.test", permissions: ["read-tab" as const] };
  const site = { id: "s", tabId: a!, origin: "https://a.test", permissions: ["notifications" as const] };
  ag({ type: "closeTab", id: a! });
  expect(staleQuestion(reading, e())).toBe(false);
  expect(staleQuestion(site, e())).toBe(true);
  ag({ type: "closeTab", id: b! });
  expect(staleQuestion(reading, e())).toBe(true);
});

test("waitForRights: allow → the ticked rights; deny, deadline passed or allow with nothing → []", async () => {
  await expect(waitForRights((reply) => (reply("allow", ["console", "act"]), () => {}), 1000)).resolves.toEqual(["console", "act"]);
  await expect(waitForRights((reply) => (reply("deny", ["console"]), () => {}), 1000)).resolves.toEqual([]);
  await expect(waitForRights((reply) => (reply("allow"), () => {}), 1000)).resolves.toEqual([]);
  vi.useFakeTimers();
  try {
    let removed = false;
    const response = waitForRights(() => () => (removed = true), 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(response).resolves.toEqual([]);
    expect(removed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("waitForRights: signal raised → card withdrawn and []; a late answer changes nothing; already raised → [] without a card", async () => {
  const controller = new AbortController();
  let removed = false;
  let replyLate!: (d: "allow", rights: ["console"]) => void;
  const response = waitForRights((reply) => ((replyLate = reply), () => (removed = true)), 120_000, controller.signal);
  controller.abort();
  await expect(response).resolves.toEqual([]);
  expect(removed).toBe(true);
  replyLate("allow", ["console"]);
  await expect(response).resolves.toEqual([]);
  let asked = false;
  await expect(waitForRights(() => ((asked = true), () => {}), 1000, AbortSignal.abort())).resolves.toEqual([]);
  expect(asked).toBe(false);
});

test("staleQuestion: a dev-tools request lapses if the tab changes site; a site-app window is not a closed tab", () => {
  const { e, ag, F } = prepare();
  const [a, b] = Object.keys(e().tabs);
  const origin = new URL(e().tabs[b!]!.url).origin;
  const dev = { id: "d", tabId: a!, windowId: F, target: b!, origin: origin, permissions: ["devtools" as const], rights: ["console" as const] };
  expect(staleQuestion(dev, e())).toBe(false);
  ag({ type: "updateTab", id: b!, fields: { url: "https://ailleurs.test/" } });
  expect(staleQuestion(dev, e())).toBe(true);
  expect(staleQuestion({ ...dev, target: "app:essai", origin: "http://localhost:15280" }, e())).toBe(false);
});

test("a ressac: tab is neither listed nor active for the agent", () => {
  const { e, ag, F } = prepare();
  const id = Object.values(e().tabs).find((o) => o.windowId === F)!.id;
  ag({ type: "updateTab", id, fields: { url: "ressac://apps" } });
  expect(tabInfos(e()).map((o) => o.url)).toEqual(["https://b.test/"]);
  expect(activeTabOf(e(), F)).toBeNull();
});

test("siteOf: an origin's host; an unreadable origin (about:blank, data:, « null ») is returned as is, without an exception", () => {
  expect(siteOf("https://mail.google.com")).toBe("mail.google.com");
  expect(siteOf("http://localhost:5280")).toBe("localhost:5280");
  for (const o of ["null", "about:blank", "data:text/html,x", ""]) expect(siteOf(o)).toBe(o);
});

test("private space: neither listed nor active for the agent, its name neither", () => {
  const { e, ag, F } = prepare();
  ag({ type: "createSpace", name: "Secret", icon: "🔒", private: true, profile: "default", windowId: F });
  const secret = e().spaces.find((x) => x.name === "Secret")!.id;
  ag({ type: "openTab", windowId: F, url: "https://banque.test/", spaceId: secret });
  expect(tabInfos(e()).map((o) => o.url)).toEqual(["https://a.test/", "https://b.test/"]);
  expect(tabInfos(e()).some((o) => o.space === "Secret")).toBe(false);
  expect(e().windows.find((f) => f.id === F)!.activeSpace).toBe(secret);
  expect(activeTabOf(e(), F)).toBeNull();
  // Unknown space: private by default.
  const id = Object.values(e().tabs).find((o) => o.url === "https://a.test/")!.id;
  const unknown = { ...e(), tabs: { ...e().tabs, [id]: { ...e().tabs[id]!, spaceId: "disparu" } } };
  expect(tabInfos(unknown).map((o) => o.url)).toEqual(["https://b.test/"]);
});

test("resolveSpace: a private space, by name or by id, counts as unknown", () => {
  const { e, ag, F } = prepare();
  ag({ type: "createSpace", name: "Secret", icon: "🔒", private: true, profile: "default" });
  const f = e().windows.find((x) => x.id === F)!;
  const secret = e().spaces.find((x) => x.name === "Secret")!.id;
  expect(resolveSpace(e(), f, "secret")).toBe(f.activeSpace);
  expect(resolveSpace(e(), f, secret)).toBe(f.activeSpace);
});

test("policyChanges: a tab whose space becomes private is closed for the agent; an essential displayed in a space that stayed non-private moves to that space", () => {
  const { e, ag, F } = prepare();
  const personal = e().spaces[0]!.id;
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default" });
  const work = e().spaces.find((x) => x.name === "Boulot")!.id;
  const a = Object.values(e().tabs).find((o) => o.url === "https://a.test/")!.id;
  const b = Object.values(e().tabs).find((o) => o.url === "https://b.test/")!.id;
  // a becomes an essential, also displayed in Boulot (same key).
  ag({ type: "addEssential", id: a });
  ag({ type: "activateSpace", windowId: F, id: work });
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e().essentials[0]!.id });
  expect(e().windows.find((x) => x.id === F)!.active[work]).toBe(a);
  const before = e();
  setPrivate(e(), ag, personal, true);
  // The essential stays in Boulot, non-private, which already displayed it: it was never seen under the private key.
  expect(e().windows.find((x) => x.id === F)!.active[work]).toBe(a);
  expect(e().windows.find((x) => x.id === F)!.active[personal]).toBeNull();
  expect(e().tabs[a]!.spaceId).toBe(work);
  // The other window kept the essential loaded in Perso: that tab is closed for the agent too.
  const kept = Object.values(before.tabs).find((o) => o.windowId === "F2" && o.link)!.id;
  expect(policyChanges(before, e())).toEqual({ navigated: [], closed: [b, kept] });
  // Becoming non-private again gives nothing back: access has to be requested again.
  const isPrivate = e();
  setPrivate(e(), ag, personal, false);
  expect(policyChanges(isPrivate, e())).toEqual({ navigated: [], closed: [] });
});

test("an essential shared by two private spaces stays invisible to the agent when its owner stops being private", () => {
  const { e, ag, F } = prepare();
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new", windowId: F });
  const bank = e().spaces.find((x) => x.name === "Banque")!;
  ag({ type: "openTab", windowId: F, url: "https://mail.google.com/" });
  const gmail = Object.values(e().tabs).find((o) => o.url === "https://mail.google.com/")!.id;
  ag({ type: "addEssential", id: gmail });
  ag({ type: "createSpace", name: "Banque pro", icon: "💳", private: true, profile: bank.profile, windowId: F });
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e().essentials[0]!.id });
  const before = e();
  setPrivate(e(), ag, bank.id, false);
  // (The other window keeps the essential loaded in its non-private space: a tab of its own, which the agent sees.)
  expect(tabInfos(e()).map((o) => o.id)).not.toContain(gmail);
  expect(activeTabOf(e(), F)).toBeNull();
  // Nothing new for the policy: the tab was never readable.
  expect(policyChanges(before, e())).toEqual({ navigated: [], closed: [] });
});

test("staleQuestion: a read request lapses if the target tab moves to a private space", () => {
  const { e, ag, F } = prepare();
  const [a, b] = Object.keys(e().tabs);
  const reading = { id: "q", tabId: a!, windowId: F, target: b!, origin: "https://b.test", permissions: ["read-tab" as const] };
  expect(staleQuestion(reading, e())).toBe(false);
  setPrivate(e(), ag, e().spaces[0]!.id, true);
  expect(staleQuestion(reading, e())).toBe(true);
});

test("staleQuestion: a read card lapses when its tab changes origin", () => {
  const { e, ag, F } = prepare();
  const a = Object.values(e().tabs).find((o) => o.url === "https://a.test/")!.id;
  const reading = { id: "q", tabId: a, windowId: F, target: a, origin: "https://a.test", permissions: ["read-tab" as const] };
  ag({ type: "updateTab", id: a, fields: { url: "https://a.test/autre" } });
  expect(staleQuestion(reading, e())).toBe(false);
  ag({ type: "updateTab", id: a, fields: { url: "https://banque.test/" } });
  expect(staleQuestion(reading, e())).toBe(true);
});

test("spacesBecamePrivate: only the switch from non-private to private", () => {
  const { e, ag } = prepare();
  const id = e().spaces[0]!.id;
  const before = e();
  setPrivate(e(), ag, id, true);
  const isPrivate = e();
  expect(spacesBecamePrivate(before, isPrivate)).toEqual([id]);
  expect(spacesBecamePrivate(isPrivate, isPrivate)).toEqual([]);
  setPrivate(e(), ag, id, false);
  expect(spacesBecamePrivate(isPrivate, e())).toEqual([]);
});

const extensionCard = (spaceId: string, source: "store" | "agent", strengthened = false) => ({
  key: source === "agent" ? "agent:essai" : `store:${"a".repeat(32)}`,
  name: "Essai",
  source,
  version: "1.0.0",
  rights: [],
  sites: [],
  allSites: false,
  network: source === "agent" ? [] : null,
  hardened: strengthened,
  space: "Perso",
  spaceId: spaceId,
  otherSpaces: [],
  alsoReplaces: [],
  update: null,
  hash: "0".repeat(64),
});

test("staleQuestion: an extension card lapses with its space; the agent's one too when the profile becomes private", () => {
  const { e, ag, F } = prepare();
  const space = e().spaces[0]!.id;
  const agent = { id: "x", tabId: null, windowId: F, origin: "agent:essai", permissions: ["extension" as const], extension: extensionCard(space, "agent") };
  const store = { ...agent, id: "y", extension: extensionCard(space, "store") };
  expect(staleQuestion(agent, e())).toBe(false);
  expect(staleQuestion(store, e())).toBe(false);
  // Another space of the same profile becomes private: the profile is, and the agent's extension has no place there any more.
  ag({ type: "createSpace", name: "Secret", icon: "🔒", private: false, profile: e().spaces[0]!.profile });
  const secret = e().spaces.at(-1)!.id;
  setPrivate(e(), ag, secret, true);
  expect(staleQuestion(agent, e())).toBe(true);
  expect(staleQuestion(store, e())).toBe(false);
  // Space deleted: every card lapses.
  expect(staleQuestion({ ...store, extension: extensionCard("inconnu", "store") }, e())).toBe(true);
});

test("allowedDecision: a « yes » to a reinforced card without the box ticked counts as a refusal", () => {
  const strengthened = { id: "x", tabId: null, origin: "agent:essai", permissions: ["extension" as const], extension: extensionCard("e", "agent", true) };
  expect(allowedDecision(strengthened, "allow")).toBe("deny");
  expect(allowedDecision(strengthened, "allow", false)).toBe("deny");
  expect(allowedDecision(strengthened, "allow", true)).toBe("allow");
  expect(allowedDecision(strengthened, "deny", true)).toBe("deny");
  const simple = { ...strengthened, extension: extensionCard("e", "agent") };
  expect(allowedDecision(simple, "allow")).toBe("allow");
  const reading = { id: "l", tabId: null, origin: "https://a.test", permissions: ["read-tab" as const] };
  expect(allowedDecision(reading, "allow")).toBe("allow");
});

// ——— Site-app windows (`site:<id>`) ———

test("siteTab: site:<id>, title = app name, empty space, site, current domain and declaration hash filled in", () => {
  expect(SITE_PREFIX).toBe("site:");
  expect(siteTab({ id: "vidola", name: "Vidola", url: "https://compte.example/connexion", domain: "vidola-a.example", hash: "e1" })).toEqual({
    id: "site:vidola", title: "Vidola", url: "https://compte.example/connexion", space: "", site: "vidola", domain: "vidola-a.example", hash: "e1",
  });
});

test("staleSiteQuestion: a question on site:<id> lapses with its window; the dev-tools one too when leaving for another origin", () => {
  const opened = [{ id: "vidola", name: "Vidola", url: "https://vidola-a.example/film/1", domain: "vidola-a.example" }];
  const dev = { id: "d", tabId: null, target: "site:vidola", origin: "https://vidola-a.example", permissions: ["devtools" as const], rights: ["console" as const] };
  expect(staleSiteQuestion(dev, opened)).toBe(false);
  // Window closed (surFermee): the card lapses.
  expect(staleSiteQuestion(dev, [])).toBe(true);
  expect(staleSiteQuestion(dev, [{ ...opened[0]!, url: "https://compte.example/connexion" }])).toBe(true);
  // Neither a question without a site: target, nor the app's card (no target).
  expect(staleSiteQuestion({ ...dev, target: "app:essai" }, [])).toBe(false);
  expect(staleSiteQuestion({ id: "s", tabId: null, origin: "ressac-site://vidola", permissions: ["widget-data" as const], site: "vidola" }, [])).toBe(false);
});

test("staleQuestion: a site-app window is not a closed tab (tracked separately)", () => {
  const { e, F } = prepare();
  const dev = { id: "d", tabId: null, windowId: F, target: "site:vidola", origin: "https://vidola-a.example", permissions: ["devtools" as const], rights: ["console" as const] };
  expect(staleQuestion(dev, e())).toBe(false);
});

test("boundLinks drops a link whose address is over 500 characters (never cuts it), and non-web ones", () => {
  const long = `https://exemple.fr/${"a".repeat(500)}`;
  const ok = `https://exemple.fr/${"a".repeat(481)}`;
  expect(ok).toHaveLength(500);
  const links = boundLinks([{ text: "long", url: long }, { text: "ok", url: ok }, { text: "js", url: "javascript:alert(1)" }, { text: "x" }]);
  expect(links).toEqual([{ text: "ok", url: ok, zone: "other" }]);
});

test("boundLinks keeps a known zone, turns any other into other, and keeps 500 links at most", () => {
  const u = "https://exemple.fr/";
  expect(boundLinks([{ text: "a", url: u, zone: "main" }, { text: "b", url: u, zone: "<script>" }, { text: "c", url: u }]).map((l) => l.zone)).toEqual(["main", "other", "other"]);
  expect(boundLinks(Array.from({ length: 10_000 }, () => ({ text: "x", url: u, zone: "nav" })))).toHaveLength(500);
});

test("boundLinks keeps a link's https photo up to 2 048 characters and drops any other", () => {
  const u = "https://exemple.fr/";
  const ok = `https://img.fr/${"a".repeat(2_033)}`;
  expect(ok).toHaveLength(2_048);
  const links = boundLinks([ok, `${ok}a`, "http://img.fr/a.jpg", "data:image/png;base64,AAAA", 42].map((image) => ({ text: "x", url: u, image })));
  expect(links.map((l) => l.image)).toEqual([ok, undefined, undefined, undefined, undefined]);
  expect("image" in links[1]!).toBe(false);
});

test("boundCapture caps what a web process sends and drops wrong types", () => {
  const block = { text: "Un bloc", h: 2, zone: "main" };
  const c = boundCapture({
    blocks: [...Array.from({ length: 10_000 }, () => block), { text: "t", h: 9, zone: "<x>" }],
    structured: [{ name: "Lampe" }, { big: "x".repeat(5_000_000) }, ...Array.from({ length: 500 }, (_, i) => ({ [`k${i}`]: i }))],
    reader: "r".repeat(300_000),
    status: "200",
    redirects: [...Array.from({ length: 20 }, (_, i) => `https://ex.fr/${i}`), "javascript:alert(1)"],
    contentType: "text/html",
    passwords: 2,
  });
  expect(c.blocks).toHaveLength(6000);
  expect(boundCapture({ blocks: [{ text: "t", h: 9, zone: "<x>", row: "1" }] }).blocks).toEqual([{ text: "t", h: 0, zone: "other" }]);
  expect(c.structured).toHaveLength(50);
  expect(c.structured![0]).toEqual({ name: "Lampe" });
  expect(JSON.stringify(c.structured)).not.toContain("xxxx");
  expect(c.reader).toHaveLength(200_000);
  expect(c.status).toBeUndefined();
  expect(c.redirects).toHaveLength(10);
  expect(c.contentType).toBe("text/html");
  expect(c.passwords).toBe(2);
  expect(boundCapture(null)).toEqual({});
  expect(boundCapture({ status: 404, passwords: -1 })).toEqual({ status: 404 });
});
