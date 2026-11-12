import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneBookmarks, summary, visitBatches } from "../chrome/store/import/importer";
import { chromiumProfiles, detectSources, firefoxProfiles } from "../chrome/store/import/sources";

let home = "";
afterEach(() => home && rmSync(home, { recursive: true, force: true }));
const exists = async (p: string) => existsSync(p);

describe("source detection", () => {
  it("lists only the browsers whose data folder exists under the home", async () => {
    home = mkdtempSync(join(tmpdir(), "import-home-"));
    for (const d of ["Google/Chrome", "Arc/User Data", "BraveSoftware/Brave-Browser"]) mkdirSync(join(home, "Library/Application Support", d), { recursive: true });
    // A folder of another name is not Vivaldi's.
    mkdirSync(join(home, "Library/Application Support/Vivaldi-not"), { recursive: true });
    expect((await detectSources(home, exists, true)).map((s) => s.id)).toEqual(["arc", "chrome", "brave"]);
  });

  it("never offers Safari under a test home (its migrator reads the real ~/Library)", async () => {
    home = mkdtempSync(join(tmpdir(), "import-home-"));
    mkdirSync(join(home, "Library/Safari"), { recursive: true });
    expect(await detectSources(home, exists, true)).toEqual([]);
    expect((await detectSources(home, exists, false)).map((s) => s.id)).toEqual(["safari"]);
  });

  it("reads Chromium profiles from Local State, the last used first", () => {
    const state = { profile: { last_used: "Profile 1", info_cache: { Default: { name: "Perso" }, "Profile 1": { name: "Travail" }, "Profile 2": {} } } };
    expect(chromiumProfiles(state)).toEqual([
      { id: "Profile 1", name: "Travail" },
      { id: "Default", name: "Perso" },
      { id: "Profile 2", name: "Profile 2" },
    ]);
    expect(chromiumProfiles({})).toBeNull();
  });

  it("reads profiles.ini, the install's default first", () => {
    const ini = "[General]\nVersion=2\n\n[Profile0]\nName=old\nIsRelative=1\nPath=Profiles/a.old\nDefault=1\n\n[Profile1]\nName=main\nIsRelative=0\nPath=/abs/b.main\n\n[Install1]\nDefault=/abs/b.main\n";
    expect(firefoxProfiles(ini, "/root")).toEqual([
      { id: "/abs/b.main", name: "main" },
      { id: "/root/Profiles/a.old", name: "old" },
    ]);
  });
});

describe("history batches", () => {
  it("keeps the latest visit of each URL, never in the future, in batches of 5 000", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const pages = Array.from({ length: 12_000 }, (_, i) => ({ url: new URL(`https://e.example/${i}`), title: `P${i}`, visits: [{ date: new Date("2026-10-01T00:00:00Z") }] }));
    pages.push({ url: new URL("https://e.example/0"), title: "", visits: [{ date: new Date("2026-11-01T00:00:00Z") }] });
    pages.push({ url: new URL("https://e.example/1"), title: "Older", visits: [{ date: new Date("2026-01-01T00:00:00Z") }] });
    pages.push({ url: new URL("https://future.example/"), title: "F", visits: [{ date: new Date("2030-01-01T00:00:00Z") }] });
    const batches = visitBatches(pages, 5000, now);
    expect(batches.map((b) => b.length)).toEqual([5000, 5000, 2001]);
    const all = batches.flat();
    expect(all.find((v) => v.url === "https://e.example/0")).toEqual({ url: "https://e.example/0", title: "P0", date: "2026-11-01T00:00:00.000Z" });
    expect(all.find((v) => v.url === "https://e.example/1")).toEqual({ url: "https://e.example/1", title: "P1", date: "2026-10-01T00:00:00.000Z" });
    expect(all.find((v) => v.url === "https://future.example/")!.date).toBe(now.toISOString());
  });
});

describe("bookmarks dedupe", () => {
  it("skips a URL already under a folder of the same title, and the folders left empty", () => {
    const existing = new Set(["toolbar\nhttps://a.example/", "Travail\nhttps://b.example/page"]);
    const items = [
      { url: "https://a.example", title: "A" },
      { url: "https://c.example/", title: "C" },
      { type: 2, title: "Travail", children: [{ url: "https://b.example/page", title: "B" }] },
      { type: 2, title: "Lire", children: [{ url: "https://a.example/", title: "A ailleurs" }] },
    ];
    const r = pruneBookmarks(items, "toolbar", existing);
    expect(r.items).toEqual([
      { url: "https://c.example/", title: "C" },
      { type: 2, title: "Lire", children: [{ url: "https://a.example/", title: "A ailleurs" }] },
    ]);
    expect(r.count).toBe(2);
    expect(pruneBookmarks(items, "toolbar", existing).count).toBe(0);
  });
});

describe("end notification", () => {
  it("names what came in, then what failed", () => {
    const s = summary({ source: "chrome", done: true, counts: { bookmarks: 412, history: 18_000, passwords: 96 }, failed: {} });
    expect(s.title).toBe("Import terminé");
    expect(s.text.replace(/\s/g, " ")).toBe("412 favoris, 18 000 pages d'historique, 96 mots de passe");
    const p = summary({ source: "chrome", done: true, counts: { bookmarks: 1, history: 0 }, failed: { passwords: "accès refusé" } });
    expect(p.title).toBe("Import terminé en partie");
    expect(p.text).toBe("1 favori, 0 page d'historique. Non importé : mots de passe (accès refusé)");
  });
});
