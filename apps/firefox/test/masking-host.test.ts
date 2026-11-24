import { expect, it, vi } from "vitest";
import { Masker, tabZone } from "../../../packages/kernel/src/index.ts";
import { readFileSync } from "node:fs";
import { hostPassport, maskGuess, maskPaste, maskRuns, maskingStatus, revealLocal } from "../host/masking";

const lock = (info: { since: string; names: string[] } | null) => ({ info: () => info && { ...info, codes: {} } });

it("revealLocal answers only the window's own session, only for a label, and nothing without a kernel", () => {
  const masker = new Masker();
  masker.open("s1", "f1");
  masker.open("s2", "f2");
  const [label] = masker.maskTyped("f1", "mon IBAN FR76 3000 6000 0112 3456 7890 189").text.match(/⟨[a-z]+-[a-z0-9]{8}⟩/)!;
  expect(revealLocal(masker, "f1", label)).toBe("FR76 3000 6000 0112 3456 7890 189");
  expect(revealLocal(masker, "f2", label)).toBeNull();
  expect(revealLocal(masker, "f1", `${label} `)).toBeNull();
  expect(revealLocal(masker, "f1", 42)).toBeNull();
  expect(revealLocal(masker, undefined, label)).toBeNull();
  expect(revealLocal(null, "f1", label)).toBeNull();
  masker.close("s1");
  expect(revealLocal(masker, "f1", label)).toBeNull();
});

it("maskPaste masks with the window's own session table, names what it hid, never gives the original back; nothing without a kernel", async () => {
  const masker = new Masker();
  masker.open("s1", "f1");
  const ready = hostPassport({});
  ready.markReady([]);
  const paste = (m: Masker | null, win: unknown, text: unknown) => maskPaste(() => m, ready, win, text);
  const iban = "FR76 3000 6000 " + "0112 3456 7890 189";
  const r = (await paste(masker, "f1", `vire sur ${iban} stp`))!;
  const [label] = r.text.match(/⟨iban-[a-z0-9]{8}⟩/)!;
  expect(r).toEqual({ text: `vire sur ${label} stp`, names: ["votre IBAN"] });
  expect(revealLocal(masker, "f1", label)).toBe(iban);
  expect(await paste(masker, "f1", "rien à cacher")).toEqual({ text: "rien à cacher", names: [] });
  expect(await paste(masker, "f1", 42)).toBeNull();
  expect(await paste(masker, undefined, "x")).toBeNull();
  expect(await paste(null, "f1", iban)).toBeNull();
});

it("maskPaste waits for the passports: masked with them once ready; at the cap, nothing (as without a kernel)", async () => {
  const store = hostPassport({});
  const masker = new Masker({ passport: store });
  masker.open("s1", "f1");
  const created = "2026-11-23T10:00:00.000Z";
  const pending = maskPaste(() => masker, store, "f1", "signé Camille Aubrac");
  store.replace("perso", [{ id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Aubrac" }, variants: [], origins: [], how: "typed", created, updated: created }]);
  store.markReady([]);
  expect((await pending)!.text).toMatch(/^signé ⟨nom-[a-z0-9]{8}⟩$/);
  const never = hostPassport({});
  expect(await maskPaste(() => masker, never, "f1", "signé Camille Aubrac", 1)).toBeNull();
});

it("maskingStatus: the lock's names, the window's uncovered conversation, the notice of its current session only, the unreadable passports", () => {
  const masker = new Masker();
  masker.open("s1", "f1", { uncovered: true });
  const notices = new Map([["s1", "Remplissage bloqué."]]);
  const passport = hostPassport({});
  passport.markReady(["perso"]);
  expect(maskingStatus(masker, lock({ since: "x", names: ["votre code"] }), notices, "f1", true, passport)).toEqual({ locked: ["votre code"], lockedAgreement: "one-m", uncovered: true, uncoveredPassport: [], notice: "Remplissage bloqué.", extensionReads: true, passportUnreadable: ["perso"] });
  masker.open("s2", "f1");
  passport.replace("perso", []);
  expect(maskingStatus(masker, lock(null), notices, "f1", false, passport)).toEqual({ locked: null, lockedAgreement: "one-m", uncovered: false, uncoveredPassport: [], notice: null, extensionReads: false, passportUnreadable: [] });
  // A passport addition: its own cause, with the entries (profile and id) that marked the conversation.
  masker.markUncovered("s2", [{ profile: "perso", id: "a" }]);
  expect(maskingStatus(masker, lock(null), notices, "f1", false, passport)).toMatchObject({ uncovered: false, uncoveredPassport: [{ profile: "perso", id: "a" }] });
  expect(maskingStatus(null, lock({ since: "", names: [] }), notices, "f1", false, passport)).toEqual({ locked: [], lockedAgreement: "one-m", uncovered: false, uncoveredPassport: [], notice: null, extensionReads: false, passportUnreadable: [] });
});

it("hostPassport: waits for the chrome's ready; the loopback seam only from RESSAC_TEST_LOCAL_ADDRESSES, which a packaged host deletes first", async () => {
  const store = hostPassport({});
  let ready = false;
  void store.ready.then(() => (ready = true));
  await Promise.resolve();
  expect(ready).toBe(false);
  store.markReady([]);
  await store.ready;
  expect(store.localAddresses).toBe(false);
  expect(hostPassport({ RESSAC_TEST_LOCAL_ADDRESSES: "1" }).localAddresses).toBe(true);
  // The packaged host deletes every RESSAC_TEST_* before its first import (test-env.test.ts); the store comes after.
  const host = readFileSync("host/host.ts", "utf8");
  const scrub = host.indexOf('if (k.startsWith("RESSAC_TEST_") || DEV_OVERRIDES.includes(k)) delete process.env[k]');
  expect(scrub).toBeGreaterThan(0);
  expect(host.indexOf("hostPassport(process.env)")).toBeGreaterThan(scrub);
  expect(host.match(/new PassportStore\(/g)).toBeNull();
  expect(host).toMatch(/createKernel\(\{[^]*?\n    passport,\n/);
});

it("RemoteBridge: the masking cards go to Firefox with their window, a taken-down one answers no, the notice stays in the host", async () => {
  const { RemoteBridge } = await import("../host/remote-bridge");
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc = { request: (method: string, params: unknown[], signal?: AbortSignal) => (calls.push({ method, params }), new Promise((ok, no) => (signal ? signal.addEventListener("abort", () => no(new Error("aborted"))) : ok(true)))), notify() {} };
  const notices: unknown[] = [];
  const bridge = new RemoteBridge(rpc as never, undefined, undefined, (o, w) => notices.push([o, w]));
  const card = { name: "votre code", reason: "r", agent: "A", conversation: "c", text: "t", label: "⟨code-1a2b3c4d⟩" };
  expect(await bridge.askReveal(card, "f1")).toBe(true);
  expect(calls.at(-1)).toEqual({ method: "askReveal", params: [card, "f1"] });
  const ac = new AbortController();
  const fill = bridge.askFill({ name: "n", field: "f", where: "w", touchId: true, labels: [], agent: "A" }, "f1", ac.signal);
  ac.abort();
  expect(await fill).toEqual({ yes: false });
  bridge.askLockNotice({ text: "bloqué" }, "f1");
  expect(notices).toEqual([[{ text: "bloqué" }, "f1"]]);
  expect(calls.map((c) => c.method)).toEqual(["askReveal", "askFill"]);
});

it("RemoteBridge: a fill card's usernames stay in the host, given to « Voir » in the card's own window only, gone once answered", async () => {
  const { RemoteBridge } = await import("../host/remote-bridge");
  const sent: unknown[][] = [];
  let answer!: (v: unknown) => void;
  const rpc = { request: (_m: string, params: unknown[]) => (sent.push(params), new Promise((ok) => (answer = ok))), notify() {} };
  const bridge = new RemoteBridge(rpc as never);
  const fill = bridge.askFill({ name: "votre mot de passe", field: "Mot de passe", where: "https://a.test/", touchId: false, labels: [], logins: ["camille", "dominique"], agent: "A" }, "f1");
  const card = sent[0]![0] as { loginCount: number; loginsRef: string };
  expect(JSON.stringify(sent)).not.toMatch(/camille|dominique/);
  expect(card).toMatchObject({ loginCount: 2, loginsRef: expect.any(String) });
  expect(bridge.loginsFor(card.loginsRef, "f1")).toEqual(["camille", "dominique"]);
  expect(bridge.loginsFor(card.loginsRef, "f2")).toBeNull();
  expect(bridge.loginsFor("autre", "f1")).toBeNull();
  answer({ yes: true, login: 1 });
  expect(await fill).toEqual({ yes: true, login: 1 });
  expect(bridge.loginsFor(card.loginsRef, "f1")).toBeNull();

  // No window named by the kernel (the card goes to the active one): never given.
  void bridge.askFill({ name: "n", field: "f", where: "w", touchId: false, labels: [], logins: ["camille"], agent: "A" }, undefined);
  expect(bridge.loginsFor((sent[1]![0] as { loginsRef: string }).loginsRef, "f1")).toBeNull();
});

it("RemoteBridge: a fill card's passport choices go by reference; their values stay in the host for « Voir » in the card's window (ruling F10)", async () => {
  const { RemoteBridge } = await import("../host/remote-bridge");
  const sent: unknown[][] = [];
  let answer!: (v: unknown) => void;
  const rpc = { request: (_m: string, params: unknown[]) => (sent.push(params), new Promise((ok) => (answer = ok))), notify() {} };
  const bridge = new RemoteBridge(rpc as never);
  const rows = [{ field: "Adresse", name: "votre adresse", choices: [{ ref: "r1", shown: "1• r•• d•• T•••••••", value: "1 rue des Tanneurs" }] }, { field: "Note", name: "un texte de l'agent" }];
  const fill = bridge.askFill({ name: "n", field: "f", where: "w", touchId: false, labels: [], agent: "A", rows }, "f1");
  expect(JSON.stringify(sent)).not.toContain("Tanneurs");
  expect((sent[0]![0] as { rows: unknown }).rows).toEqual([{ field: "Adresse", name: "votre adresse", choices: [{ ref: "r1", shown: "1• r•• d•• T•••••••" }] }, { field: "Note", name: "un texte de l'agent" }]);
  expect(bridge.passportFor("r1", "f1")).toBe("1 rue des Tanneurs");
  expect(bridge.passportFor("r1", "f2")).toBeNull();
  expect(bridge.passportFor("r2", "f1")).toBeNull();
  answer({ yes: true, picks: ["r1", null] });
  expect(await fill).toEqual({ yes: true, picks: ["r1", null] });
  expect(bridge.passportFor("r1", "f1")).toBeNull();
});

it("pushPassports: each profile's passport, then ready naming the unreadable ones, last (Review Focus 3: each host start)", async () => {
  const { pushPassports } = await import("../chrome/agent/host");
  const sent: unknown[][] = [];
  const request = async (...a: unknown[]) => void sent.push(a);
  const loaded = (profile: string, state: "ok" | "unreadable" | "newer") => ({ profile, state, entries: state === "unreadable" ? [] : [{ id: profile }], dropped: 0, revision: "" });
  const files = { list: async () => ["a", "b", "c"], load: async (p: string) => loaded(p, p === "b" ? "unreadable" : p === "c" ? "newer" : "ok") };
  await pushPassports(request, files as never);
  expect(sent.slice(0, 2)).toEqual(expect.arrayContaining([["passport.replace", { profile: "a", entries: [{ id: "a" }] }], ["passport.replace", { profile: "c", entries: [{ id: "c" }] }]]));
  expect(sent.slice(2)).toEqual([["passport.ready", { unreadable: ["b"] }]]);
});

it("pushPassports: a read still pending at the cap is unreadable for now, then pushed once it completes, after ready", async () => {
  const { pushPassports } = await import("../chrome/agent/host");
  const sent: unknown[][] = [];
  const request = async (...a: unknown[]) => void sent.push(a);
  let finish!: (r: unknown) => void;
  const slow = new Promise((r) => (finish = r));
  const files = { list: async () => ["slow"], load: () => slow };
  await pushPassports(request, files as never, 1);
  expect(sent).toEqual([["passport.ready", { unreadable: ["slow"] }]]);
  finish({ profile: "slow", state: "ok", entries: [], dropped: 0, revision: "" });
  await vi.waitFor(() => expect(sent.at(-1)).toEqual(["passport.replace", { profile: "slow", entries: [] }]));
});

it("pushPassports: a load that throws counts as unreadable, ready still comes; the passport hosts are known only once the loads settled", async () => {
  vi.resetModules();
  const { pushPassports } = await import("../chrome/agent/host");
  const { onPassportHost } = await import("../chrome/passport/hosts");
  const sent: unknown[][] = [];
  const request = async (...a: unknown[]) => void sent.push(a);
  let fail!: (e: Error) => void;
  const files = { list: async () => ["bad", "ok"], load: (p: string) => (p === "bad" ? new Promise((_, no) => (fail = no)) : Promise.resolve({ profile: p, state: "ok", entries: [], dropped: 0, revision: "" })) };
  // Before the first push settles every host counts as a passport's: an agent extension reaches none (fail closed).
  expect(onPassportHost("https://any.test/")).toBe(true);
  const pushing = pushPassports(request, files as never);
  await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
  expect(onPassportHost("https://any.test/")).toBe(true);
  fail(new Error("boom"));
  await pushing;
  expect(sent.at(-1)).toEqual(["passport.ready", { unreadable: ["bad"] }]);
  await vi.waitFor(() => expect(onPassportHost("https://any.test/")).toBe(false));
});

it("pushPassports: a load past the cap keeps every host refused until it settles, though ready went at the cap", async () => {
  vi.resetModules();
  const { pushPassports } = await import("../chrome/agent/host");
  const { onPassportHost } = await import("../chrome/passport/hosts");
  const sent: unknown[][] = [];
  let finish!: (r: unknown) => void;
  const files = { list: async () => ["slow"], load: () => new Promise((r) => (finish = r)) };
  await pushPassports(async (...a: unknown[]) => void sent.push(a), files as never, 1);
  expect(sent).toEqual([["passport.ready", { unreadable: ["slow"] }]]);
  expect(onPassportHost("https://any.test/")).toBe(true);
  finish({ profile: "slow", state: "ok", entries: [{ origins: ["banque.test"] }], dropped: 0, revision: "" });
  await vi.waitFor(() => expect(onPassportHost("https://any.test/")).toBe(false));
});

it("pushPassports: no passport file, the hosts are known at once", async () => {
  vi.resetModules();
  const { pushPassports } = await import("../chrome/agent/host");
  const { onPassportHost } = await import("../chrome/passport/hosts");
  await pushPassports(async () => {}, { list: async () => [], load: async () => { throw new Error("unused"); } } as never);
  await vi.waitFor(() => expect(onPassportHost("https://any.test/")).toBe(false));
});

it("mask.runs: the window's session, the zone its passport origins give the tab, no label issued; no session, null", () => {
  const store = hostPassport({});
  const created = "2026-11-23T10:00:00.000Z";
  store.replace("perso", [{ id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Aubrac" }, variants: [], origins: ["banque.example"], how: "typed", created, updated: created }]);
  store.markReady([]);
  const masker = new Masker({ passport: store });
  masker.open("s1", "f1");
  // The kernel's reads of a tab: a site app the agent navigated in conversation 3 is no source.
  const agentSites = new Set(["3:site:banque"]);
  const kernel = { masker, tabZone: (s: string | null, t: Parameters<typeof tabZone>[0]) => tabZone(t, agentSites, 3, masker.originsOf(s)) };
  const iban = "FR76 3000 6000 " + "0112 3456 7890 189";
  const text = `Camille Aubrac, ${iban}`;
  const spans = (r: { runs: { start: number; end: number; type: string }[][] | null }) => r.runs!.map((rs) => rs.map((x) => [text.slice(x.start, x.end), x.type]));
  const runs = (p: Record<string, unknown>) => spans(maskRuns(kernel, { window: "f1", tab: "t1", url: "https://banque.example/compte", agentReached: false, texts: [text, "rien"], ...p }));
  expect(runs({})).toEqual([[["Camille Aubrac", "nom"], [iban, "iban"]], []]);
  // Reached by the agent, or off the passport's origins: the web zone, no name.
  expect(runs({ agentReached: true })).toEqual([[[iban, "iban"]], []]);
  expect(runs({ url: "https://news.example/" })).toEqual([[[iban, "iban"]], []]);
  // A site app: the user's until the agent navigates it in this conversation, whatever chrome's flag says.
  expect(runs({ tab: "site:poste" })).toEqual([[["Camille Aubrac", "nom"], [iban, "iban"]], []]);
  expect(runs({ tab: "site:banque" })).toEqual([[[iban, "iban"]], []]);
  const table = masker.table("s1");
  expect([table.entries("sources").length, table.entries("web").length]).toEqual([0, 0]);
  expect(maskRuns(kernel, { window: "f2", tab: "t1", url: "https://banque.example/compte", agentReached: false, texts: [text] })).toEqual({ runs: null });
  expect(maskRuns(null, { window: "f1", tab: "t1", url: "https://banque.example/", agentReached: false, texts: [text] })).toEqual({ runs: null });
  // The main token (`window: null`): its own table, no session needed, still no label issued.
  expect(spans(maskRuns(kernel, { window: null, tab: "t1", url: "https://banque.example/compte", agentReached: false, texts: [text] }))).toEqual([[["Camille Aubrac", "nom"], [iban, "iban"]]]);
  expect(masker.table(null).entries("sources").length).toBe(0);
  expect(maskRuns(null, { window: null, tab: "t1", url: "https://banque.example/", agentReached: false, texts: [text] })).toEqual({ runs: null });
  expect(() => maskRuns(kernel, { window: "f1", tab: "t1", url: "https://banque.example/", texts: [text] })).toThrow();
  expect(() => maskRuns(kernel, { window: "f1", url: "https://banque.example/", agentReached: false, texts: [text] })).toThrow();
  expect(() => maskRuns(kernel, { window: "f1", tab: "t1", url: "https://banque.example/", agentReached: false, texts: [42] })).toThrow();
});

it("mask.guess: the field, and the name's parts for a name", () => {
  expect(maskGuess({ text: "AUBRAC Camille" })).toEqual({ field: "nom", name: { given: "Camille", family: "AUBRAC" } });
  expect(maskGuess({ text: "Dossier 42" })).toEqual({ field: "libre" });
  expect(maskGuess({ text: "Camille Aubrac".repeat(30) })).toEqual({ field: "libre" });
  expect(() => maskGuess({ text: 42 })).toThrow();
  expect(() => maskGuess(null)).toThrow();
});
