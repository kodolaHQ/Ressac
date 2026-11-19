import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPONENT_HTML_MAX as KERNEL_COMPONENT_HTML_MAX } from "../../../packages/kernel/src/pages/agent-components";
import { COMPONENT_HTML_MAX, actionImage, actionImageTestUrl, releaseComponent, serveComponent as serveWith } from "../chrome/store/action-media";
import { copyComponentRequest } from "../host/home-copy";

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
  root = realpathSync(mkdtempSync(join(tmpdir(), "ressac-action-media-")));
  const log =
    <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
    (...a: A) => (io.push(name), f(...a));
  Object.assign(globalThis as any, {
    // The bundled fonts, read from chrome:// (componentFonts): their file name as the body.
    fetch: async (url: string) => ({ arrayBuffer: async () => new TextEncoder().encode(url.split("/").pop()).buffer }),
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
    // A dev build, as the e2e run: its test hooks are read (chrome/test-env.ts).
    __RESSAC_PACKAGED__: false,
    Services: {
      env: { get: (k: string) => (k === "RESSAC_TEST_ACTION_IMAGES" ? env : "") },
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
  const serveComponent = (dataDir: string, name: string) => serveWith(dataDir, name, (name, token) => copyComponentRequest(dataDir, join(dataDir, "workspace", "components"), { name, token }));
  const write = (name: string, html: string) => {
    mkdirSync(join(data(), "workspace", "components", name), { recursive: true });
    writeFileSync(join(data(), "workspace", "components", name, "component.html"), html);
  };

  it("COMPONENT_HTML_MAX is the kernel's", () => {
    expect(COMPONENT_HTML_MAX).toBe(KERNEL_COMPONENT_HTML_MAX);
  });

  it("a name outside ^[a-z0-9-]{1,40}$ gives null without reading the disk", async () => {
    for (const name of ["../x", "X", "", "a".repeat(41), "a/b"]) expect(await serveComponent(data(), name)).toBeNull();
    expect(io).toEqual([]);
  });

  it("serves one sanitized copy per name, kept until its last page lets it go", async () => {
    write("barres", "<!doctype html><p>barres</p>");
    const url = await serveComponent(data(), "barres");
    expect(url).toMatch(/^resource:\/\/ressac-component-barres\/component-\d+-\d+\.html$/);
    const copies = join(data(), "ressac-components", "barres");
    const served = readFileSync(join(copies, new URL(url!).pathname.slice(1)), "utf8");
    expect(served).toContain('http-equiv="Content-Security-Policy"');
    expect(served).toContain("ressac-component");
    expect(served).toContain('defineProperty(w, "Components"');
    // The browser fonts, inlined (font-src data:) under the families the tokens name, after the CSP meta.
    expect(served).toContain(`font-family: "Geist"; font-weight: 300 700; font-style: normal; font-display: block; src: url("data:font/woff2;base64,${btoa("Geist-latin.woff2")}")`);
    for (const family of ["Funnel Display", "Geist Mono"]) expect(served).toContain(`font-family: "${family}"`);
    expect(served).not.toContain("chrome://");
    expect(served.indexOf("@font-face")).toBeGreaterThan(served.indexOf("Content-Security-Policy"));
    expect(substitutions.get("ressac-component-barres")).toBe(`file://${copies}`);
    expect(await serveComponent(data(), "barres")).toBe(url);
    expect(readdirSync(copies)).toHaveLength(1);
    await releaseComponent(data(), "barres");
    expect(substitutions.get("ressac-component-barres")).toBe(`file://${copies}`);
    await releaseComponent(data(), "barres");
    expect(substitutions.get("ressac-component-barres")).toBeNull();
    expect(existsSync(copies)).toBe(false);
  });

  it("refuses a missing or oversized component", async () => {
    write("gros", "x".repeat(256 * 1024 + 1));
    expect(await serveComponent(data(), "gros")).toBeNull();
    expect(await serveComponent(data(), "absent")).toBeNull();
  });

  it("never serves a component.html that is a link to a file of the Mac, nor through a component folder that is one", async () => {
    writeFileSync(join(root, "secret.html"), "secret du Mac");
    mkdirSync(join(data(), "workspace", "components", "lien"), { recursive: true });
    symlinkSync(join(root, "secret.html"), join(data(), "workspace", "components", "lien", "component.html"));
    mkdirSync(join(root, "mac"), { recursive: true });
    writeFileSync(join(root, "mac", "component.html"), "secret du Mac");
    symlinkSync(join(root, "mac"), join(data(), "workspace", "components", "dossier"));
    for (const name of ["lien", "dossier"]) {
      expect(await serveComponent(data(), name)).toBeNull();
      expect(readdirSync(join(data(), "ressac-components", name))).toEqual([]);
    }
  });
});
