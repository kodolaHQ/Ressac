import { beforeEach, expect, test, vi } from "vitest";

/** The documents Firefox knows, by inner window id (WindowGlobalParent.getByInnerWindowId). */
const globals = new Map<number, any>();
vi.stubGlobal("WindowGlobalParent", { getByInnerWindowId: (id: number) => globals.get(id) ?? null });
const { createFill } = await import("../../chrome/agent/fill");

const BANK = "https://bank.test";
const EVIL = "https://evil.test";
// Built, never written whole: a test value is never a literal.
const PASSWORD = ["pw", "e2e", "4417"].join("-");

type Sent = { name: string; data: any };
/** A document of a tab: its own origin, its parent document, the child actor's answers. */
function doc(id: number, origin: string, parent: any, bc: any, answer: (m: Sent) => unknown) {
  const sent: Sent[] = [];
  const w = {
    innerWindowId: id,
    isCurrentGlobal: true,
    documentPrincipal: { originNoSuffix: origin },
    documentURI: { filePath: "/login" },
    parentWindowContext: parent,
    browsingContext: bc,
    sent,
    getActor: (name: string) => {
      if (name !== "RessacFill") throw new Error("no actor");
      return { sendQuery: async (n: string, data: unknown) => (sent.push({ name: n, data }), answer({ name: n, data })) };
    },
  };
  globals.set(id, w);
  return w;
}

const FACTS = { type: "password", autocomplete: "", action: BANK + "/login", placement: "p1" };
/** A tab on the bank with a frame on `frameOrigin`; each child answers `facts` and `fill` as told. */
function tab(frameOrigin = BANK, answers: { facts?: unknown; fill?: unknown } = {}) {
  const top: any = { id: 1 };
  top.top = top;
  const frame: any = { id: 2, top };
  const answer = (m: Sent) => (m.name === "facts" ? ("facts" in answers ? answers.facts : FACTS) : m.name === "fill" ? ("fill" in answers ? answers.fill : "filled") : [{ n: 0, type: "password", autocomplete: "", label: "Mot de passe" }]);
  const topDoc = doc(10, BANK, null, top, answer);
  const frameDoc = doc(20, frameOrigin, topDoc, frame, answer);
  top.currentWindowGlobal = topDoc;
  frame.currentWindowGlobal = frameDoc;
  top.getAllBrowsingContextsInSubtree = () => [top, frame];
  return { browser: { browsingContext: top }, topDoc, frameDoc };
}

const saved = [
  { guid: "{a}", username: "moi", password: PASSWORD },
  { guid: "{b}", username: "autre", password: "x" + PASSWORD },
];
let t: ReturnType<typeof tab>;
let reached = false;
let logins: typeof saved;
const fill = () =>
  createFill({
    browserOf: async (id) => {
      if (id !== "t1") throw new Error("Onglet introuvable");
      return t.browser;
    },
    agentReached: () => reached,
    logins: async (origin) => (origin === BANK ? logins : []),
  });
beforeEach(() => {
  globals.clear();
  t = tab();
  reached = false;
  logins = saved;
});

test("fields: every frame's fields under handles of its own document, and every frame's origin", async () => {
  t = tab(EVIL);
  const r = await fill().fields(t.browser);
  expect(r.fields.map((f) => f.handle)).toEqual(["10:0", "20:0"]);
  expect(r.frameOrigins).toEqual([BANK, EVIL]);
});

test("fields: a frame without the actor (about:blank) gives none, its origin still counts", async () => {
  t.frameDoc.getActor = () => {
    throw new Error("no actor");
  };
  const r = await fill().fields(t.browser);
  expect(r.fields.map((f) => f.handle)).toEqual(["10:0"]);
  expect(r.frameOrigins).toEqual([BANK]);
});

test("prepare: the frame chain is the parent's, the logins are usernames only, the seal is random", async () => {
  const f = fill();
  t = tab(EVIL);
  const foreign = await f.prepare("t1", "20:0");
  expect(foreign).toMatchObject({ origin: EVIL, path: "/login", frames: [EVIL, BANK], type: "password", action: BANK + "/login", agentReached: false });
  // No saved login looked up for a field outside its own origin's frames.
  expect(foreign.logins).toEqual([]);
  t = tab();
  reached = true;
  const own = await f.prepare("t1", "20:0");
  expect(own.frames).toEqual([BANK, BANK]);
  expect(own.logins).toEqual([{ username: "moi" }, { username: "autre" }]);
  expect(JSON.stringify(own)).not.toContain(PASSWORD);
  expect(own.agentReached).toBe(true);
  expect(own.seal).not.toBe(foreign.seal);
  expect(t.frameDoc.sent[0]).toEqual({ name: "facts", data: { handle: 0 } });
});

test("prepare: a handle of another tab, a closed document, a malformed handle or a field gone is refused", async () => {
  const f = fill();
  const other = tab();
  globals.set(30, { ...other.frameDoc, innerWindowId: 30, browsingContext: { top: {} } });
  await expect(f.prepare("t1", "30:0")).rejects.toThrow();
  globals.set(20, { ...t.frameDoc, isCurrentGlobal: false });
  await expect(f.prepare("t1", "20:0")).rejects.toThrow();
  t = tab();
  await expect(f.prepare("t1", "x:0")).rejects.toThrow();
  await expect(f.prepare("t1", "20")).rejects.toThrow();
  t = tab(BANK, { facts: null });
  await expect(f.prepare("t1", "20:0")).rejects.toThrow();
  // A frame whose chain the parent cannot read: refused, never an empty chain.
  t = tab();
  t.topDoc.documentPrincipal = undefined as any;
  await expect(f.prepare("t1", "20:0")).rejects.toThrow();
});

test("commit: the value goes to the child with the seal, once; another origin than the approved one writes nothing", async () => {
  const f = fill();
  const s = await f.prepare("t1", "20:0");
  expect(await f.commit(s.seal, { text: "abc" }, s.origin)).toBe("filled");
  expect(t.frameDoc.sent.at(-1)).toEqual({ name: "fill", data: { seal: { innerWindowId: 20, handle: 0, frames: [BANK, BANK], action: BANK + "/login", type: "password", autocomplete: "", placement: "p1", partner: null, role: null }, value: "abc" } });
  expect(await f.commit(s.seal, { text: "abc" }, s.origin)).toBe("changed");
  const again = await f.prepare("t1", "20:0");
  expect(await f.commit(again.seal, { text: "abc" }, EVIL)).toBe("changed");
  expect(await f.commit("nope", { text: "abc" }, BANK)).toBe("changed");
  expect(t.frameDoc.sent.filter((m) => m.name === "fill")).toHaveLength(1);
});

test("commit: the chain or the document changed since the seal writes nothing", async () => {
  const f = fill();
  let s = await f.prepare("t1", "20:0");
  t.topDoc.documentPrincipal = { originNoSuffix: EVIL };
  expect(await f.commit(s.seal, { text: "a" }, s.origin)).toBe("changed");
  t = tab();
  s = await f.prepare("t1", "20:0");
  t.frameDoc.isCurrentGlobal = false;
  expect(await f.commit(s.seal, { text: "a" }, s.origin)).toBe("changed");
  t = tab();
  s = await f.prepare("t1", "20:0");
  // The tab's browser replaced (closed and reopened, gone private): not the tab sealed.
  t = tab();
  expect(await f.commit(s.seal, { text: "a" }, s.origin)).toBe("changed");
});

test("commit: the child's « changed » or any odd answer is « changed »", async () => {
  for (const answer of ["changed", "yes", undefined]) {
    t = tab(BANK, { fill: answer });
    const f = fill();
    const s = await f.prepare("t1", "20:0");
    expect(await f.commit(s.seal, { text: "a" }, s.origin)).toBe("changed");
  }
});

test("commit: a saved login is fetched here by the login chosen, never from the kernel", async () => {
  const f = fill();
  let s = await f.prepare("t1", "20:0");
  expect(await f.commit(s.seal, { savedLogin: "password", login: 1 }, s.origin)).toBe("filled");
  expect(t.frameDoc.sent.at(-1)!.data.value).toBe("x" + PASSWORD);
  s = await f.prepare("t1", "20:0");
  expect(await f.commit(s.seal, { savedLogin: "password" }, s.origin)).toBe("filled");
  expect(t.frameDoc.sent.at(-1)!.data.value).toBe(PASSWORD);
  // The login list changed between the card and the fill: the chosen one is found by its id, or nothing goes.
  s = await f.prepare("t1", "20:0");
  logins = [saved[1]!];
  expect(await f.commit(s.seal, { savedLogin: "password", login: 0 }, s.origin)).toBe("changed");
  s = await f.prepare("t1", "20:0");
  expect(await f.commit(s.seal, { savedLogin: "password", login: 5 }, s.origin)).toBe("changed");
});

test("commit: a saved login never goes outside its exact origin, nor in a field it is not for", async () => {
  const cases: [string, () => void][] = [
    ["a frame of another origin", () => (t = tab(EVIL))],
    ["a form sending elsewhere", () => (t = tab(BANK, { facts: { ...FACTS, action: EVIL + "/x" } }))],
    ["a text field", () => (t = tab(BANK, { facts: { ...FACTS, type: "text" } }))],
  ];
  for (const [what, setup] of cases) {
    setup();
    logins = saved;
    const f = createFill({ browserOf: async () => t.browser, agentReached: () => false, logins: async () => saved });
    const s = await f.prepare("t1", "20:0");
    expect(await f.commit(s.seal, { savedLogin: "password" }, s.origin), what).toBe("changed");
    expect(t.frameDoc.sent.some((m) => m.name === "fill"), what).toBe(false);
  }
  // The username goes only in a field marked for it.
  t = tab(BANK, { facts: { ...FACTS, type: "text", autocomplete: "username" } });
  const f = fill();
  const s = await f.prepare("t1", "20:0");
  expect(await f.commit(s.seal, { savedLogin: "username" }, s.origin)).toBe("filled");
  expect(t.frameDoc.sent.at(-1)!.data.value).toBe("moi");
});

test("prepare: the login form's other field, as the child names it, comes back as a handle of the same document; only for a login on its own origin", async () => {
  t = tab(BANK, { facts: { ...FACTS, partner: 3, role: "password" } });
  expect((await fill().prepare("t1", "20:0")).partner).toBe("20:3");
  t = tab(EVIL, { facts: { ...FACTS, partner: 3, role: "password" } });
  expect((await fill().prepare("t1", "20:0")).partner).toBeUndefined();
  for (const [partner, role] of [[null, "password"], [-1, "password"], [1.5, "password"], ["3", "password"], [3, null], [3, "admin"]]) {
    t = tab(BANK, { facts: { ...FACTS, partner, role } });
    expect(await fill().prepare("t1", "20:0")).not.toHaveProperty("partner");
  }
});

test("commit: the username goes into a plain text field only as Firefox's username of a pair, and the pairing travels in the seal", async () => {
  // Paired: the logins are looked up and the username fills, the pair sealed with it.
  t = tab(BANK, { facts: { ...FACTS, type: "text", autocomplete: "", partner: 1, role: "username" } });
  let f = fill();
  let s = await f.prepare("t1", "20:0");
  expect(s.logins).toEqual([{ username: "moi" }, { username: "autre" }]);
  expect(await f.commit(s.seal, { savedLogin: "username", login: 1 }, s.origin)).toBe("filled");
  expect(t.frameDoc.sent.at(-1)!.data).toMatchObject({ seal: { partner: 1, role: "username" }, value: "autre" });
  // Never the password into it.
  expect(await f.commit((await f.prepare("t1", "20:0")).seal, { savedLogin: "password" }, BANK)).toBe("changed");
  // Alone (no pair): nothing, as before.
  t = tab(BANK, { facts: { ...FACTS, type: "text", autocomplete: "" } });
  f = fill();
  s = await f.prepare("t1", "20:0");
  expect(s.logins).toEqual([]);
  expect(await f.commit(s.seal, { savedLogin: "username" }, s.origin)).toBe("changed");
});

test("remember (task 13b): only a seal the card ticked, once its write lands, hands its site to chrome; the commit answers the same either way", async () => {
  const remembered = vi.fn(async () => {
    throw new Error("save failed");
  });
  const f = createFill({ browserOf: async () => t.browser, agentReached: () => false, logins: async () => [], remembered });
  const ref = { profile: "perso", id: "0000000000000001", window: "w1" };
  const plain = await f.prepare("t1", "20:0");
  expect(await f.commit(plain.seal, { text: "abc" }, plain.origin)).toBe("filled");
  const ticked = await f.prepare("t1", "20:0");
  f.remember(ticked.seal, ref);
  f.remember("nope", ref);
  expect(await f.commit(ticked.seal, { text: "abc" }, ticked.origin)).toBe("filled");
  expect(remembered.mock.calls).toEqual([["t1", BANK, ref]]);
  // Not written: nothing remembered.
  t = tab(BANK, { fill: "changed" });
  const changed = await f.prepare("t1", "20:0");
  f.remember(changed.seal, ref);
  expect(await f.commit(changed.seal, { text: "abc" }, changed.origin)).toBe("changed");
  expect(remembered).toHaveBeenCalledTimes(1);
});
