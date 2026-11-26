import { beforeEach, expect, test, vi } from "vitest";
import { DEV_RIGHTS, AccessPolicy } from "../../src/access/policy.js";
import type { TabInfo } from "../../src/mcp/bridge.js";

const github: TabInfo = { id: "1", title: "svelte", url: "https://github.com/sveltejs/svelte", space: "perso" };
const gmail: TabInfo = { id: "2", title: "Gmail", url: "https://mail.google.com/mail/u/0/", space: "perso" };
const demo: TabInfo = { id: "3", title: "Démo", url: "http://localhost:5280/", space: "perso" };
let p: AccessPolicy;
beforeEach(() => (p = new AccessPolicy()));

test("no access by default", () => {
  expect(p.canRead(gmail)).toBe(false);
});

test("interaction from a tab → access to that tab only", () => {
  p.userInteraction(github);
  expect(p.canRead(github)).toBe(true);
  expect(p.canRead(gmail)).toBe(false);
});

test("tab opened by the agent → access", () => {
  p.tabOpenedByAgent(demo);
  expect(p.canRead(demo)).toBe(true);
});

test("accorder (yes answer to a request) → access", () => {
  p.grant(gmail);
  expect(p.canRead(gmail)).toBe(true);
});

test("The user changes site → authorization lapsed, even if they come back", () => {
  p.userInteraction(github);
  p.tabNavigated(github.id, "https://mail.google.com/");
  expect(p.canRead({ ...github, url: "https://mail.google.com/" })).toBe(false);
  p.tabNavigated(github.id, github.url);
  expect(p.canRead(github)).toBe(false);
});

test("same site, other page → access kept", () => {
  p.userInteraction(github);
  p.tabNavigated(github.id, "https://github.com/sveltejs/kit");
  expect(p.canRead({ ...github, url: "https://github.com/sveltejs/kit" })).toBe(true);
});

test("the current URL counts even without a navigation event", () => {
  p.userInteraction(github);
  expect(p.canRead({ ...github, url: "https://evil.test/" })).toBe(false);
});

test("the agent navigates its demo tab to another port → access kept", () => {
  p.tabOpenedByAgent(demo);
  p.navigationByAgent(demo.id, "http://localhost:5281/");
  expect(p.canRead({ ...demo, url: "http://localhost:5281/" })).toBe(true);
});

test("reinitialiser removes everything; tabClosed removes the tab", () => {
  p.userInteraction(github);
  p.grant(gmail);
  p.tabClosed(gmail.id);
  expect(p.canRead(gmail)).toBe(false);
  expect(p.canRead(github)).toBe(true);
  p.reset();
  expect(p.canRead(github)).toBe(false);
});

test("URL invalide → jamais lisible", () => {
  p.grant({ ...github, url: "pas une url" });
  expect(p.canRead({ ...github, url: "pas une url" })).toBe(false);
});

test("the agent opens Gmail itself → no access without a request", () => {
  p.tabOpenedByAgent({ ...gmail, id: "9" });
  expect(p.canRead({ ...gmail, id: "9" })).toBe(false);
});

test("the agent navigates its demo to an outside site → access lost", () => {
  p.tabOpenedByAgent(demo);
  p.navigationByAgent(demo.id, "https://mail.google.com/");
  expect(p.canRead({ ...demo, url: "https://mail.google.com/" })).toBe(false);
});

test("demo on 127.0.0.1 opened by the agent → access", () => {
  const d = { ...demo, url: "http://127.0.0.1:5280/" };
  p.tabOpenedByAgent(d);
  expect(p.canRead(d)).toBe(true);
});

test("the agent navigates on the same site a tab the user gave it → access kept", () => {
  p.userInteraction(github);
  p.navigationByAgent(github.id, "https://github.com/sveltejs/kit");
  expect(p.canRead({ ...github, url: "https://github.com/sveltejs/kit" })).toBe(true);
});

// --- Dev tools rights ---

const app: TabInfo = { id: "4", title: "Mon app", url: "http://localhost:8123/", space: "perso", app: "mon-app" };
const port3000: TabInfo = { id: "5", title: "Dev", url: "http://localhost:3000/", space: "perso" };

test("built: app:<folder> and localhost:5285 opened by the agent have the four rights; localhost:3000 has none", () => {
  const demo5285 = { ...demo, url: "http://localhost:5285/" };
  p.tabOpenedByAgent(app);
  p.tabOpenedByAgent(demo5285);
  p.tabOpenedByAgent(port3000);
  expect(p.devRights(app)).toEqual(["console", "network", "performance", "act"]);
  expect(p.devRights(demo5285)).toEqual(["console", "network", "performance", "act"]);
  expect(p.isBuilt(demo5285)).toBe(true);
  expect(p.devRights(port3000)).toEqual([]);
  expect(p.isBuilt(port3000)).toBe(false);
});

test("a local port the agent does not serve (the user's dev server) is not readable without a grant", () => {
  p.tabOpenedByAgent(port3000);
  expect(p.canRead(port3000)).toBe(false);
  p.tabOpenedByAgent(app);
  expect(p.canRead(app)).toBe(true);
  // From its demo, the agent's navigation to the user's port drops the access.
  p.tabOpenedByAgent(demo);
  p.navigationByAgent(demo.id, port3000.url);
  expect(p.canRead({ ...demo, url: port3000.url })).toBe(false);
});

test("built: the default demo range follows RESSAC_CONTAINER_PORTS", () => {
  vi.stubEnv("RESSAC_CONTAINER_PORTS", "5300-5319");
  try {
    const q = new AccessPolicy();
    const d5305 = { ...demo, url: "http://localhost:5305/" };
    const d5285 = { ...demo, id: "6", url: "http://localhost:5285/" };
    q.tabOpenedByAgent(d5305);
    q.tabOpenedByAgent(d5285);
    expect(q.isBuilt(d5305)).toBe(true);
    expect(q.isBuilt(d5285)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("built: the port predicate is configurable", () => {
  const q = new AccessPolicy({ portBuilt: (port) => port === 3000 });
  q.tabOpenedByAgent(port3000);
  expect(q.isBuilt(port3000)).toBe(true);
});

test("built: leaving the origin removes the rights; navigating back to it (agent) restores them", () => {
  p.tabOpenedByAgent(demo);
  p.navigationByAgent(demo.id, "https://github.com/");
  expect(p.devRights({ ...demo, url: "https://github.com/" })).toEqual([]);
  p.navigationByAgent(demo.id, demo.url);
  expect(p.devRights(demo)).toHaveLength(4);
  p.tabNavigated(demo.id, "https://github.com/");
  p.tabNavigated(demo.id, demo.url);
  expect(p.devRights(demo)).toEqual([]);
});

test("accorderDev: only the checked rights; they drop on site change, on close, on reinitialiser", () => {
  p.grantDev(github, ["console", "act"], ["network"]);
  expect(p.devRights(github)).toEqual(["console", "act"]);
  p.tabNavigated(github.id, "https://mail.google.com/");
  expect(p.devRights(github)).toEqual([]);
  p.grantDev(github, ["console"], []);
  p.tabClosed(github.id);
  expect(p.devRights(github)).toEqual([]);
  p.grantDev(github, ["console"], []);
  p.reset();
  expect(p.devRights(github)).toEqual([]);
});

test("refusal: canAsk false for a refused (tab, right) until userInteraction; another right stays requestable", () => {
  p.grantDev(github, [], ["network"]);
  expect(p.canAsk(github.id, "network")).toBe(false);
  expect(p.canAsk(github.id, "console")).toBe(true);
  p.userInteraction(gmail);
  expect(p.canAsk(github.id, "network")).toBe(true);
  p.grantDev(github, [], ["network"]);
  p.reset();
  expect(p.canAsk(github.id, "network")).toBe(true);
});

test("couper(id, \"agir\") removes that right only; couper(id) removes everything, reading included; a built one that is cut stays so until reinitialiser", () => {
  p.userInteraction(github);
  p.grantDev(github, ["console", "act"], []);
  p.cut(github.id, "act");
  expect(p.devRights(github)).toEqual(["console"]);
  p.cut(github.id);
  expect(p.devRights(github)).toEqual([]);
  expect(p.canRead(github)).toBe(false);

  p.tabOpenedByAgent(demo);
  p.cut(demo.id, "act");
  expect(p.devRights(demo)).toEqual(["console", "network", "performance"]);
  p.cut(demo.id);
  expect(p.devRights(demo)).toEqual([]);
  p.navigationByAgent(demo.id, "http://localhost:5281/");
  expect(p.devRights({ ...demo, url: "http://localhost:5281/" })).toEqual([]);
  p.reset();
  expect(p.devRights({ ...demo, url: "http://localhost:5281/" })).toHaveLength(4);
});

test("etat(): reading, rights, built, enCours (utilisation true/false balanced)", () => {
  expect(p.state()).toEqual({});
  p.userInteraction(github);
  p.grantDev(gmail, ["network"], []);
  p.tabOpenedByAgent(demo);
  p.use(github.id, true);
  p.use(github.id, true);
  p.use(github.id, false);
  expect(p.state()[github.id]).toEqual({ read: true, rights: [], built: false, running: true });
  expect(p.state()[gmail.id]).toEqual({ read: false, rights: ["network"], built: false, running: false });
  expect(p.state()[demo.id]).toEqual({ read: true, rights: [...DEV_RIGHTS], built: true, running: false });
  p.use(github.id, false);
  expect(p.state()[github.id]?.running).toBe(false);
  p.tabClosed(demo.id);
  expect(p.state()[demo.id]).toBeUndefined();
});

test("onChange called on each mutation, unsubscribe effective", () => {
  let n = 0;
  const stop = p.onChange(() => n++);
  p.userInteraction(github);
  p.grantDev(github, ["console"], []);
  p.cut(github.id, "console");
  p.use(github.id, true);
  p.tabNavigated(github.id, "https://x.test/");
  p.navigationByAgent(github.id, "https://y.test/");
  p.tabClosed(github.id);
  p.reset();
  expect(n).toBe(8);
  stop();
  p.userInteraction(github);
  expect(n).toBe(8);
});

test("cut built: relaunching the app (closing then reopening app:x) does not restore the rights; reinitialiser does", () => {
  const app: TabInfo = { id: "app:x", title: "X", url: "http://localhost:5281/", space: "", app: "x" };
  p.built(app);
  p.cut("app:x");
  p.tabClosed("app:x");
  // relaunched on another port: same app window
  const relaunched = { ...app, url: "http://localhost:5290/" };
  p.built(relaunched);
  expect(p.isBuilt(relaunched)).toBe(true);
  expect(p.devRights(relaunched)).toEqual([]);
  // the agent opens the app's old origin in a tab: cut as well
  const tab: TabInfo = { id: "9", title: "X", url: "http://localhost:5281/", space: "" };
  p.tabOpenedByAgent(tab);
  expect(p.devRights(tab)).toEqual([]);
  p.reset();
  expect(p.devRights(relaunched)).toEqual(DEV_RIGHTS);
  expect(p.devRights(tab)).toEqual(DEV_RIGHTS);
});

test("cut demo: a new agent tab on the same origin has no right; another origin does; a single cut right stays cut", () => {
  p.tabOpenedByAgent(demo);
  p.cut(demo.id, "act");
  p.tabClosed(demo.id);
  const fresh: TabInfo = { ...demo, id: "4" };
  p.tabOpenedByAgent(fresh);
  expect(p.devRights(fresh)).toEqual(["console", "network", "performance"]);
  p.cut(fresh.id);
  p.tabClosed(fresh.id);
  const still: TabInfo = { ...demo, id: "5" };
  p.tabOpenedByAgent(still);
  expect(p.devRights(still)).toEqual([]);
  const other: TabInfo = { ...demo, id: "6", url: "http://localhost:5281/" };
  p.tabOpenedByAgent(other);
  expect(p.devRights(other)).toEqual(DEV_RIGHTS);
  // The user grants again themselves: the right comes back
  p.grantDev(still, ["console"], []);
  expect(p.devRights(still)).toEqual(["console"]);
  p.reset();
  expect(p.devRights(still)).toEqual(DEV_RIGHTS);
});

test("conversation: changes at each reinitialiser", () => {
  const before = p.conversation;
  p.reset();
  expect(p.conversation).toBe(before + 1);
});

test("accorder signals the change (the read badge follows); nothing if access is already there", () => {
  let n = 0;
  p.onChange(() => n++);
  p.grant(gmail);
  expect(n).toBe(1);
  p.grant(gmail);
  expect(n).toBe(1);
});

const vidola: TabInfo = { id: "site:vidola", title: "Vidola", url: "https://vidola-a.example/film/1", space: "", site: "vidola" };
const youtube: TabInfo = { id: "site:youtube", title: "YouTube", url: "https://www.youtube.com/", space: "", site: "youtube" };

test("accorderLectureSite(\"vidola\") : peutLire de site:vidola vrai, de site:youtube faux ; nouvelle conversation : faux", () => {
  expect(p.canRead(vidola)).toBe(false);
  let n = 0;
  p.onChange(() => n++);
  p.grantSiteRead("vidola");
  expect(n).toBe(1);
  expect(p.grantedSiteRead("vidola")).toBe(true);
  expect(p.canRead(vidola)).toBe(true);
  // The grant is about the app, not the origin: the page may change within the site.
  expect(p.canRead({ ...vidola, url: "https://vidola-b.example/serie/2" })).toBe(true);
  expect(p.canRead(youtube)).toBe(false);
  p.reset();
  expect(p.grantedSiteRead("vidola")).toBe(false);
  expect(p.canRead(vidola)).toBe(false);
});

test("site app: an origin authorization (tab of the same domain, or accorder on the window) does not open it", () => {
  const tab: TabInfo = { id: "7", title: "Vidola", url: "https://vidola-a.example/film/1", space: "perso" };
  p.grant(tab);
  p.userInteraction(tab);
  expect(p.canRead(tab)).toBe(true);
  expect(p.canRead(vidola)).toBe(false);
  // Even set on the window id, an origin authorization does not count.
  p.grant(vidola);
  p.userInteraction(vidola);
  p.tabOpenedByAgent(vidola);
  expect(p.canRead(vidola)).toBe(false);
  // Nor does the data of a widget or an action of the same name.
  p.grantWidgetData("vidola");
  p.grantActionData("vidola");
  expect(p.canRead(vidola)).toBe(false);
});

test("site app: its dev rights are only valid with its grant; a new conversation removes both", () => {
  p.grantDev(vidola, ["console"], []);
  expect(p.devRights(vidola)).toEqual([]);
  p.grantSiteRead("vidola");
  expect(p.devRights(vidola)).toEqual(["console"]);
  p.reset();
  expect(p.devRights(vidola)).toEqual([]);
});

test("reading of a site app tied to the hash of its declaration: another hash does not count", () => {
  p.grantSiteRead("vidola", "e1");
  expect(p.grantedSiteRead("vidola", "e1")).toBe(true);
  expect(p.canRead({ ...vidola, hash: "e1" })).toBe(true);
  expect(p.grantedSiteRead("vidola", "e2")).toBe(false);
  expect(p.grantedSiteRead("vidola")).toBe(false);
  expect(p.canRead({ ...vidola, hash: "e2" })).toBe(false);
  p.grantDev({ ...vidola, hash: "e1" }, ["console"], []);
  expect(p.devRights({ ...vidola, hash: "e1" })).toEqual(["console"]);
  expect(p.devRights({ ...vidola, hash: "e2" })).toEqual([]);
  // Le nouvel accord remplace l'ancien.
  p.grantSiteRead("vidola", "e2");
  expect(p.grantedSiteRead("vidola", "e2")).toBe(true);
  expect(p.grantedSiteRead("vidola", "e1")).toBe(false);
});

test("retirerLectureSite (app deleted): the grant drops, the badge follows; pending cards see it (siteReadWithdrawals)", () => {
  p.grantSiteRead("vidola", "e1");
  p.grantSiteRead("youtube", "y");
  let n = 0;
  p.onChange(() => n++);
  p.removeSiteRead("vidola");
  expect(n).toBe(1);
  expect(p.grantedSiteRead("vidola", "e1")).toBe(false);
  expect(p.grantedSiteRead("youtube", "y")).toBe(true);
  // Even without a grant (a card still pending), the removal is counted and signaled.
  const before = p.siteReadRemovals("vidola");
  p.removeSiteRead("vidola");
  expect(p.siteReadRemovals("vidola")).toBe(before + 1);
  expect(p.siteReadRemovals("youtube")).toBe(0);
  expect(n).toBe(2);
});

test("a tab the user shared stays shared across reset(), until it closes", () => {
  expect(p.sharedByUser(github.id, github.url)).toBe(false);
  p.userInteraction(github);
  expect(p.sharedByUser(github.id, github.url)).toBe(true);
  expect(p.sharedByUser(gmail.id, gmail.url)).toBe(false);
  p.reset();
  expect(p.sharedByUser(github.id, github.url)).toBe(true);
  p.tabClosed(github.id);
  expect(p.sharedByUser(github.id, github.url)).toBe(false);
});

test("a shared tab is shared only on the site it was shared on", () => {
  p.userInteraction(github);
  expect(p.sharedByUser(github.id, "https://github.com/autre")).toBe(true);
  p.tabNavigated(github.id, "https://prive.example/");
  expect(p.sharedByUser(github.id, "https://prive.example/")).toBe(false);
  p.tabNavigated(github.id, github.url);
  expect(p.sharedByUser(github.id, github.url)).toBe(true);
});

test("opaque origins (data:, about:blank, file:) are never granted: they would all share « null »", () => {
  for (const url of ["data:text/html,<p>x", "about:blank", "file:///etc/passwd"]) {
    const tab: TabInfo = { id: url, title: "", url, space: "perso" };
    p.grant(tab);
    expect(p.canRead(tab), url).toBe(false);
  }
});

test("an interaction from a site app window gives it no origin permission", () => {
  p.userInteraction(vidola);
  expect(p.state()[vidola.id]?.read).not.toBe(true);
});

test("a site app served on an agent port is never marked built", () => {
  const q = new AccessPolicy({ portBuilt: () => true });
  const local: TabInfo = { ...vidola, url: "http://localhost:5300/" };
  q.built(local);
  expect(q.isBuilt(local)).toBe(false);
});

test("dev rights hold for the origin they were granted on only", () => {
  p.grantDev(github, ["console"], []);
  expect(p.devRights({ ...github, url: "https://evil.test/" })).toEqual([]);
});

test("a tab pointed with @ reads in that conversation only, on that origin", () => {
  p.pointTab("s1", gmail);
  expect(p.pointed("s1", gmail)).toBe(true);
  // Another discussion, another tab: the usual rules.
  expect(p.pointed("s2", gmail)).toBe(false);
  expect(p.pointed("s1", github)).toBe(false);
  // Not a tab grant: the badge's read state and the other sessions see nothing.
  expect(p.canRead(gmail)).toBe(false);
  // A new conversation elsewhere (reset) keeps it: it is this session's own.
  p.reset();
  expect(p.pointed("s1", gmail)).toBe(true);
  // Another site in the same tab: gone, even back on the first one.
  p.tabNavigated(gmail.id, "https://evil.example/");
  p.tabNavigated(gmail.id, gmail.url);
  expect(p.pointed("s1", gmail)).toBe(false);
});

test("a pointed tab lapses on close, on a cut, on the agent's move to another site and with its session", () => {
  p.pointTab("s1", gmail);
  p.navigationByAgent(gmail.id, "https://mail.google.com/other");
  expect(p.pointed("s1", { ...gmail, url: "https://mail.google.com/other" })).toBe(true);
  p.navigationByAgent(gmail.id, "https://evil.example/");
  expect(p.pointed("s1", { ...gmail, url: "https://evil.example/" })).toBe(false);
  p.pointTab("s1", github);
  p.cut(github.id);
  expect(p.pointed("s1", github)).toBe(false);
  p.pointTab("s1", github);
  p.tabClosed(github.id);
  expect(p.pointed("s1", github)).toBe(false);
  p.pointTab("s1", github);
  p.dropSession("s1");
  expect(p.pointed("s1", github)).toBe(false);
});

test("a site app window is never pointed: it keeps its own grant", () => {
  const app: TabInfo = { id: "site:x", title: "App", url: "https://app.example/", space: "perso", site: "x" };
  p.pointTab("s1", app);
  expect(p.pointed("s1", app)).toBe(false);
});

test("a pointed tab shows as readable (badge, « couper ») and its changes are told", () => {
  const told = vi.fn();
  p.onChange(told);
  p.pointTab("s1", gmail);
  expect(told).toHaveBeenCalledTimes(1);
  expect(p.state()[gmail.id]).toEqual({ read: true, rights: [], built: false, running: false });
  // « Couper » takes it back: the next read asks.
  p.cut(gmail.id);
  expect(p.state()[gmail.id]).toBeUndefined();
  expect(p.pointed("s1", gmail)).toBe(false);
  p.pointTab("s1", gmail);
  told.mockClear();
  p.dropSession("s1");
  expect(told).toHaveBeenCalledTimes(1);
  expect(p.state()[gmail.id]).toBeUndefined();
});
