import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testEnv } from "../chrome/test-env";
import { hostEnvironment } from "../chrome/agent/host";

const g = globalThis as { Services?: unknown; __RESSAC_PACKAGED__?: boolean };

/** Every .ts file under `dir`. */
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

describe("test-only environment", () => {
  afterEach(() => {
    delete g.Services;
    delete g.__RESSAC_PACKAGED__;
  });

  it("testEnv gives the variable in a dev build only; a packaged build, or one without the flag, gets undefined", () => {
    g.Services = { env: { get: (n: string) => (n === "RESSAC_TEST_X" ? "/tmp/actors" : "") } };
    g.__RESSAC_PACKAGED__ = false;
    expect(testEnv("RESSAC_TEST_X")).toBe("/tmp/actors");
    expect(testEnv("RESSAC_TEST_Y")).toBeUndefined();
    g.__RESSAC_PACKAGED__ = true;
    expect(testEnv("RESSAC_TEST_X")).toBeUndefined();
    delete g.__RESSAC_PACKAGED__;
    expect(testEnv("RESSAC_TEST_X")).toBeUndefined();
  });

  it("the chrome reads RESSAC_TEST_* through testEnv only", () => {
    // A name as a string of its own ("RESSAC_TEST_…") is a read: it must be testEnv's argument.
    const bypass = ["chrome", "core", "shared"].flatMap(files).filter((f) => !f.endsWith("test-env.ts")).flatMap((f) =>
      code(f)
        .split("\n")
        .filter((l) => /["'`]RESSAC_TEST_/.test(l) && !/testEnv\(\s*"RESSAC_TEST_/.test(l) && !/^\s*const TEST_PUBLIC = "RESSAC_TEST_[A-Z_]+" as const;$/.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    expect(bypass).toEqual([]);
    // Nothing reads the environment by a name the line does not show (relaunch.ts's own list excepted).
    const indirect = ["chrome", "core", "shared"].flatMap(files).flatMap((f) =>
      [...code(f).matchAll(/Services\.env\.get\(([^)]*)\)/g)].map((m) => m[1]!).filter((a) => !/^"(?!RESSAC_TEST_)[A-Z_]+"$/.test(a) && !(f.endsWith("relaunch.ts") && a === "k") && !(f.endsWith("local-guard.ts") && a === "TEST_PUBLIC") && !(f.endsWith("test-env.ts") && a === "name")).map((a) => `${f}: ${a}`),
    );
    expect(indirect).toEqual([]);
  });

  it("the packaged host drops RESSAC_TEST_* before anything is imported; the kernel reads none", () => {
    const host = readFileSync("host/host.ts", "utf8");
    const scrub = host.indexOf('if (k.startsWith("RESSAC_TEST_") || DEV_OVERRIDES.includes(k)) delete process.env[k]');
    expect(scrub).toBeGreaterThan(0);
    // The overrides that pick a binary, a model or a download go too.
    for (const k of ["RESSAC_GIT", "RESSAC_KEV_URL", "RESSAC_EMBED_URL", "RESSAC_EMBED_SHA256", "RESSAC_D1_URL", "RESSAC_D1_SHA256"]) expect(host).toMatch(new RegExp(`DEV_OVERRIDES = \\[[^\\]]*"${k}"`));
    // The packaged chrome keeps its trust files where no environment moves them.
    expect(code("chrome/store/index.ts")).toMatch(/__RESSAC_PACKAGED__ === false && Services\.env\.get\("RESSAC_DATA_DIR"\)/);
    expect(scrub).toBeLessThan(host.indexOf("await import("));
    // Its static imports run first: types only, and the locale module, which reads no variable.
    const staticImports = [...host.matchAll(/^import (?!type )[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(["./locale.ts"]);
    expect(readFileSync("host/locale.ts", "utf8")).not.toMatch(/process\.env/);
    expect(files("../../packages/kernel/src").filter((f) => /RESSAC_TEST_/.test(code(f)))).toEqual([]);
  });

  it("the host is spawned without Node or loader injection variables", () => {
    expect(hostEnvironment({ PATH: "/bin", HOME: "/h", NODE_OPTIONS: "--require /x.js", NODE_PATH: "/x", NODE_EXTRA_CA_CERTS: "/ca", DYLD_INSERT_LIBRARIES: "/l.dylib", RESSAC_ROOT: "/r" })).toEqual({ PATH: "/bin", HOME: "/h", RESSAC_ROOT: "/r" });
  });
});
