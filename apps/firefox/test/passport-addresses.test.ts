import { afterEach, describe, expect, it, vi } from "vitest";
import { fromChromiumRows, fromFirefoxJson, readAddresses } from "../chrome/passport/addresses";
import { SOURCES } from "../chrome/store/import/sources";

describe("fromChromiumRows", () => {
  const addresses = [
    { guid: "a", use_count: 4, use_date: 1700000000 },
    { guid: "b", use_count: 1, use_date: 1600000000 },
  ];
  const tokens = [
    { guid: "a", type: 3, value: "Camille" },
    { guid: "a", type: 5, value: "Aubrac" },
    { guid: "a", type: 77, value: "14 rue des Tanneurs" },
    { guid: "a", type: 35, value: "69001" },
    { guid: "a", type: 33, value: "Lyon" },
    { guid: "a", type: 14, value: "+33612345678" },
    { guid: "a", type: 9, value: "c@a.fr" },
    { guid: "b", type: 7, value: "Jean Aubrac" },
  ];

  it("builds one address per guid from its typed tokens", () => {
    const [a, b] = fromChromiumRows(addresses, tokens);
    expect(a).toEqual({ given: "Camille", family: "Aubrac", full: "", street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon", country: "", tel: "+33612345678", email: "c@a.fr", usedAt: 1700000000000, useCount: 4 });
    expect(b).toMatchObject({ full: "Jean Aubrac", given: "", usedAt: 1600000000000, useCount: 1 });
  });

  it("ignores an unknown token type and a token of an unknown guid", () => {
    const out = fromChromiumRows([addresses[0]!], [{ guid: "a", type: 999, value: "x" }, { guid: "zz", type: 3, value: "Ghost" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ given: "" });
  });
});

describe("fromFirefoxJson", () => {
  it("maps a stored address", () => {
    const out = fromFirefoxJson({ version: 1, addresses: [{ "given-name": "Camille", "family-name": "Aubrac", "street-address": "14 rue des Tanneurs", "postal-code": "69001", "address-level2": "Lyon", timesUsed: 3, timeLastUsed: 1700000000000 }] });
    expect(out).toEqual([{ given: "Camille", family: "Aubrac", full: "", street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon", country: "", tel: "", email: "", usedAt: 1700000000000, useCount: 3 }]);
  });

  it("returns [] for anything malformed", () => {
    expect(fromFirefoxJson("x")).toEqual([]);
    expect(fromFirefoxJson({})).toEqual([]);
    expect(fromFirefoxJson({ addresses: "x" })).toEqual([]);
    expect(fromFirefoxJson({ addresses: [null, 3] })).toEqual([]);
  });
});

describe("readAddresses (Chromium)", () => {
  afterEach(() => void vi.unstubAllGlobals());

  it("a profile that fails is read as nothing, the others still count; every copy is removed", async () => {
    const removed: string[] = [];
    vi.stubGlobal("IOUtils", {
      readUTF8: async () => JSON.stringify({ profile: { info_cache: { Broken: {}, Default: {} } } }),
      makeDirectory: async () => {},
      setPermissions: async () => {},
      exists: async (path: string) => path.endsWith("Web Data"),
      copy: async (from: string) => {
        if (from.includes("/Broken/")) throw Object.assign(new Error("locked"), { name: "NotReadableError" });
      },
      remove: async (path: string) => void removed.push(path),
    });
    const row = (o: Record<string, unknown>) => ({ getResultByName: (k: string) => o[k] });
    const db = {
      execute: async (sql: string) =>
        sql.includes("sqlite_master") ? [row({})] : sql.includes("FROM addresses") ? [row({ guid: "a", use_count: 1, use_date: 1 })] : sql.includes("FROM address_type_tokens") ? [row({ guid: "a", type: 3, value: "Camille" })] : [],
      close: async () => {},
    };
    vi.stubGlobal("ChromeUtils", { importESModule: () => ({ Sqlite: { openConnection: async () => db } }) });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await readAddresses(SOURCES.find((d) => d.id === "chrome")!, "/root", "/scratch");
    expect(out.map((a) => a.given)).toEqual(["Camille"]);
    expect(error).toHaveBeenCalledWith(expect.any(String), "NotReadableError");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(removed.filter((p) => p === `/scratch/Web Data${suffix}`)).toHaveLength(2);
    error.mockRestore();
  });
});
