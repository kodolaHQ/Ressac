import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { expectAgentLoad, forgetAgentLoad, installAgentLoadGuard, judgeHop, pruneAgentLoads, tabIdOf } from "../chrome/agent/load-guard";

const A = "https://a.test";
const B = "https://b.test";
const TYPE_DOCUMENT = 6;
const TYPE_SCRIPT = 2;

let observe: (subject: unknown) => void = () => {};
/** The Ressac tab of a browsing context: its top's embedder, as store/index.ts looks it up; "?" plays an unnamed tab (it throws). */
const tabOf = (bc: any): string | null => {
  const tab = bc.top.embedderElement?.tab ?? null;
  if (tab === "?") throw new Error("unnamed tab");
  return tab;
};

beforeAll(() => {
  vi.stubGlobal("Ci", { nsIHttpChannel: "nsIHttpChannel", nsIContentPolicy: { TYPE_DOCUMENT } });
  vi.stubGlobal("Cr", { NS_ERROR_ABORT: 0x80004004 });
  vi.stubGlobal("Services", {
    io: { newURI: (u: string) => ({ specIgnoringRef: new URL(u).href.replace(/#.*/, "") }) },
    obs: { addObserver: (o: { observe: (s: unknown) => void }, topic: string) => topic === "http-on-modify-request" && (observe = (s) => o.observe(s)) },
  });
  installAgentLoadGuard((bc) => (bc.top.real ? tabIdOf(bc, "id", "parking") : tabOf(bc)));
});

/** A fake http channel of tab `tab`: `cancelled` records the cancel. */
/** `hops`: redirects in the web-visible chain; `internal`: internal ones (HSTS, HTTPS-First), in the full chain only. */
function channel(url: string, o: { tab?: string; type?: number; hops?: number; internal?: number; metaRefresh?: boolean; gesture?: boolean; subframe?: boolean; noContext?: boolean; broken?: boolean } = {}) {
  const top: any = { embedderElement: { tab: o.tab ?? "t1" }, parent: null };
  top.top = top;
  const bc = o.subframe ? { parent: top, top } : top;
  const ch = {
    cancelled: null as number | null,
    URI: { spec: url, specIgnoringRef: url.replace(/#.*/, "") },
    get loadInfo() {
      if (o.broken) throw new Error("dead");
      return {
        externalContentPolicyType: o.type ?? TYPE_DOCUMENT,
        browsingContext: o.noContext ? null : bc,
        redirectChain: Array(o.hops ?? 0).fill({}),
        redirectChainIncludingInternalRedirects: Array((o.hops ?? 0) + (o.internal ?? 0)).fill({}),
        isMetaRefresh: !!o.metaRefresh,
        hasValidUserGestureActivation: !!o.gesture,
      };
    },
    cancel(code: number) {
      this.cancelled = code;
    },
    QueryInterface() {
      return this;
    },
  };
  return ch;
}
const refusal = (p: Promise<never>) => p.then(() => "resolved", (e: Error & { url?: string }) => `${e.name}:${e.url}`);

it("judgeHop: hops stay on the start's origin or the allowed ones (https upgrade too); a fresh request starts, ends with a user activation, else is a hop", () => {
  const load = { start: `${A}/x`, allow: ["http://c.test"], started: false };
  const hop = (url: string, o: { redirected?: boolean; metaRefresh?: boolean; gesture?: boolean } = { redirected: true }) =>
    judgeHop(load, { url, redirected: !!o.redirected, metaRefresh: !!o.metaRefresh, gesture: !!o.gesture });
  expect(hop(`${A}/y`)).toBe("pass");
  expect(hop("http://c.test/z")).toBe("pass");
  expect(hop("https://c.test/z")).toBe("pass");
  expect(hop(`${B}/`)).toBe("cancel");
  expect(hop(`${B}/`, { metaRefresh: true })).toBe("cancel");
  // A redirect for the start's address is still a hop, never the start.
  expect(hop(`${A}/x`)).toBe("pass");
  expect(hop(`${A}/x`, {})).toBe("start");
  // A script's `location` without activation (an open redirect) is judged; with one, it is the user's.
  expect(hop(`${B}/old`, {})).toBe("cancel");
  expect(judgeHop({ ...load, started: true }, { url: `${B}/`, redirected: false, metaRefresh: false, gesture: false })).toBe("cancel");
  expect(judgeHop({ ...load, started: true }, { url: `${B}/`, redirected: false, metaRefresh: false, gesture: true })).toBe("end");
  // An http start's hop to http elsewhere is not an upgrade of an allowed origin.
  expect(judgeHop({ start: "http://a.test/", allow: [], started: true }, { url: "http://b.test/", redirected: true, metaRefresh: false, gesture: false })).toBe("cancel");
});

it("a 302 off the allowed origins is aborted and rejects the load with LoadRefused(hop); the start passes", async () => {
  const refused = refusal(expectAgentLoad("t1", `${A}/x#frag`, [A]));
  const start = channel(`${A}/x`);
  observe(start);
  expect(start.cancelled).toBeNull();
  const same = channel(`${A}/login`, { hops: 1 });
  observe(same);
  expect(same.cancelled).toBeNull();
  const off = channel(`${B}/landing`, { hops: 2 });
  observe(off);
  expect(off.cancelled).toBe(0x80004004);
  expect(await refused).toBe(`LoadRefused:${B}/landing`);
  // Judged once: the load is gone, the next redirect in that tab is not the agent's.
  const later = channel(`${B}/again`, { hops: 1 });
  observe(later);
  expect(later.cancelled).toBeNull();
});

it("allow [] (locked with nothing allowed): any hop off the start's origin is refused, a meta refresh after the load too", async () => {
  const refused = refusal(expectAgentLoad("t1", `${A}/`, []));
  observe(channel(`${A}/`));
  const refresh = channel(`${B}/`, { metaRefresh: true });
  observe(refresh);
  expect(refresh.cancelled).not.toBeNull();
  expect(await refused).toBe(`LoadRefused:${B}/`);
});

it("an internal upgrade (HSTS, HTTPS-First: not in redirectChain) is a hop, so the 302 after it is still judged", async () => {
  const refused = refusal(expectAgentLoad("t1", "http://a.test/x", ["http://a.test"]));
  observe(channel("http://a.test/x"));
  const upgrade = channel("https://a.test/x", { internal: 1 });
  observe(upgrade);
  expect(upgrade.cancelled).toBeNull();
  const off = channel(`${B}/`, { hops: 1, internal: 1 });
  observe(off);
  expect(off.cancelled).not.toBeNull();
  expect(await refused).toBe(`LoadRefused:${B}/`);
});

it("a script's redirect without user activation after the load (an open redirect) is cancelled; a user-activated load passes and ends the record", async () => {
  const refused = refusal(expectAgentLoad("t1", `${A}/`, [A]));
  observe(channel(`${A}/`));
  const same = channel(`${A}/next`);
  observe(same);
  expect(same.cancelled).toBeNull();
  const script = channel(`${B}/?leak=1`);
  observe(script);
  expect(script.cancelled).not.toBeNull();
  expect(await refused).toBe(`LoadRefused:${B}/?leak=1`);

  void refusal(expectAgentLoad("t1", `${A}/`, [A]));
  observe(channel(`${A}/`));
  const click = channel(`${B}/`, { gesture: true });
  observe(click);
  expect(click.cancelled).toBeNull();
  const after = channel(`${B}/more`);
  observe(after);
  expect(after.cancelled).toBeNull();
});

it("an agent load waiting and a document request the guard cannot place (no browsing context, an unnamed tab): cancelled", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const refused = refusal(expectAgentLoad("t1", `${A}/`, [A]));
  for (const ch of [channel(`${A}/`, { noContext: true }), channel(`${A}/`, { tab: "?" })]) {
    observe(ch);
    expect(ch.cancelled).not.toBeNull();
  }
  error.mockRestore();
  forgetAgentLoad("t1");
  void refused;
  // With no agent load waiting, nothing is judged at all.
  const idle = channel(`${B}/`, { tab: "?", hops: 1 });
  observe(idle);
  expect(idle.cancelled).toBeNull();
});

it("not judged: allow null, other tabs, subresources, subframes, and what the page or the user starts after the load", () => {
  expectAgentLoad("t1", `${A}/`, null);
  const free = channel(`${B}/`, { hops: 1 });
  observe(free);
  expect(free.cancelled).toBeNull();

  void refusal(expectAgentLoad("t1", `${A}/`, [A]));
  for (const ch of [channel(`${B}/`, { tab: "t2", hops: 1 }), channel(`${B}/s.js`, { type: TYPE_SCRIPT, hops: 1 }), channel(`${B}/f`, { subframe: true, hops: 1 })]) {
    observe(ch);
    expect(ch.cancelled).toBeNull();
  }
  observe(channel(`${A}/`));
  // A load with a user activation (a click, a form sent by hand) ends the agent load: its redirect is not judged.
  const click = channel(`${B}/post`, { gesture: true });
  observe(click);
  expect(click.cancelled).toBeNull();
  const own = channel(`${B}/after`, { hops: 1 });
  observe(own);
  expect(own.cancelled).toBeNull();

  // The user's typed address takes the tab before the agent load started.
  void refusal(expectAgentLoad("t1", `${A}/`, [A]));
  forgetAgentLoad("t1");
  const typed = channel(`${B}/`, { hops: 1 });
  observe(typed);
  expect(typed.cancelled).toBeNull();
});

it("an error while judging a waiting agent load cancels the request and refuses the load (fails closed)", async () => {
  const refused = refusal(expectAgentLoad("t1", `${A}/`, [A]));
  const broken = channel(`${A}/`, { broken: true });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  observe(broken);
  expect(broken.cancelled).not.toBeNull();
  error.mockRestore();
  // No load to refuse when loadInfo itself failed: the next hop is still judged.
  const off = channel(`${B}/`, { hops: 1 });
  observe(off);
  expect(off.cancelled).not.toBeNull();
  expect(await refused).toBe(`LoadRefused:${B}/`);
});

it("referrer: no Ressac pref file sets a network.http.referer.* pref (the engine's default policy, 2, stays)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(js|patch|mozconfig)$|mozconfig$/.test(f) ? [p] : [];
    });
  const root = join(__dirname, "..");
  const prefFiles = [...files(join(root, "src")), ...files(join(root, "configs"))];
  expect(prefFiles.some((p) => p.endsWith("ressac.js"))).toBe(true);
  for (const p of prefFiles) expect(readFileSync(p, "utf8"), p).not.toMatch(/network\.http\.referer\./);
});

it("a closed tab's record is pruned (store/index.ts on each tab change): an unnamed tab's load then passes", () => {
  void refusal(expectAgentLoad("t9", `${A}/`, [A]));
  // Another tab closes: t9 stays armed.
  pruneAgentLoads((id) => id === "t9");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const armed = channel(`${B}/`, { tab: "?" });
  observe(armed);
  expect(armed.cancelled).not.toBeNull();
  error.mockRestore();
  // t9 closes.
  pruneAgentLoads((id) => id !== "t9");
  const free = channel(`${B}/`, { tab: "?" });
  observe(free);
  expect(free.cancelled).toBeNull();
});

it("a window released while its tab stays in the state (kept last window, tear-off): the record survives and its hop is still judged", async () => {
  const refused = refusal(expectAgentLoad("t8", `${A}/`, [A]));
  // store/index.ts prunes by the state's tabs only: t8 is still there.
  const state = { tabs: { t8: {} } as Record<string, unknown> };
  pruneAgentLoads((id) => id in state.tabs);
  // Reopened, TabSync loads the tab: the start, then its 302 off the allowed origins.
  observe(channel(`${A}/`, { tab: "t8" }));
  const off = channel(`${B}/`, { tab: "t8", hops: 1 });
  observe(off);
  expect(off.cancelled).not.toBeNull();
  expect(await refused).toBe(`LoadRefused:${B}/`);
});

it("tabIdOf: a document whose window has no gBrowser cannot be named, so it is cancelled while an agent load waits and passes without one", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const named = { top: { embedderElement: { ownerDocument: { defaultView: { gBrowser: { getTabForBrowser: () => ({ getAttribute: () => "t9" }) } } } } } };
  expect(tabIdOf(named, "id", "parking")).toBe("t9");
  const top: any = { real: true, parent: null, embedderElement: { ownerDocument: { defaultView: {} } } };
  top.top = top;
  expect(() => tabIdOf(top, "id", "parking")).toThrow();
  const load = (): any => {
    const ch: any = channel(`${A}/`);
    Object.defineProperty(ch, "loadInfo", { get: () => ({ externalContentPolicyType: TYPE_DOCUMENT, browsingContext: top }) });
    return ch;
  };
  void expectAgentLoad("t1", `${A}/`, [A]).catch(() => {});
  const waiting = load();
  observe(waiting);
  expect(waiting.cancelled).not.toBeNull();
  forgetAgentLoad("t1");
  const idle = load();
  observe(idle);
  expect(idle.cancelled).toBeNull();
  error.mockRestore();
});
