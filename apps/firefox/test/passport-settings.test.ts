import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onLeavingPassport, showSection } from "../ui/components/settings-section.svelte";
import { createPassportSettings, pagePassport } from "../chrome/passport/settings";
import { format } from "../shared/i18n";
import type { PassportEntry } from "../chrome/shims/kernel";

const FAMILY = ["Du", "rand"].join("");
const entry = (id: string, family = FAMILY): PassportEntry => ({
  id, field: "nom", value: { given: "Marc", family }, variants: [], origins: [], how: "typed", created: "2026-11-23", updated: "2026-11-23",
});

function setup(o: { pass?: boolean; save?: unknown; uncovered?: number; screenLocked?: () => boolean } = {}) {
  let clock = 1_000_000;
  const order: string[] = [];
  const files = {
    load: vi.fn(async (profile: string) => ({ profile, state: "ok" as "ok" | "unreadable" | "newer", entries: [entry("a")], dropped: 1, revision: "r1" })),
    save: vi.fn(async (_profile: string, _entries: PassportEntry[], _revision: string) => (order.push("write"), (o.save ?? { ok: true, revision: "r2" }) as any)),
    list: vi.fn(async () => ["default", "work"]),
    count: vi.fn((profile: string) => (profile === "default" ? 1 : 0)),
    state: vi.fn((profile: string): "ok" | "unreadable" | "newer" | null => (profile === "default" ? "newer" : null)),
    remove: vi.fn(async () => void order.push("remove")),
    setAside: vi.fn(async (profile: string) => (order.push("setAside"), `${profile}.illisible-2026-11-24.json`)),
    ensureKeyBesides: vi.fn(async (_profile: string) => void order.push("ensureKey")),
    // The store's one queued load and save (chrome/passport/store.ts), over the two mocks above.
    update: vi.fn(async (profile: string, change: (e: PassportEntry[]) => PassportEntry[] | null): Promise<{ ok: true; entries: PassportEntry[]; written: boolean } | { ok: false }> => {
      const r = await files.load(profile);
      const next = r.state === "ok" ? change(r.entries) : null;
      if (!next) return { ok: false };
      if (next === r.entries) return { ok: true, entries: next, written: false };
      return (await files.save(profile, next, r.revision)).ok ? { ok: true, entries: next, written: true } : { ok: false };
    }),
  };
  const reauth = vi.fn(async () => o.pass ?? true);
  const request = vi.fn(async (method: string) => (order.push(method), { ok: true, uncovered: o.uncovered ?? 0 }));
  const s = createPassportSettings({ files, reauth, request, now: () => clock, ...(o.screenLocked ? { screenLocked: o.screenLocked } : {}) });
  return { s, files, reauth, request, order, tick: (ms: number) => (clock += ms) };
}

afterEach(() => vi.useRealTimers());

describe("passport settings (chrome)", () => {
  it("passports: each file's count and state without a token, loading only a passport never loaded", async () => {
    const { s, files } = setup();
    expect(await s.passports()).toEqual([
      { profile: "default", state: "newer", count: 1 },
      { profile: "work", state: "ok", count: 0 },
    ]);
    expect(files.load.mock.calls).toEqual([["work"]]);
  });

  it("unlock refused by Touch ID: null, with the reason asked", async () => {
    const { s, reauth } = setup({ pass: false });
    expect(await s.unlock("default", "ouvrir votre passeport « Perso »")).toBeNull();
    expect(reauth).toHaveBeenCalledWith("ouvrir votre passeport « Perso »");
  });

  it("read needs this profile's live token", async () => {
    const { s, files } = setup();
    const u = (await s.unlock("default", "r"))!;
    expect(u.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(u.until).toBe(1_000_000 + 5 * 60_000);
    expect(await s.read("default", "nope")).toBeNull();
    expect(await s.read("work", u.token)).toBeNull();
    expect(files.load).not.toHaveBeenCalled();
    expect(await s.read("default", u.token)).toEqual({ entries: [entry("a")], revision: "r1", dropped: 1 });
  });

  it("an unreadable passport reads as null", async () => {
    const { s, files } = setup();
    files.load.mockResolvedValueOnce({ profile: "default", state: "unreadable" as any, entries: [], dropped: 0, revision: "" });
    const u = (await s.unlock("default", "r"))!;
    expect(await s.read("default", u.token)).toBeNull();
  });

  it("a token expires after 5 minutes: read null, save locked, nothing written", async () => {
    const { s, files, tick } = setup();
    const u = (await s.unlock("default", "r"))!;
    tick(5 * 60_000);
    expect(await s.read("default", u.token)).toBeNull();
    expect(await s.save("default", u.token, [entry("a")], "r1")).toEqual({ ok: false, error: "locked" });
    expect(files.save).not.toHaveBeenCalled();
  });

  it("save validates every entry: a problem refuses it, nothing written, nothing sent", async () => {
    const { s, files, request } = setup();
    const u = (await s.unlock("default", "r"))!;
    const bad = { ...entry("b"), field: "tel" as const, value: { text: "12" } };
    expect(await s.save("default", u.token, [entry("a"), bad], "r1")).toEqual({ ok: false, error: "invalid" });
    expect(await s.save("default", u.token, [entry("a"), entry("a", "Martin")], "r1")).toEqual({ ok: false, error: "invalid" });
    expect(await s.save("default", u.token, "x" as any, "r1")).toEqual({ ok: false, error: "invalid" });
    expect(files.save).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("a good save writes the file, then sends passport.replace, and returns the host's uncovered count", async () => {
    const { s, files, request, order } = setup({ uncovered: 2 });
    const u = (await s.unlock("default", "r"))!;
    expect(await s.save("default", u.token, [entry("a")], "r1")).toEqual({ ok: true, revision: "r2", uncovered: 2 });
    expect(files.save).toHaveBeenCalledWith("default", [entry("a")], "r1");
    expect(request).toHaveBeenCalledWith("passport.replace", { profile: "default", entries: [entry("a")] });
    expect(order).toEqual(["write", "passport.replace"]);
  });

  it("a host that does not answer: saved, nothing uncovered (it reads the file at its next start)", async () => {
    const { s, request } = setup();
    request.mockRejectedValueOnce(new Error("down"));
    const u = (await s.unlock("default", "r"))!;
    expect(await s.save("default", u.token, [entry("a")], "r1")).toEqual({ ok: true, revision: "r2", uncovered: 0 });
  });

  it("Review Focus 2: a save from a stale revision is refused as stale, and nothing is sent", async () => {
    const { s, request } = setup({ save: { ok: false, error: "stale" } });
    const u = (await s.unlock("default", "r"))!;
    expect(await s.save("default", u.token, [entry("b", "Martin")], "old")).toEqual({ ok: false, error: "stale" });
    expect(request).not.toHaveBeenCalled();
  });

  it("lock revokes one token; lockAll revokes them all and tells the pages", async () => {
    const { s } = setup();
    const a = (await s.unlock("default", "r"))!;
    const b = (await s.unlock("default", "r"))!;
    s.lock(a.token);
    expect(await s.read("default", a.token)).toBeNull();
    expect(await s.read("default", b.token)).not.toBeNull();
    const told = vi.fn();
    const off = s.onLocked(told);
    s.lockAll();
    expect(told).toHaveBeenCalledOnce();
    expect(await s.read("default", b.token)).toBeNull();
    off();
    s.lockAll();
    expect(told).toHaveBeenCalledOnce();
  });

  it("a locked screen relocks every passport (polled while one is open)", async () => {
    vi.useFakeTimers();
    let locked = false;
    const { s } = setup({ screenLocked: () => locked });
    const told = vi.fn();
    s.onLocked(told);
    const u = (await s.unlock("default", "r"))!;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(told).not.toHaveBeenCalled();
    locked = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(told).toHaveBeenCalledOnce();
    expect(await s.read("default", u.token)).toBeNull();
  });
});

describe("passport drop (a deleted profile)", () => {
  it("removes the file, then tells the kernel, and revokes that profile's tokens", async () => {
    const { s, files, request, order } = setup();
    const u = (await s.unlock("work", "r"))!;
    expect(await s.drop("work")).toBe(true);
    expect(files.remove).toHaveBeenCalledWith("work", undefined);
    expect(request).toHaveBeenCalledWith("passport.drop", { profile: "work" });
    expect(order).toEqual(["remove", "passport.drop"]);
    expect(await s.read("work", u.token)).toBeNull();
  });

  it("a file that could not be removed: false, and the kernel keeps masking with it", async () => {
    const { s, files, request } = setup();
    files.remove.mockRejectedValueOnce(new Error("disk"));
    expect(await s.drop("work")).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("a host that does not answer: still dropped (it reads the files at its next start)", async () => {
    const { s, request } = setup();
    request.mockRejectedValueOnce(new Error("gone"));
    expect(await s.drop("work")).toBe(true);
  });
});

describe("removePassport (« Supprimer ce passeport », any passport)", () => {
  it("needs this profile's live token: without one nothing is removed and nothing sent", async () => {
    const { s, files, request, tick } = setup();
    const other = (await s.unlock("default", "r", "delete"))!;
    expect(await s.removePassport("work", "nope")).toBe(false);
    expect(await s.removePassport("work", other.token)).toBe(false);
    // Only a token asked for this delete (a fresh Touch ID): not the open view's, not a move's.
    expect(await s.removePassport("work", (await s.unlock("work", "r"))!.token)).toBe(false);
    expect(await s.removePassport("work", (await s.unlock("work", "r", "move"))!.token)).toBe(false);
    const u = (await s.unlock("work", "r", "delete"))!;
    tick(5 * 60_000);
    expect(await s.removePassport("work", u.token)).toBe(false);
    expect(files.remove).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("with the token: removes the file and its set-aside copies, then sends passport.drop, and revokes the profile's tokens", async () => {
    const { s, files, order } = setup();
    const u = (await s.unlock("work", "r", "delete"))!;
    const v = (await s.unlock("work", "r"))!;
    expect(await s.removePassport("work", u.token)).toBe(true);
    expect(files.remove).toHaveBeenCalledOnce();
    expect(files.remove).toHaveBeenCalledWith("work", undefined);
    expect(order).toEqual(["remove", "passport.drop"]);
    expect(await s.read("work", v.token)).toBeNull();
  });

  it("a file that could not be removed: false, nothing sent", async () => {
    const { s, files, request } = setup();
    files.remove.mockRejectedValueOnce(new Error("disk"));
    const u = (await s.unlock("work", "r", "delete"))!;
    expect(await s.removePassport("work", u.token)).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("its confirmation says one entry in the singular, the others as § 9.5 writes them", () => {
    expect(format("fr", "settings-passport-remove-confirm", { n: 1 })).toBe("Supprimer ce passeport et sa donnée ? L'agent pourra de nouveau la lire là où elle s'affiche.");
    expect(format("fr", "settings-passport-remove-confirm", { n: 3 })).toBe("Supprimer ce passeport et ses 3 données ? L'agent pourra de nouveau les lire là où elles s'affichent.");
    expect(format("en", "settings-passport-remove-confirm", { n: 1 })).toContain("its item?");
  });

  it("a delete token serves once", async () => {
    const { s, files } = setup();
    files.remove.mockRejectedValueOnce(new Error("disk"));
    const u = (await s.unlock("work", "r", "delete"))!;
    expect(await s.removePassport("work", u.token)).toBe(false);
    expect(await s.removePassport("work", u.token)).toBe(false);
    expect(files.remove).toHaveBeenCalledOnce();
  });

  it("a delete or move token cannot read nor save", async () => {
    const { s } = setup();
    for (const purpose of ["delete", "move"] as const) {
      const u = (await s.unlock("default", "r", purpose))!;
      expect(await s.read("default", u.token)).toBeNull();
      expect(await s.save("default", u.token, [entry("a")], "r1")).toEqual({ ok: false, error: "locked" });
    }
  });
});

describe("restart (« Recommencer un passeport vide », an unreadable passport)", () => {
  const unreadable = (files: ReturnType<typeof setup>["files"], order: string[] = []) => {
    let gone = false;
    files.setAside.mockImplementation(async (profile: string) => ((gone = true), order.push("setAside"), `${profile}.illisible-2026-11-24.json`));
    files.load.mockImplementation(async (profile: string) => ({ profile, state: gone ? "ok" : "unreadable", entries: [], dropped: 0, revision: "" }));
  };

  it("with a restart token: sets the file aside, makes the key if needed, then the profile is ok and empty for the kernel", async () => {
    const { s, files, request, order } = setup();
    unreadable(files, order);
    const u = (await s.unlock("work", "r", "restart"))!;
    expect(await s.restart("work", u.token)).toBe(true);
    expect(files.setAside).toHaveBeenCalledWith("work");
    expect(files.ensureKeyBesides).toHaveBeenCalledWith("work");
    expect(order).toEqual(["setAside", "ensureKey", "passport.replace"]);
    expect(request).toHaveBeenCalledWith("passport.replace", { profile: "work", entries: [] });
    expect((await files.load("work")).state).toBe("ok");
    // Single use.
    expect(await s.restart("work", u.token)).toBe(false);
    expect(files.setAside).toHaveBeenCalledOnce();
  });

  it("refused without this profile's restart token, or on a passport that is not unreadable (ok, newer): nothing moved", async () => {
    const { s, files, request } = setup();
    unreadable(files);
    for (const u of [(await s.unlock("work", "r"))!, (await s.unlock("work", "r", "delete"))!, (await s.unlock("default", "r", "restart"))!]) expect(await s.restart("work", u.token)).toBe(false);
    for (const state of ["ok", "newer"] as const) {
      files.load.mockResolvedValueOnce({ profile: "work", state, entries: [entry("a")], dropped: 0, revision: "r1" });
      expect(await s.restart("work", (await s.unlock("work", "r", "restart"))!.token)).toBe(false);
    }
    expect(files.setAside).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("a file that could not be set aside: false, nothing sent; a key that cannot be made yet does not undo the restart", async () => {
    const { s, files, request } = setup();
    unreadable(files);
    files.setAside.mockRejectedValueOnce(new Error("disk"));
    expect(await s.restart("work", (await s.unlock("work", "r", "restart"))!.token)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    files.ensureKeyBesides.mockRejectedValueOnce(new Error("keychain"));
    expect(await s.restart("work", (await s.unlock("work", "r", "restart"))!.token)).toBe(true);
    expect(request).toHaveBeenCalledWith("passport.replace", { profile: "work", entries: [] });
  });

  it("a restart token cannot read nor save", async () => {
    const { s } = setup();
    const u = (await s.unlock("default", "r", "restart"))!;
    expect(await s.read("default", u.token)).toBeNull();
    expect(await s.save("default", u.token, [entry("a")], "r1")).toEqual({ ok: false, error: "locked" });
  });
});

describe("moveTo (« Déplacer vers… », a kept passport)", () => {
  const libre = (id: string, text: string): PassportEntry => ({ ...entry(id), field: "libre", value: { text } });
  function moving(o: { source?: PassportEntry[]; sourceDropped?: number; target?: PassportEntry[]; targetState?: "ok" | "unreadable" | "newer"; save?: unknown } = {}) {
    const t = setup({ save: o.save });
    const by: Record<string, { state: "ok" | "unreadable" | "newer"; entries: PassportEntry[]; revision: string; dropped: number }> = {
      gone: { state: "ok", entries: o.source ?? [entry("a"), entry("b", "Martin")], revision: "rg", dropped: o.sourceDropped ?? 0 },
      default: { state: o.targetState ?? "ok", entries: o.target ?? [entry("a", "Leroy"), entry("c", "Martin")], revision: "rd", dropped: 0 },
    };
    t.files.load.mockImplementation(async (profile: string) => ({ profile, ...by[profile]! }));
    return { ...t, move: async (to = "default") => t.s.moveTo("gone", to, (await t.s.unlock("gone", "r", "move"))!.token) };
  }

  it("needs the source's move token, once: locked, nothing read", async () => {
    const { s, files } = moving();
    for (const u of [(await s.unlock("default", "r", "move"))!, (await s.unlock("gone", "r"))!, (await s.unlock("gone", "r", "delete"))!])
      expect(await s.moveTo("gone", "default", u.token)).toEqual({ ok: false, error: "locked" });
    expect(files.load).not.toHaveBeenCalled();
    const u = (await s.unlock("gone", "r", "move"))!;
    expect(await s.moveTo("gone", "gone", u.token)).toEqual({ ok: false, error: "write" });
    expect(await s.moveTo("gone", "default", u.token)).toEqual({ ok: false, error: "locked" });
  });

  it("merges into the target (a value it has is skipped, a clashing id renewed), writes it, sends replace, then removes the source and sends drop", async () => {
    const { s, files, request, order } = moving();
    const u = (await s.unlock("gone", "r", "move"))!;
    expect(await s.moveTo("gone", "default", u.token)).toEqual({ ok: true });
    const [profile, written, revision] = files.save.mock.calls[0] as unknown as [string, PassportEntry[], string];
    expect([profile, revision]).toEqual(["default", "rd"]);
    expect(written.slice(0, 2)).toEqual([entry("a", "Leroy"), entry("c", "Martin")]);
    expect(written).toHaveLength(3);
    expect(written[2]).toEqual({ ...entry("a"), id: expect.not.stringMatching(/^(a|c)$/) });
    expect(request).toHaveBeenCalledWith("passport.replace", { profile: "default", entries: written });
    // The source goes only if it is still the file that was copied (a save meanwhile refuses it).
    expect(files.remove).toHaveBeenCalledWith("gone", "rg");
    expect(request).toHaveBeenCalledWith("passport.drop", { profile: "gone" });
    // F8: the target holds the values before the source goes, so no conversation is marked « non couverte ».
    expect(order).toEqual(["write", "passport.replace", "remove", "passport.drop"]);
    expect(await s.read("gone", u.token)).toBeNull();
  });

  it("a source with entries it could not read: refused (they would be lost), nothing written", async () => {
    const { files, move } = moving({ sourceDropped: 1 });
    expect(await move()).toEqual({ ok: false, error: "unread" });
    expect(files.save).not.toHaveBeenCalled();
    expect(files.remove).not.toHaveBeenCalled();
  });

  it("a skipped twin brings its own variants and sites to the target entry; past their caps, full", async () => {
    const twin = { ...entry("s1", "Martin"), variants: ["M. Martin"], origins: ["impots.gouv.fr"] };
    const one = moving({ source: [twin] });
    expect(await one.move()).toEqual({ ok: true });
    const written = (one.files.save.mock.calls[0] as unknown as [string, PassportEntry[]])[1];
    expect(written).toEqual([entry("a", "Leroy"), { ...entry("c", "Martin"), variants: ["M. Martin"], origins: ["impots.gouv.fr"] }]);
    const many = { ...entry("c", "Martin"), variants: Array.from({ length: 10 }, (_, i) => `Martin ${"abcdefghij"[i]}x`) };
    const full = moving({ source: [twin], target: [many] });
    expect(await full.move()).toEqual({ ok: false, error: "full" });
    expect(full.files.save).not.toHaveBeenCalled();
  });

  it("past the 200-entry cap: full, nothing written, nothing sent", async () => {
    const { files, request, move } = moving({ target: Array.from({ length: 199 }, (_, i) => libre(`t${i}`, `Donnee${i}x`)) });
    expect(await move()).toEqual({ ok: false, error: "full" });
    expect(files.save).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("a target that cannot be read or is newer: write, nothing written", async () => {
    for (const targetState of ["unreadable", "newer"] as const) {
      const { files, move } = moving({ targetState });
      expect(await move()).toEqual({ ok: false, error: "write" });
      expect(files.save).not.toHaveBeenCalled();
    }
  });

  it("a target write that fails: write, the source untouched", async () => {
    const { files, request, move } = moving({ save: { ok: false, error: "stale" } });
    expect(await move()).toEqual({ ok: false, error: "write" });
    expect(files.remove).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("copied but the source could not be removed (or changed since): copied (never « nothing changed »), drop not sent", async () => {
    const { files, request, move } = moving();
    files.remove.mockRejectedValueOnce(Object.assign(new Error("stale"), { name: "StaleError" }));
    expect(await move()).toEqual({ ok: false, error: "copied" });
    expect(request.mock.calls.map((c) => c[0])).toEqual(["passport.replace"]);
  });
});

describe("passport relock on leaving (page)", () => {
  it("leaving the section runs the page's relock before any teardown, once, and only from the passport", () => {
    const leave = vi.fn();
    const off = onLeavingPassport(leave);
    showSection("agent");
    expect(leave).not.toHaveBeenCalled();
    showSection("passport", { profile: "work" });
    showSection("passport");
    expect(leave).not.toHaveBeenCalled();
    showSection("privacy");
    expect(leave).toHaveBeenCalledOnce();
    off();
    showSection("passport");
    showSection("data");
    expect(leave).toHaveBeenCalledOnce();
  });

  it("the page has no global transition: its destroy (and its relock) never waits for an outro", () => {
    expect(readFileSync(new URL("../ui/components/SettingsPassport.svelte", import.meta.url), "utf8")).not.toContain("|global");
  });
});

describe("« Retenir ce site » (task 13b)", () => {
  const ID = "0000000000000001";
  const one = (origins: string[] = []) => ({ ...entry(ID), origins });
  const loaded = (entries: PassportEntry[]) => ({ profile: "default", state: "ok" as "ok" | "unreadable" | "newer", entries, dropped: 0, revision: "r1" });

  it("adds the page's cleaned host to that entry on its revision, then sends passport.replace; no token needed", async () => {
    const { s, files, request, order } = setup();
    files.load.mockResolvedValueOnce(loaded([entry("0000000000000002", "Martin"), one(["a.example"])]));
    expect(await s.addOrigin("default", ID, "https://www.Boutique.example")).toBe(true);
    const written = [entry("0000000000000002", "Martin"), one(["a.example", "www.boutique.example"])];
    expect(files.save).toHaveBeenCalledWith("default", written, "r1");
    expect(request).toHaveBeenCalledWith("passport.replace", { profile: "default", entries: written });
    expect(order).toEqual(["write", "passport.replace"]);
  });

  it("refuses without writing: an unknown entry, 20 hosts already, a host it cannot clean, an unreadable or newer file, a stale revision, a load that throws", async () => {
    const { s, files, request } = setup({ save: { ok: false, error: "stale" } });
    const refusals: [PassportEntry[] | Error | "unreadable", string][] = [
      [[entry("0000000000000002")], "https://b.example"],
      [[one(Array.from({ length: 20 }, (_, i) => `s${i}.example`))], "https://b.example"],
      ["unreadable", "https://b.example"],
      [Object.assign(new Error("x"), { name: "NotReadableError" }), "https://b.example"],
    ];
    for (const [r, origin] of refusals) {
      if (r instanceof Error) files.load.mockRejectedValueOnce(r);
      else files.load.mockResolvedValueOnce(r === "unreadable" ? { ...loaded([]), state: "unreadable" } : loaded(r));
      expect(await s.addOrigin("default", ID, origin)).toBe(false);
    }
    // A host it cannot clean: refused before any read.
    expect(await s.addOrigin("default", ID, "file:///x")).toBe(false);
    files.load.mockResolvedValueOnce({ ...loaded([one()]), state: "newer" });
    expect(await s.addOrigin("default", ID, "https://b.example")).toBe(false);
    expect(files.save).not.toHaveBeenCalled();
    files.load.mockResolvedValueOnce(loaded([one()]));
    expect(await s.addOrigin("default", ID, "https://b.example")).toBe(false);
    expect(files.save).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("a host already there is a success with nothing written", async () => {
    const { s, files } = setup();
    files.load.mockResolvedValueOnce(loaded([one(["b.example"])]));
    expect(await s.addOrigin("default", ID, "https://b.example")).toBe(true);
    expect(files.save).not.toHaveBeenCalled();
  });
});

describe("« Cacher pour l'agent »: hide and unhide (chrome only)", () => {
  const MAIL = ["marc", "exemple.fr"].join("@");
  const mail = (id: string, origins: string[] = []): PassportEntry => ({ ...entry(id), field: "email", value: { text: MAIL }, origins });
  const loaded = (entries: PassportEntry[]) => ({ profile: "default", state: "ok" as "ok" | "unreadable" | "newer", entries, dropped: 0, revision: "r1" });
  const written = (files: ReturnType<typeof setup>["files"]) => files.save.mock.calls.at(-1)![1];
  const hideIt = (s: ReturnType<typeof setup>["s"], over: Record<string, unknown> = {}) =>
    s.hide({ profile: "default", field: "email", value: { text: MAIL }, origin: "https://www.Boutique.example/compte", reason: "cacher ce texte pour l'agent", ...over } as any);

  it("asks Touch ID, then creates a click entry from that site, writes it and sends passport.replace", async () => {
    const { s, files, reauth, request, order } = setup();
    files.load.mockResolvedValueOnce(loaded([entry("0000000000000002")]));
    const r = await hideIt(s);
    expect(reauth).toHaveBeenCalledWith("cacher ce texte pour l'agent");
    expect(r).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/), created: true, addedOrigin: true, updated: new Date(1_000_000).toISOString() });
    const all = written(files);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ id: (r as any).id, field: "email", value: { text: MAIL }, variants: [], origins: ["www.boutique.example"], how: "click", from: "www.boutique.example" });
    expect(request).toHaveBeenCalledWith("passport.replace", { profile: "default", entries: all });
    expect(order).toEqual(["write", "passport.replace"]);
  });

  it("a value already there only gets the site, never a second entry", async () => {
    const { s, files } = setup();
    files.load.mockResolvedValueOnce(loaded([mail("0000000000000003", ["a.example"])]));
    expect(await hideIt(s, { value: { text: `  ${MAIL.toUpperCase()} ` } })).toEqual({ ok: true, id: "0000000000000003", created: false, addedOrigin: true, updated: "2026-11-23" });
    expect(written(files)).toEqual([mail("0000000000000003", ["a.example", "www.boutique.example"])]);
  });

  it("a value already there with that site: a success with nothing written", async () => {
    const { s, files, request } = setup();
    files.load.mockResolvedValueOnce(loaded([mail("0000000000000003", ["www.boutique.example"])]));
    expect(await hideIt(s)).toEqual({ ok: true, id: "0000000000000003", created: false, addedOrigin: false, updated: "2026-11-23" });
    expect(files.save).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("origin null: the value is added without a site", async () => {
    const { s, files } = setup();
    files.load.mockResolvedValueOnce(loaded([]));
    expect(await hideIt(s, { origin: null })).toMatchObject({ ok: true, created: true, addedOrigin: false });
    expect(written(files)[0]).toMatchObject({ origins: [], how: "click" });
    expect(written(files)[0]).not.toHaveProperty("from");
  });

  it("Touch ID refused: cancelled, the file never read nor written", async () => {
    const { s, files, request } = setup({ pass: false });
    expect(await hideIt(s)).toEqual({ ok: false, error: "cancelled" });
    expect(files.load).not.toHaveBeenCalled();
    expect(files.save).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("refusals: long, invalid, unreadable, newer, full, write", async () => {
    const { s, files } = setup();
    files.load.mockResolvedValue(loaded([]));
    expect(await hideIt(s, { field: "libre", value: { text: "x".repeat(301) } })).toEqual({ ok: false, error: "long" });
    expect(await hideIt(s, { field: "tel", value: { text: "12" } })).toEqual({ ok: false, error: "invalid" });
    files.load.mockResolvedValueOnce({ ...loaded([]), state: "unreadable" });
    expect(await hideIt(s)).toEqual({ ok: false, error: "unreadable" });
    files.load.mockResolvedValueOnce({ ...loaded([]), state: "newer" });
    expect(await hideIt(s)).toEqual({ ok: false, error: "unreadable" });
    files.load.mockResolvedValueOnce(loaded(Array.from({ length: 200 }, (_, i) => entry(`e${i}`, `Nom${"x".repeat(i)}`))));
    expect(await hideIt(s)).toEqual({ ok: false, error: "full" });
    files.load.mockResolvedValueOnce(loaded([mail("0000000000000003", Array.from({ length: 20 }, (_, i) => `s${i}.example`))]));
    expect(await hideIt(s)).toEqual({ ok: false, error: "full" });
    expect(files.save).not.toHaveBeenCalled();
    files.save.mockResolvedValueOnce({ ok: false, error: "write" });
    expect(await hideIt(s)).toEqual({ ok: false, error: "write" });
  });

  it("unhide after a create removes the entry, then sends passport.replace; no Touch ID", async () => {
    const { s, files, reauth, order } = setup();
    files.load.mockResolvedValueOnce(loaded([entry("0000000000000002"), mail("0000000000000003", ["www.boutique.example"])]));
    expect(await s.unhide({ profile: "default", id: "0000000000000003", created: true, addedOrigin: true, updated: "2026-11-23", origin: "https://www.boutique.example" })).toBe(true);
    expect(written(files)).toEqual([entry("0000000000000002")]);
    expect(order).toEqual(["write", "passport.replace"]);
    expect(reauth).not.toHaveBeenCalled();
  });

  it("unhide after an origin-only hide removes only that origin", async () => {
    const { s, files, request } = setup();
    files.load.mockResolvedValueOnce(loaded([mail("0000000000000003", ["a.example", "www.boutique.example"])]));
    expect(await s.unhide({ profile: "default", id: "0000000000000003", created: false, addedOrigin: true, updated: "2026-11-23", origin: "https://www.Boutique.example/x" })).toBe(true);
    expect(written(files)).toEqual([mail("0000000000000003", ["a.example"])]);
    expect(request).toHaveBeenCalledWith("passport.replace", { profile: "default", entries: [mail("0000000000000003", ["a.example"])] });
  });

  it("unhide with nothing it added writes nothing; an unreadable file is a failure", async () => {
    const { s, files } = setup();
    files.load.mockResolvedValueOnce(loaded([mail("0000000000000003", ["a.example"])]));
    expect(await s.unhide({ profile: "default", id: "0000000000000003", created: false, addedOrigin: false, updated: "2026-11-23", origin: "https://a.example" })).toBe(true);
    files.load.mockResolvedValueOnce({ ...loaded([]), state: "unreadable" });
    expect(await s.unhide({ profile: "default", id: "0000000000000003", created: true, addedOrigin: false, updated: "2026-11-23", origin: null })).toBe(false);
    expect(files.save).not.toHaveBeenCalled();
  });

  it("unhide after a create, of an entry edited since: only the site it added goes, the edit stays", async () => {
    const { s, files } = setup();
    const edited = { ...mail("0000000000000003", ["www.boutique.example"]), variants: ["marc chez exemple"], updated: "2026-11-24T10:00:00.000Z" };
    files.load.mockResolvedValueOnce(loaded([edited]));
    expect(await s.unhide({ profile: "default", id: "0000000000000003", created: true, addedOrigin: true, updated: "2026-11-23", origin: "https://www.boutique.example" })).toBe(true);
    expect(written(files)).toEqual([{ ...edited, origins: [] }]);
  });

  it("Réglages pages never get hide, unhide nor addOrigin", () => {
    const pages = pagePassport(setup().s);
    for (const k of ["hide", "unhide", "addOrigin"]) expect(pages).not.toHaveProperty(k);
    expect(pages).toHaveProperty("save");
  });
});
