import { beforeAll, describe, expect, it } from "vitest";
import { ensureFramesSubstitution, framesDir, framesHost, framesKindDir, framesOrigin, framesToken, wipeFrames } from "../chrome/window/frames-root";

const subs: [string, string, number][] = [];
const removed: string[] = [];

beforeAll(() => {
  Object.assign(globalThis as any, {
    PathUtils: { join: (...p: string[]) => p.join("/"), profileDir: "/profile" },
    IOUtils: { remove: async (p: string) => void removed.push(p) },
    Ci: { nsIResProtocolHandler: 1, nsISubstitutingProtocolHandler: { ALLOW_CONTENT_ACCESS: 4 } },
    ChromeUtils: { importESModule: () => ({ FileUtils: { File: class { constructor(public path: string) {} } } }) },
    Services: {
      io: {
        getProtocolHandler: () => ({ QueryInterface: () => ({ setSubstitutionWithFlags: (n: string, u: { spec: string }, f: number) => subs.push([n, u.spec, f]) }) }),
        newFileURI: (f: { path: string }) => ({ spec: `file://${f.path}` }),
      },
    },
  });
});

describe("frames root", () => {
  it("draws a 16-hex token once per process", () => {
    expect(framesToken()).toMatch(/^[0-9a-f]{16}$/);
    expect(framesToken()).toBe(framesToken());
    expect(framesOrigin()).toBe(`resource://${framesHost()}`);
  });

  it("keeps the copies under <profile>/chrome/ressac-frames", () => {
    expect(framesDir()).toBe("/profile/chrome/ressac-frames");
    expect(framesKindDir("sites")).toBe("/profile/chrome/ressac-frames/sites");
  });

  it("sets one content-accessible substitution, once", () => {
    ensureFramesSubstitution();
    ensureFramesSubstitution();
    expect(subs).toEqual([[framesHost(), "file:///profile/chrome/ressac-frames", 4]]);
  });

  it("wipes the whole folder", async () => {
    await wipeFrames();
    expect(removed).toEqual(["/profile/chrome/ressac-frames"]);
  });
});
