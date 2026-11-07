import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "../chrome/shims/fs";
import { join } from "../chrome/shims/path";

const files = new Map<string, string>();
const notFound = (): Error => Object.assign(new Error("missing"), { name: "NotFoundError" });
const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  files.clear();
  g.IOUtils = {
    readUTF8: async (p: string) => files.get(p) ?? Promise.reject(notFound()),
    writeUTF8: async (p: string, t: string) => (files.set(p, t), t.length),
    exists: async (p: string) => files.has(p),
    move: async (a: string, b: string) => {
      if (!files.has(a)) throw notFound();
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    makeDirectory: async () => {},
    remove: async (p: string) => void files.delete(p),
  };
  g.PathUtils = { join: (...p: string[]) => p.join("/") };
});

describe("node shims", () => {
  it("reports a missing file with code ENOENT", async () => {
    await expect(fs.readFile("/x", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access("/x")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("writes through open, then reads back", async () => {
    const f = await fs.open("/a", "w");
    await f.writeFile("hello");
    await f.sync();
    await f.close();
    expect(await fs.readFile("/a", "utf8")).toBe("hello");
  });
  it("renames", async () => {
    files.set("/a", "1");
    await fs.rename("/a", "/b");
    expect([files.has("/a"), files.get("/b")]).toEqual([false, "1"]);
  });
  it("joins paths", () => expect(join("a", "b")).toBe("a/b"));
});

describe("node:url shim", () => {
  it("domainToASCII matches node:url's", async () => {
    const { domainToASCII } = await import("../chrome/shims/url");
    const node = await import("node:url");
    for (const d of ["exemple.fr", "ÉCOLE.fr", "bücher.de", "日本.jp", "xn--bcher-kva.de", "a..b", "exa mple.com", ""]) expect(domainToASCII(d), d).toBe(node.domainToASCII(d));
  });
});

describe("@webaios/noyau shim: what Electron's viseur.ts imports", () => {
  it("drift: HTML_MAX, MARGE_CAPTURE, MONDE_VISEUR, STYLES_UTILES, TRONQUE and tronquerHtml match design/remarques.ts", async () => {
    const shim = await import("../chrome/shims/noyau");
    const real = await import("../../../packages/noyau/src/design/remarques");
    for (const k of ["HTML_MAX", "MARGE_CAPTURE", "MONDE_VISEUR", "STYLES_UTILES", "TRONQUE"] as const) expect(shim[k], k).toEqual(real[k]);
    for (const h of ["", "a".repeat(4096), "b".repeat(4097)]) expect(shim.tronquerHtml(h)).toBe(real.tronquerHtml(h));
  });
});
