import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPONENT_HTML_MAX as NOYAU_COMPOSANT_HTML_MAX } from "../../../packages/noyau/src/pages/composants-agent";
import { COMPOSANT_HTML_MAX, actionImage, actionImageTestUrl, releaseComponent, serveComponent } from "../chrome/store/action-media";

vi.mock("../chrome/store/containers", () => ({ containerFor: (p: string) => (p === "action-images" ? 7 : -1) }));
/** The URLs the action images' opener was asked for, and the options it was built with. */
const opened: string[] = [];
const built: unknown[] = [];
vi.mock("../chrome/store/site-home", async (original) => ({
  ...(await original<typeof import("../chrome/store/site-home")>()),
  containerRequests: (id: number, o: unknown) => {
    built.push([id, o]);
    return (url: string) => {
      opened.push(url);
      throw new Error("no network in unit tests");
    };
  },
}));

let root: string;
let env = "";
/** Each IOUtils call: a refused name must read nothing. */
const io: string[] = [];
/** What the resource:// substitutions received: name → folder (null: removed). */
const substitutions = new Map<string, string | null>();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "webaios-action-media-")));
  const log =
    <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
    (...a: A) => (io.push(name), f(...a));
  Object.assign(globalThis as any, {
    PathUtils: { join: (...parts: string[]) => join(...parts) },
    IOUtils: {
      stat: log("stat", async (p: string) => {
        const s = statSync(p);
        return { lastModified: s.mtimeMs, size: s.size, type: s.isFile() ? "regular" : s.isDirectory() ? "directory" : "other" };
      }),
      read: log("read", async (p: string, o?: { maxBytes?: number }) => new Uint8Array(readFileSync(p)).subarray(0, o?.maxBytes)),
      writeUTF8: log("writeUTF8", async (p: string, t: string) => void writeFileSync(p, t)),
      move: log("move", async (a: string, b: string) => void renameSync(a, b)),
      exists: log("exists", async (p: string) => existsSync(p)),
      makeDirectory: log("makeDirectory", async (p: string) => void mkdirSync(p, { recursive: true })),
      getChildren: log("getChildren", async (p: string) => readdirSync(p).map((n) => join(p, n))),
      remove: log("remove", async (p: string) => rmSync(p, { recursive: true, force: true })),
    },
    Ci: { nsIFile: "nsIFile", nsIResProtocolHandler: "nsIResProtocolHandler" },
    Cc: {
      "@mozilla.org/file/local;1": {
        createInstance: () => {
          let p = "";
          return {
            initWithPath: (x: string) => void (p = x),
            normalize: () => void (p = realpathSync(p)),
            isSymlink: () => lstatSync(p).isSymbolicLink(),
            get path() {
              return p;
            },
          };
        },
      },
    },
    ChromeUtils: { importESModule: () => ({ FileUtils: { File: class { constructor(public path: string) {} } } }) },
    Services: {
      env: { get: (k: string) => (k === "WEBAIOS_TEST_ACTION_IMAGES" ? env : "") },
      io: {
        getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitution: (n: string, uri: { spec: string } | null) => substitutions.set(n, uri && uri.spec) }) }),
        newFileURI: (f: { path: string }) => ({ spec: `file://${f.path}` }),
      },
    },
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  env = "";
  opened.length = 0;
  built.length = 0;
  io.length = 0;
});

describe("action result images", () => {
  it("actionImageTestUrl keeps the address without an origin, rewrites it under one", () => {
    expect(actionImageTestUrl("https://img.exemple/p.png?x=1", undefined)).toBe("https://img.exemple/p.png?x=1");
    expect(actionImageTestUrl("https://img.exemple/photos/1.jpg", "http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000/img.exemple/photos/1.jpg");
  });

  it("no test hook, no change: the opener asks for the address as given, anonymous, in the action images' container", async () => {
    expect(await actionImage("https://img.exemple/p.png")).toBeNull();
    expect(opened).toEqual(["https://img.exemple/p.png"]);
    expect(built).toEqual([[7, { anonymous: true }]]);
  });

  it("under the test hook only the opener's address changes; a refused address is never opened", async () => {
    env = "http://127.0.0.1:4000";
    expect(await actionImage("https://img.exemple/p.png")).toBeNull();
    expect(await actionImage("http://img.exemple/p.png")).toBeNull();
    expect(await actionImage("https://127.0.0.1/p.png")).toBeNull();
    expect(opened).toEqual(["http://127.0.0.1:4000/img.exemple/p.png"]);
  });
});

describe("agent components", () => {
  const data = () => join(root, "data");
  const write = (nom: string, html: string) => {
    mkdirSync(join(data(), "espace", "composants", nom), { recursive: true });
    writeFileSync(join(data(), "espace", "composants", nom, "composant.html"), html);
  };

  it("COMPOSANT_HTML_MAX is the kernel's", () => {
    expect(COMPOSANT_HTML_MAX).toBe(NOYAU_COMPOSANT_HTML_MAX);
  });

  it("a name outside ^[a-z0-9-]{1,40}$ gives null without reading the disk", async () => {
    for (const nom of ["../x", "X", "", "a".repeat(41), "a/b"]) expect(await serveComponent(data(), nom)).toBeNull();
    expect(io).toEqual([]);
  });

  it("serves one sanitized copy per name, kept until its last page lets it go", async () => {
    write("barres", "<!doctype html><p>barres</p>");
    const url = await serveComponent(data(), "barres");
    expect(url).toMatch(/^resource:\/\/webaios-composant-barres\/composant-\d+\.html$/);
    const copies = join(data(), "webaios-composants", "barres");
    const served = readFileSync(join(copies, new URL(url!).pathname.slice(1)), "utf8");
    expect(served).toContain('http-equiv="Content-Security-Policy"');
    expect(served).toContain("webaios-composant");
    expect(served).toContain('defineProperty(w, "Components"');
    expect(substitutions.get("webaios-composant-barres")).toBe(`file://${copies}`);
    expect(await serveComponent(data(), "barres")).toBe(url);
    expect(readdirSync(copies)).toHaveLength(1);
    await releaseComponent(data(), "barres");
    expect(substitutions.get("webaios-composant-barres")).toBe(`file://${copies}`);
    await releaseComponent(data(), "barres");
    expect(substitutions.get("webaios-composant-barres")).toBeNull();
    expect(existsSync(copies)).toBe(false);
  });

  it("refuses a missing or oversized component", async () => {
    write("gros", "x".repeat(256 * 1024 + 1));
    expect(await serveComponent(data(), "gros")).toBeNull();
    expect(await serveComponent(data(), "absent")).toBeNull();
  });
});
