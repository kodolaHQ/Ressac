import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPassportFiles, MIGRATIONS, passportShown } from "../chrome/passport/store";
import { createPassportSettings } from "../chrome/passport/settings";
import { passportCipher, PASSPORT_KEY_LABEL, PASSPORT_KEY_LABEL_DEV, type PassportCipher } from "../chrome/passport/cipher";
import type { PassportEntry } from "../chrome/shims/kernel";

const g = globalThis as any;
let root: string;
let dir: string;
let n = 0;

// The module runs as chrome (IOUtils, PathUtils): here, the same on node:fs.
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-passport-")));
  const notFound = () => Object.assign(new Error("absent"), { name: "NotFoundError" });
  g.PathUtils = { join: (...p: string[]) => join(...p), filename: (p: string) => basename(p) };
  g.IOUtils = {
    readUTF8: async (p: string) => {
      if (!existsSync(p)) throw notFound();
      return readFileSync(p, "utf8");
    },
    writeUTF8: async (p: string, t: string, o?: { tmpPath?: string }) => {
      if (o?.tmpPath) {
        writeFileSync(o.tmpPath, t);
        renameSync(o.tmpPath, p);
      } else writeFileSync(p, t);
    },
    setPermissions: async (p: string, mode: number) => chmodSync(p, mode),
    makeDirectory: async (p: string) => void mkdirSync(p, { recursive: true }),
    getChildren: async (p: string) => {
      if (!existsSync(p)) throw notFound();
      return readdirSync(p).map((x) => join(p, x));
    },
    remove: async (p: string) => rmSync(p, { force: true }),
    move: async (from: string, to: string, o?: { noOverwrite?: boolean }) => {
      if (!existsSync(from)) throw notFound();
      if (o?.noOverwrite && existsSync(to)) throw Object.assign(new Error("exists"), { name: "NoModificationAllowedError" });
      renameSync(from, to);
    },
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  dir = join(root, `p${++n}`, "ressac", "passport");
});

const SECRET = ["Du", "rand"].join("");
const entry = (id: string, family = SECRET, given = "Marc"): PassportEntry => ({
  id, field: "nom", value: { given, family }, variants: [], origins: [], how: "typed", created: "2026-11-23", updated: "2026-11-23",
});

/** A fake keychain: hex of the text, under a key that exists or not. */
function fakeCipher(o: { key?: boolean; failDecrypt?: boolean } = {}) {
  let key = o.key ?? true;
  const c = {
    available: vi.fn(async () => key),
    ensureKey: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      key = true;
    }),
    encrypt: vi.fn(async (s: string) => {
      if (!key) throw new Error("no key");
      return Buffer.from(s).toString("hex");
    }),
    decrypt: vi.fn(async (s: string) => {
      if (!key || o.failDecrypt) throw new Error("bad");
      return Buffer.from(s, "hex").toString();
    }),
  };
  return c satisfies PassportCipher;
}

const file = (p: string) => join(dir, `${p}.json`);
const write = (p: string, envelope: object) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(p), JSON.stringify(envelope));
};
const sealed = (inner: object) => Buffer.from(JSON.stringify(inner)).toString("hex");

describe("passport files", () => {
  it("save then load round-trips; the file is 0600 in a 0700 folder and holds no value", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const saved = await files.save("default", [entry("a")], "");
    expect(saved.ok).toBe(true);
    expect(statSync(file("default")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const text = readFileSync(file("default"), "utf8");
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ format: "ressac-passport", version: 1, profile: "default" });
    const again = await createPassportFiles({ dir, cipher: fakeCipher() }).load("default");
    expect(again).toMatchObject({ profile: "default", state: "ok", dropped: 0 });
    expect(again.entries).toEqual([entry("a")]);
    expect(saved.ok && saved.revision).toBe(again.revision);
    expect(again.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(files.count("default")).toBe(1);
  });

  it("a failed or unreadable load keeps the profile's last known hosts; a good load, a save or remove changes them", async () => {
    const { onPassportHost, passportHostsKnown } = await import("../chrome/passport/hosts");
    passportHostsKnown();
    const cipher = fakeCipher();
    const files = createPassportFiles({ dir, cipher });
    const saved = await files.save("default", [{ ...entry("a"), origins: ["banque.test"] }], "");
    expect(saved.ok).toBe(true);
    expect((await files.load("default")).state).toBe("ok");
    expect(onPassportHost("https://banque.test/")).toBe(true);
    cipher.decrypt.mockRejectedValueOnce(new Error("locked"));
    expect((await files.load("default")).state).toBe("unreadable");
    expect(onPassportHost("https://banque.test/")).toBe(true);
    await files.remove("default");
    expect(onPassportHost("https://banque.test/")).toBe(false);
  });

  it("passportShown reads the last good load only: masked displays, no cipher call, no read; nothing for a passport never read", async () => {
    const cipher = fakeCipher();
    const files = createPassportFiles({ dir, cipher });
    await files.save("default", [entry("a")], "");
    cipher.decrypt.mockClear();
    cipher.available.mockClear();
    const read = vi.spyOn(g.IOUtils, "readUTF8");
    const shown = passportShown(files, [{ profile: "default", id: "a" }, { profile: "default", id: "gone" }, { profile: "other", id: "a" }]);
    expect(shown).toEqual([{ field: "nom", display: "M••• D•••••" }, { field: null, display: null }, { field: null, display: null }]);
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect([cipher.decrypt.mock.calls.length, cipher.available.mock.calls.length, read.mock.calls.length]).toEqual([0, 0, 0]);
    read.mockRestore();
  });

  it("no file: ok, empty, revision empty; a bad profile id is unreadable", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    expect(await files.load("default")).toEqual({ profile: "default", state: "ok", entries: [], dropped: 0, revision: "" });
    expect((await files.load("../x")).state).toBe("unreadable");
  });

  it("an envelope whose profile is not the file name is unreadable", async () => {
    write("default", { format: "ressac-passport", version: 1, profile: "other", cipher: sealed({ version: 1, entries: [entry("a")] }) });
    const r = await createPassportFiles({ dir, cipher: fakeCipher() }).load("default");
    expect(r.state).toBe("unreadable");
    expect(r.entries).toEqual([]);
  });

  it("a missing key: unreadable, no key created, the file untouched", async () => {
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 1, entries: [entry("a")] }) });
    const before = readFileSync(file("default"));
    const cipher = fakeCipher({ key: false });
    const r = await createPassportFiles({ dir, cipher }).load("default");
    expect(r.state).toBe("unreadable");
    expect(cipher.ensureKey).not.toHaveBeenCalled();
    expect(cipher.decrypt).not.toHaveBeenCalled();
    expect(readFileSync(file("default"))).toEqual(before);
  });

  it("decrypt throws: unreadable, the file untouched, and a save over it is refused", async () => {
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 1, entries: [entry("a")] }) });
    const before = readFileSync(file("default"));
    const files = createPassportFiles({ dir, cipher: fakeCipher({ failDecrypt: true }) });
    const r = await files.load("default");
    expect(r.state).toBe("unreadable");
    expect(readFileSync(file("default"))).toEqual(before);
    expect(await files.save("default", [entry("b")], r.revision)).toEqual({ ok: false, error: "write" });
    expect(readFileSync(file("default"))).toEqual(before);
  });

  it("a newer envelope or inner version reads with the current schema, read-only", async () => {
    const extra = { ...entry("a"), future: true };
    write("default", { format: "ressac-passport", version: 2, profile: "default", cipher: sealed({ version: 1, entries: [entry("a")] }) });
    write("inner", { format: "ressac-passport", version: 1, profile: "inner", cipher: sealed({ version: 2, entries: [extra], more: 1 }) });
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const outer = await files.load("default");
    expect(outer).toMatchObject({ state: "newer", entries: [entry("a")] });
    const inner = await files.load("inner");
    expect(inner).toMatchObject({ state: "newer", dropped: 0 });
    expect(inner.entries.map((e) => e.id)).toEqual(["a"]);
    const before = readFileSync(file("inner"));
    expect(await files.save("default", [entry("b")], outer.revision)).toEqual({ ok: false, error: "newer" });
    expect(await files.save("inner", [], inner.revision)).toEqual({ ok: false, error: "newer" });
    expect(readFileSync(file("inner"))).toEqual(before);
  });

  it("a newer file whose entries the current schema cannot read is unreadable, and kept", async () => {
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 2, entries: [{ id: "a", shape: "v2" }] }) });
    const before = readFileSync(file("default"));
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const r = await files.load("default");
    expect(r).toMatchObject({ state: "unreadable", entries: [] });
    expect(await files.save("default", [entry("b")], r.revision)).toEqual({ ok: false, error: "write" });
    expect(readFileSync(file("default"))).toEqual(before);
  });

  it("an invalid entry among three is dropped, the others kept (first copy of a duplicate kept)", async () => {
    const bad = { ...entry("b"), value: { text: 3 } };
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 1, entries: [entry("a"), bad, entry("c", "Martin")] }) });
    const r = await createPassportFiles({ dir, cipher: fakeCipher() }).load("default");
    expect(r.entries.map((e) => e.id)).toEqual(["a", "c"]);
    expect(r.dropped).toBe(1);
    write("dup", { format: "ressac-passport", version: 1, profile: "dup", cipher: sealed({ version: 1, entries: [entry("a"), entry("b")] }) });
    const d = await createPassportFiles({ dir, cipher: fakeCipher() }).load("dup");
    expect(d.entries.map((e) => e.id)).toEqual(["a"]);
    expect(d.dropped).toBe(1);
  });

  it("an entry the load could not read is written back verbatim on every save, an empty save included, and still counted", async () => {
    const bad = { ...entry("b"), value: { text: 3 } };
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 1, entries: [entry("a"), bad] }) });
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const inner = () => JSON.parse(Buffer.from(JSON.parse(readFileSync(file("default"), "utf8")).cipher, "hex").toString()).entries;
    const r = await files.load("default");
    const saved = await files.save("default", [entry("a"), entry("c", "Martin")], r.revision);
    expect(saved.ok).toBe(true);
    expect(inner()).toEqual([entry("a"), entry("c", "Martin"), bad]);
    expect(files.count("default")).toBe(2);
    const again = await files.load("default");
    expect(again.dropped).toBe(1);
    expect((await files.save("default", [], again.revision)).ok).toBe(true);
    expect(inner()).toEqual([bad]);
    expect((await files.load("default")).dropped).toBe(1);
  });

  it("only a malformed or invalid entry is kept unread: a duplicate (same id or same value) is dropped for good", async () => {
    const malformed = { ...entry("m"), value: { text: 3 } };
    const sameValue = entry("d");
    const sameId = entry("a", "Martin");
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 1, entries: [entry("a"), malformed, sameValue, sameId] }) });
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const r = await files.load("default");
    expect(r.dropped).toBe(3);
    // The user deletes the kept twin: the duplicates must not come back.
    expect((await files.save("default", [], r.revision)).ok).toBe(true);
    const inner = JSON.parse(Buffer.from(JSON.parse(readFileSync(file("default"), "utf8")).cipher, "hex").toString()).entries;
    expect(inner).toEqual([malformed]);
  });

  it("the 200-entry cap counts the unread entries kept: past it, the save is refused as full and nothing is written", async () => {
    const letters = (n: number) => String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26));
    const many = Array.from({ length: 199 }, (_, i) => entry(`e${i}`, `Nom${letters(i)}`));
    const bad = (id: string) => ({ ...entry(id), value: { text: 3 } });
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 1, entries: [many[0], bad("x"), bad("y")] }) });
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const r = await files.load("default");
    const before = readFileSync(file("default"), "utf8");
    expect(await files.save("default", many, r.revision)).toEqual({ ok: false, error: "full" });
    expect(readFileSync(file("default"), "utf8")).toBe(before);
    expect((await files.save("default", many.slice(0, 198), r.revision)).ok).toBe(true);
  });

  it("two saves from the same revision: the second is stale, the first's entry stays", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const first = await files.save("default", [entry("a")], "");
    expect(first.ok).toBe(true);
    expect(await files.save("default", [entry("b", "Martin")], "")).toEqual({ ok: false, error: "stale" });
    expect((await files.load("default")).entries.map((e) => e.id)).toEqual(["a"]);
  });

  it("two concurrent saves on one profile run one after the other", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const [a, b] = await Promise.all([files.save("default", [entry("a")], ""), files.save("default", [entry("b", "Martin")], "")]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: "stale" });
    const r = await files.load("default");
    const c = await files.save("default", [entry("a"), entry("c", "Martin")], r.revision);
    expect(c.ok).toBe(true);
  });

  it("review 13b: two « Retenir ce site » at once (two `also` rows) both reach the file: each load and save is one queued step", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    expect((await files.save("default", [entry("0000000000000001"), entry("0000000000000002", "Martin")], "")).ok).toBe(true);
    const request = vi.fn(async () => ({ ok: true }));
    const s = createPassportSettings({ files, reauth: async () => true, request });
    expect(await Promise.all([s.addOrigin("default", "0000000000000001", "https://a.example"), s.addOrigin("default", "0000000000000002", "https://a.example")])).toEqual([true, true]);
    expect((await files.load("default")).entries.map((e) => e.origins)).toEqual([["a.example"], ["a.example"]]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("a load runs in the save queue: a slow load started before a save never leaves its older hosts after the save's", async () => {
    const { onPassportHost, passportHostsKnown } = await import("../chrome/passport/hosts");
    passportHostsKnown();
    const cipher = fakeCipher();
    const files = createPassportFiles({ dir, cipher });
    const first = await files.save("default", [{ ...entry("a"), origins: ["old.test"] }], "");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const decrypt = cipher.decrypt.getMockImplementation()!;
    cipher.decrypt.mockImplementationOnce(async (s: string) => (await held, decrypt(s)));
    const load = files.load("default");
    const save = files.save("default", [{ ...entry("a"), origins: ["new.test"] }], first.ok ? first.revision : "");
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect((await load).state).toBe("ok");
    expect((await save).ok).toBe(true);
    expect(onPassportHost("https://new.test/")).toBe(true);
    expect(onPassportHost("https://old.test/")).toBe(false);
    await files.remove("default");
  });

  it("state: null before any load, then the last load's", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    expect(files.state("default")).toBeNull();
    await files.load("default");
    expect(files.state("default")).toBe("ok");
    write("other", { format: "ressac-passport", version: 1, profile: "other", cipher: "zz" });
    await files.load("other");
    expect(files.state("other")).toBe("unreadable");
  });

  it("saving [] removes the file; list() keeps profile files only", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const s = await files.save("default", [entry("a")], "");
    await files.save("work", [entry("a")], "");
    writeFileSync(join(dir, "work.illisible-2026-11-23.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "x");
    expect((await files.list()).sort()).toEqual(["default", "work"]);
    expect(await files.save("default", [], s.ok ? s.revision : "")).toEqual({ ok: true, revision: "" });
    expect(existsSync(file("default"))).toBe(false);
    expect(files.count("default")).toBe(0);
    expect(await files.list()).toEqual(["work"]);
  });

  it("ensureKey only when no key and no passport file; concurrent first saves create one key", async () => {
    const cipher = fakeCipher({ key: false });
    const files = createPassportFiles({ dir, cipher });
    expect(await files.list()).toEqual([]);
    const both = await Promise.all([files.save("a", [entry("a")], ""), files.save("b", [entry("b")], "")]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(cipher.ensureKey).toHaveBeenCalledTimes(1);
    await files.save("c", [entry("c")], "");
    expect(cipher.ensureKey).toHaveBeenCalledTimes(1);
    // A file already exists while the key is missing: never a new key over it (it could replace the real one).
    const lost = fakeCipher({ key: false });
    expect(await createPassportFiles({ dir, cipher: lost }).save("d", [entry("d")], "")).toEqual({ ok: false, error: "write" });
    expect(lost.ensureKey).not.toHaveBeenCalled();
  });

  it("an empty save never creates a key", async () => {
    const cipher = fakeCipher({ key: false });
    expect((await createPassportFiles({ dir, cipher }).save("a", [], "")).ok).toBe(true);
    expect(cipher.ensureKey).not.toHaveBeenCalled();
  });

  it("setAside moves the file to <p>.illisible-<date>.json with its bytes, ~n when taken; the name is free, never listed", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher(), now: () => new Date(2026, 10, 24, 9) });
    await files.save("work", [entry("a")], "");
    const bytes = readFileSync(file("work"), "utf8");
    expect(await files.setAside("work")).toBe("work.illisible-2026-11-24.json");
    expect(existsSync(file("work"))).toBe(false);
    expect(readFileSync(join(dir, "work.illisible-2026-11-24.json"), "utf8")).toBe(bytes);
    await files.save("work", [entry("b")], "");
    expect(await files.setAside("work")).toBe("work.illisible-2026-11-24~2.json");
    expect(readFileSync(join(dir, "work.illisible-2026-11-24.json"), "utf8")).toBe(bytes);
    expect(await files.list()).toEqual([]);
    expect(await files.load("work")).toMatchObject({ state: "ok", entries: [] });
    await expect(files.setAside("work")).rejects.toThrow();
  });

  it("ensureKeyBesides: a missing key is made only when no other passport is readable", async () => {
    const cipher = fakeCipher({ key: false });
    const files = createPassportFiles({ dir, cipher });
    write("work", { format: "ressac-passport", version: 1, profile: "work", cipher: sealed({ version: 1, entries: [entry("a")] }) });
    write("old", { format: "ressac-passport", version: 1, profile: "old", cipher: sealed({ version: 1, entries: [entry("a")] }) });
    // « old » cannot be read either (no key): a key is made for the restarted « work ».
    await files.ensureKeyBesides("work");
    expect(cipher.ensureKey).toHaveBeenCalledTimes(1);
    await files.ensureKeyBesides("work");
    expect(cipher.ensureKey).toHaveBeenCalledTimes(1);
    // A key said missing while another passport read fine this session: never replaced.
    const shy = fakeCipher();
    const other = createPassportFiles({ dir, cipher: shy });
    expect((await other.load("old")).state).toBe("ok");
    shy.available.mockResolvedValue(false);
    await other.ensureKeyBesides("work");
    expect(shy.ensureKey).not.toHaveBeenCalled();
  });

  it("remove deletes the file and its set-aside copies, nobody else's", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    await files.save("work", [entry("a")], "");
    await files.save("workshop", [entry("a")], "");
    for (const f of ["work.illisible-2026-11-23.json", "work.illisible-2026-11-23~2.json", "work.json.tmp"]) writeFileSync(join(dir, f), "x");
    await files.remove("work");
    expect(readdirSync(dir).sort()).toEqual(["workshop.json"]);
    expect(files.count("work")).toBe(0);
    await files.remove("never"); // nothing there: no throw
  });

  it("remove with a revision: refused (nothing removed) when the file changed since, through the save queue", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    const first = await files.save("work", [entry("a")], "");
    if (!first.ok) throw new Error("save");
    writeFileSync(join(dir, "work.illisible-1.json"), "x");
    const saving = files.save("work", [entry("a"), entry("b", "Martin")], first.revision);
    await expect(files.remove("work", first.revision)).rejects.toThrow();
    expect((await saving).ok).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["work.illisible-1.json", "work.json"]);
    const now = await files.load("work");
    await files.remove("work", now.revision);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("remove deletes the set-aside copies first and the passport last: a failure on the way leaves it whole", async () => {
    const files = createPassportFiles({ dir, cipher: fakeCipher() });
    await files.save("work", [entry("a")], "");
    // Listed after « work.json »: a copy removed in listing order would come too late.
    writeFileSync(join(dir, "work.json.tmp"), "x");
    writeFileSync(join(dir, "work.illisible-2026-11-23.json"), "x");
    const real = g.IOUtils.remove;
    const order: string[] = [];
    g.IOUtils.remove = async (p: string) => {
      order.push(basename(p));
      if (basename(p) === "work.json.tmp") throw Object.assign(new Error("busy"), { name: "NotAllowedError" });
      return real(p);
    };
    try {
      await expect(files.remove("work")).rejects.toThrow();
      expect(existsSync(join(dir, "work.json"))).toBe(true);
      expect(files.count("work")).toBe(1);
      g.IOUtils.remove = async (p: string) => (order.push(basename(p)), real(p));
      order.length = 0;
      await files.remove("work");
      expect(order.at(-1)).toBe("work.json");
      // The other copy went in the first try.
      expect(order.sort()).toEqual(["work.json", "work.json.tmp"]);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      g.IOUtils.remove = real;
    }
  });

  it("the migration table is empty at version 1 (vN → vN+1, pure)", () => {
    expect(MIGRATIONS).toEqual({});
  });

  it("no value in what the store logs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    write("default", { format: "ressac-passport", version: 1, profile: "default", cipher: sealed({ version: 1, entries: [entry("a")] }) });
    const cipher = fakeCipher();
    cipher.decrypt.mockRejectedValueOnce(new Error(`bad ${SECRET}`));
    await createPassportFiles({ dir, cipher }).load("default");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    spy.mockRestore();
  });
});

describe("passportCipher", () => {
  const calls: unknown[][] = [];
  const service = {
    asyncSecretAvailable: async (...a: unknown[]) => (calls.push(["available", ...a]), true),
    asyncGenerateSecret: async (...a: unknown[]) => (calls.push(["generate", ...a]), ""),
    asyncEncryptBytes: async (label: string, bytes: number[]) => (calls.push(["encrypt", label]), Buffer.from(bytes).toString("base64")),
    asyncDecryptBytes: async (label: string, c: string) => (calls.push(["decrypt", label]), [...Buffer.from(c, "base64")]),
  };
  const env = new Map<string, string>();
  beforeEach(() => {
    calls.length = 0;
    env.clear();
    g.Cc = { "@mozilla.org/security/oskeystore;1": { getService: () => service } };
    g.Ci = { nsIOSKeyStore: "nsIOSKeyStore" };
    g.Services = { env: { get: (k: string) => env.get(k) ?? "" } };
  });
  afterEach(() => {
    delete g.__RESSAC_PACKAGED__;
    delete g.Cc;
    delete g.Ci;
    delete g.Services;
  });

  it("uses its own keychain label: the dev one when not packaged", async () => {
    g.__RESSAC_PACKAGED__ = false;
    const c = passportCipher();
    expect(await c.decrypt(await c.encrypt("é x"))).toBe("é x");
    expect(calls.map((x) => x[1])).toEqual([PASSPORT_KEY_LABEL_DEV, PASSPORT_KEY_LABEL_DEV]);
    g.__RESSAC_PACKAGED__ = true;
    await passportCipher().available();
    expect(calls.at(-1)).toEqual(["available", PASSPORT_KEY_LABEL]);
    expect([PASSPORT_KEY_LABEL, PASSPORT_KEY_LABEL_DEV]).toEqual(["Ressac Passport", "Ressac Passport (dev)"]);
  });

  it("the memory and absent seams work in a dev build and never touch the keychain", async () => {
    g.__RESSAC_PACKAGED__ = false;
    env.set("RESSAC_TEST_PASSPORT_CIPHER", "memory");
    const m = passportCipher();
    const sealedText = await m.encrypt("é x");
    expect(sealedText).not.toContain("é x");
    expect(await passportCipher().decrypt(sealedText)).toBe("é x"); // fixed key: another instance (another launch) reads it
    expect(await m.available()).toBe(true);
    env.set("RESSAC_TEST_PASSPORT_CIPHER", "absent");
    const a = passportCipher();
    expect(await a.available()).toBe(false);
    await expect(a.decrypt(sealedText)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("a packaged build ignores the seams: the real keychain under the real label", async () => {
    g.__RESSAC_PACKAGED__ = true;
    for (const v of ["memory", "absent"]) {
      env.set("RESSAC_TEST_PASSPORT_CIPHER", v);
      expect(await passportCipher().available()).toBe(true);
      expect(calls.at(-1)).toEqual(["available", PASSPORT_KEY_LABEL]);
    }
  });
});
