import { afterEach, describe, expect, it, vi } from "vitest";
import { createPasswordSettings } from "../../chrome/passwords/settings";

type Stored = { guid: string; origin: string; username: string; password: string };

function setup(o: { pass?: boolean; primary?: boolean; screenLocked?: () => boolean; failWrite?: boolean } = {}) {
  let clock = 1_000_000;
  let n = 0;
  const store: Stored[] = [
    { guid: "g1", origin: "https://zeta.test", username: "camille", password: "mot-de-passe-test-1" },
    { guid: "g2", origin: "https://alpha.test", username: "zoe", password: "mot-de-passe-test-2" },
    { guid: "g3", origin: "https://alpha.test", username: "camille", password: "mot-de-passe-test-3" },
    { guid: "g4", origin: "chrome://ressac", username: "aubrac", password: "mot-de-passe-test-4" },
  ];
  const fail = () => {
    if (o.failWrite) throw new Error("disk");
  };
  const logins = {
    all: vi.fn(async () => store.map((l) => ({ ...l }))),
    add: vi.fn(async (l: { origin: string; username: string; password: string }) => (fail(), store.push({ guid: `new${++n}`, ...l }), `new${n}`)),
    modify: vi.fn(async (guid: string, c: { username: string; password: string }) => (fail(), void Object.assign(store.find((l) => l.guid === guid)!, c))),
    remove: vi.fn(async (guid: string) => (fail(), void store.splice(store.findIndex((l) => l.guid === guid), 1))),
    primaryPassword: vi.fn(() => o.primary ?? false),
  };
  const reauth = vi.fn(async () => o.pass ?? true);
  const copy = vi.fn();
  const s = createPasswordSettings({ logins, reauth, copy, now: () => clock, times: { unlockMs: 300_000, showMs: 20_000 }, ...(o.screenLocked ? { screenLocked: o.screenLocked } : {}) });
  const snapshot = () => JSON.stringify(store);
  return { s, store, logins, reauth, copy, snapshot, tick: (ms: number) => (clock += ms) };
}

afterEach(() => vi.useRealTimers());

describe("password settings (chrome)", () => {
  it("list: guid, origin, host and username only, sorted by host then username", async () => {
    const { s } = setup();
    const list = await s.list();
    expect(list).toEqual([
      { guid: "g3", origin: "https://alpha.test", host: "alpha.test", username: "camille" },
      { guid: "g2", origin: "https://alpha.test", host: "alpha.test", username: "zoe" },
      { guid: "g4", origin: "chrome://ressac", host: "chrome://ressac", username: "aubrac" },
      { guid: "g1", origin: "https://zeta.test", host: "zeta.test", username: "camille" },
    ]);
    expect(JSON.stringify(list)).not.toContain("mot-de-passe");
  });

  it("list: nothing read while a Firefox primary password is set (never a Firefox prompt)", async () => {
    const { s, logins } = setup({ primary: true });
    expect(await s.list()).toEqual([]);
    expect(logins.all).not.toHaveBeenCalled();
  });

  it("unlock asks Touch ID with the reason; a refusal or a primary password gives no token", async () => {
    const ok = setup();
    expect(await ok.s.unlock("gérer vos mots de passe")).toMatchObject({ token: expect.any(String), until: 1_300_000, showMs: 20_000 });
    expect(ok.reauth).toHaveBeenCalledWith("gérer vos mots de passe");
    const no = setup({ pass: false });
    expect(await no.s.unlock("r")).toBeNull();
    const primary = setup({ primary: true });
    expect(await primary.s.unlock("r")).toBeNull();
    expect(primary.reauth).not.toHaveBeenCalled();
  });

  const refusals: [string, (x: ReturnType<typeof setup>) => Promise<string>][] = [
    ["no token", async () => ""],
    ["a made-up token", async () => "made-up"],
    ["a locked token", async ({ s }) => {
      const u = (await s.unlock("r"))!;
      s.lock(u.token);
      return u.token;
    }],
    ["after lockAll", async ({ s }) => {
      const u = (await s.unlock("r"))!;
      s.lockAll();
      return u.token;
    }],
    ["past 5 minutes", async ({ s, tick }) => {
      const u = (await s.unlock("r"))!;
      tick(300_000);
      return u.token;
    }],
    ];
  for (const [name, tokenOf] of refusals)
    it(`${name}: reveal, copy, add, edit and remove refused, store unchanged, nothing copied`, async () => {
      const x = setup();
      const token = await tokenOf(x);
      const before = x.snapshot();
      expect(await x.s.reveal(token, "g1")).toBeNull();
      expect(await x.s.copyPassword(token, "g1")).toBe(false);
      expect(await x.s.add(token, { origin: "https://new.test", username: "u", password: "mot-de-passe-test-9" })).toEqual({ ok: false, error: "locked" });
      expect(await x.s.edit(token, "g1", { username: "u", password: "mot-de-passe-test-9" })).toEqual({ ok: false, error: "locked" });
      expect(await x.s.remove(token, "g1")).toEqual({ ok: false, error: "locked" });
      expect(x.snapshot()).toBe(before);
      expect(x.copy).not.toHaveBeenCalled();
    });

  it("a primary password set after the unlock: everything refused, nothing read", async () => {
    const x = setup();
    const { token } = (await x.s.unlock("r"))!;
    x.logins.primaryPassword.mockReturnValue(true);
    const before = x.snapshot();
    expect(await x.s.reveal(token, "g1")).toBeNull();
    expect(await x.s.copyPassword(token, "g1")).toBe(false);
    expect(await x.s.copyUsername("g1")).toBe(false);
    expect(await x.s.add(token, { origin: "https://new.test", username: "u", password: "p" })).toEqual({ ok: false, error: "primary" });
    expect(await x.s.edit(token, "g1", { username: "u", password: "p" })).toEqual({ ok: false, error: "primary" });
    expect(await x.s.remove(token, "g1")).toEqual({ ok: false, error: "primary" });
    expect(x.snapshot()).toBe(before);
    expect(x.copy).not.toHaveBeenCalled();
    expect(x.logins.all).not.toHaveBeenCalled();
  });

  it("reveal gives that one password; copyPassword copies it concealed; copyUsername needs no token", async () => {
    const { s, copy } = setup();
    const { token } = (await s.unlock("r"))!;
    expect(await s.reveal(token, "g2")).toBe("mot-de-passe-test-2");
    expect(await s.reveal(token, "nope")).toBeNull();
    expect(await s.copyPassword(token, "g2")).toBe(true);
    expect(copy).toHaveBeenLastCalledWith("mot-de-passe-test-2", true);
    s.lockAll();
    expect(await s.copyUsername("g2")).toBe(true);
    expect(copy).toHaveBeenLastCalledWith("zoe", false);
    expect(await s.copyUsername("nope")).toBe(false);
  });

  it("add: the origin normalised; bad origins, an empty password and a duplicate refused", async () => {
    const { s, store, snapshot } = setup();
    const { token } = (await s.unlock("r"))!;
    const r = await s.add(token, { origin: "https://Exemple.test/path?x", username: "camille", password: "mot-de-passe-test-1" });
    expect(r).toEqual({ ok: true, guid: "new1" });
    expect(store.at(-1)).toEqual({ guid: "new1", origin: "https://exemple.test", username: "camille", password: "mot-de-passe-test-1" });
    // A bare host is taken as https.
    expect(await s.add(token, { origin: "Autre.test", username: "camille", password: "mot-de-passe-test-1" })).toEqual({ ok: true, guid: "new2" });
    expect(store.at(-1)!.origin).toBe("https://autre.test");
    const before = snapshot();
    for (const origin of ["javascript:alert(1)", "file:///x", "about:blank", "not a url", "", "/chemin"])
      expect(await s.add(token, { origin, username: "u", password: "p" })).toEqual({ ok: false, error: "origin" });
    expect(await s.add(token, { origin: "https://encore.test", username: "u", password: "" })).toEqual({ ok: false, error: "password" });
    expect(await s.add(token, { origin: "https://exemple.test:443/", username: "camille", password: "x" })).toEqual({ ok: false, error: "duplicate" });
    expect(snapshot()).toBe(before);
  });

  it("add with an empty username is allowed", async () => {
    const { s } = setup();
    const { token } = (await s.unlock("r"))!;
    expect(await s.add(token, { origin: "http://local.test:8080", username: "", password: "mot-de-passe-test-1" })).toEqual({ ok: true, guid: "new1" });
  });

  it("edit: unknown guid, empty password, a username taken on the same origin refused; else written", async () => {
    const { s, store, snapshot } = setup();
    const { token } = (await s.unlock("r"))!;
    const before = snapshot();
    expect(await s.edit(token, "nope", { username: "u", password: "p" })).toEqual({ ok: false, error: "missing" });
    expect(await s.edit(token, "g2", { username: "zoe", password: "" })).toEqual({ ok: false, error: "password" });
    expect(await s.edit(token, "g2", { username: "camille", password: "p" })).toEqual({ ok: false, error: "duplicate" });
    expect(snapshot()).toBe(before);
    expect(await s.edit(token, "g2", { username: "zoe", password: "mot-de-passe-test-7" })).toEqual({ ok: true, guid: "g2" });
    expect(store.find((l) => l.guid === "g2")).toMatchObject({ username: "zoe", password: "mot-de-passe-test-7" });
    // Another origin's username is no duplicate.
    expect(await s.edit(token, "g1", { username: "zoe", password: "p" })).toEqual({ ok: true, guid: "g1" });
  });

  it("remove: unknown guid missing; else gone", async () => {
    const { s, store } = setup();
    const { token } = (await s.unlock("r"))!;
    expect(await s.remove(token, "nope")).toEqual({ ok: false, error: "missing" });
    expect(await s.remove(token, "g1")).toEqual({ ok: true, guid: "g1" });
    expect(store.some((l) => l.guid === "g1")).toBe(false);
  });

  it("a store error is a write error", async () => {
    const { s } = setup({ failWrite: true });
    const { token } = (await s.unlock("r"))!;
    expect(await s.add(token, { origin: "https://new.test", username: "u", password: "p" })).toEqual({ ok: false, error: "write" });
    expect(await s.edit(token, "g1", { username: "u", password: "p" })).toEqual({ ok: false, error: "write" });
    expect(await s.remove(token, "g1")).toEqual({ ok: false, error: "write" });
  });

  it("a locked screen kills the tokens and tells the pages (polled while one lives)", async () => {
    vi.useFakeTimers();
    let locked = false;
    const { s } = setup({ screenLocked: () => locked });
    const told = vi.fn();
    const off = s.onLocked(told);
    const { token } = (await s.unlock("r"))!;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(told).not.toHaveBeenCalled();
    locked = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(told).toHaveBeenCalledOnce();
    expect(await s.reveal(token, "g1")).toBeNull();
    off();
    s.lockAll();
    expect(told).toHaveBeenCalledOnce();
  });
});
