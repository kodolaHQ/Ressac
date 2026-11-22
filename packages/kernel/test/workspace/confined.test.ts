import { expect, test } from "vitest";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enter, inChild, inFolder, listFolder, moveEntry, readFiles, writeEntries, type ReadFiles } from "../../src/workspace/confined.js";
import { tempFolder } from "../helpers/temp.js";

declare const __name: <F>(f: F, name: string) => F;

test("inChild: a function compiled with keepNames (tsx) still runs in the child", async () => {
  // What esbuild keepNames emits for an inner arrow function.
  const fn = (n: number) => __name((x: number) => x * 2, "double")(n);
  expect(await inChild(fn, [21])).toBe(42);
});

async function frame() {
  const root = await tempFolder();
  const mac = join(root, "mac");
  await mkdir(join(mac, "sous"), { recursive: true });
  await writeFile(join(mac, "a.txt"), "secret du Mac");
  await writeFile(join(mac, "sous", "a.txt"), "secret du Mac");
  const app = join(root, "space", "app");
  await mkdir(join(app, "sous"), { recursive: true });
  await writeFile(join(app, "a.txt"), "A");
  await writeFile(join(app, "sous", "a.txt"), "B");
  const read = (paths: string[], max = 10, total = 100, names = ["app"]) => inFolder<ReadFiles>(join(root, "space"), names, readFiles, [paths, max, total]);
  return { root, mac, app, read };
}

test("readFiles: reads by bare names; absent, link, .., over a file's or the total cap are reported", async () => {
  const { mac, app, read } = await frame();
  expect(await read(["a.txt", "sous/a.txt"])).toMatchObject({ files: [{ text: "A" }, { text: "B" }] });
  expect(await read(["a.txt", "non.txt"])).toEqual({ failed: 1, why: "absent" });
  expect(await read(["../app/a.txt"])).toEqual({ failed: 0, why: "refused" });
  await writeFile(join(app, "gros.txt"), "x".repeat(11));
  expect(await read(["gros.txt"])).toEqual({ failed: 0, why: "big" });
  expect(await read(["a.txt", "sous/a.txt"], 10, 1)).toEqual({ failed: 1, why: "big" });
  await symlink(join(mac, "a.txt"), join(app, "lien.txt"));
  expect(await read(["lien.txt"])).toEqual({ failed: 0, why: "refused" });
  await symlink(join(mac, "sous"), join(app, "lien"));
  expect(await read(["lien/a.txt"])).toEqual({ failed: 0, why: "refused" });
  // A folder of `names` that is a link: refused before anything is read.
  await symlink(mac, join(app, "..", "faux"));
  expect(await read(["a.txt"], 10, 100, ["faux"])).toBeNull();
});

test("writeEntries: moves from the parent, writes atomically; a folder of the walk that is a link gets nothing", async () => {
  const { root, mac, app } = await frame();
  await mkdir(join(app, "lot"));
  const r = await inFolder(join(root, "space"), ["app", "lot"], writeEntries, [[["b.json", Buffer.from("{}").toString("base64")]], ["a.txt"]]);
  expect(r).toBe("done");
  expect((await readdir(join(app, "lot"))).sort()).toEqual(["a.txt", "b.json"]);
  expect(await readFile(join(app, "lot", "b.json"), "utf8")).toBe("{}");
  // Missing folders are made with `create`, a link on the way refuses.
  expect(await inFolder(join(root, "space"), ["app", "neuf"], writeEntries, [[["c", ""]], []], { create: true })).toBe("done");
  await symlink(mac, join(app, "lien"));
  expect(await inFolder(join(root, "space"), ["app", "lien"], writeEntries, [[["x", ""]], []], { create: true })).toBeNull();
  expect((await readdir(mac)).sort()).toEqual(["a.txt", "sous"]);
});

/**
 * Child side: the first lstat of `swapped` renames that folder away and puts a link to `mac` in its place, the swap the
 * agent can make between the lstat and the chdir; then the real `enter` and `op` run. Self-contained (toString()).
 */
function swapThenRun(enterSource: string, opSource: string, top: string, names: string[], args: unknown[], swapped: string, mac: string): unknown {
  const fs = process.getBuiltinModule("node:fs");
  const lstat = fs.lstatSync;
  let done = false;
  (fs as { lstatSync: unknown }).lstatSync = (p: string, o?: object) => {
    const r = lstat(p, o as never);
    if (p === swapped && !done) {
      done = true;
      fs.renameSync(p, `${p}-vrai`);
      fs.symlinkSync(mac, p);
    }
    return r;
  };
  (0, eval)(`(${enterSource})`)(top, names, true);
  return (0, eval)(`(${opSource})`)(...args);
}

test("a folder swapped for a link between its lstat and the chdir is refused: by enter, by readFiles, before a write", async () => {
  const swapRun = (top: string, names: string[], op: (...a: any[]) => unknown, args: unknown[], swapped: string, mac: string) =>
    inChild(swapThenRun, [enter.toString(), op.toString(), top, names, args, swapped, mac]);
  // enter, on a folder of `names`.
  let f = await frame();
  expect(await swapRun(join(f.root, "space"), ["app"], readFiles, [["a.txt"], 100, 100], "app", f.mac)).toBeNull();
  // readFiles, on a folder of the read path.
  f = await frame();
  expect(await swapRun(join(f.root, "space"), ["app"], readFiles, [["sous/a.txt"], 100, 100], "sous", f.mac)).toEqual({ failed: 0, why: "refused" });
  // A write, after enter.
  f = await frame();
  expect(await swapRun(join(f.root, "space"), ["app", "sous"], writeEntries, [[["x.json", ""]], []], "sous", f.mac)).toBeNull();
  expect((await readdir(f.mac)).sort()).toEqual(["a.txt", "sous"]);
  expect((await readdir(join(f.mac, "sous"))).sort()).toEqual(["a.txt"]);
});

test("enter refuses a folder name that walks out: « .. », or one with a slash", async () => {
  const { root } = await frame();
  expect(await inFolder(join(root, "space", "app"), [".."], listFolder, [])).toBeNull();
  expect(await inFolder(join(root, "space"), ["app/sous"], listFolder, [])).toBeNull();
});

test("moveEntry refuses a parent that is a link, and moves nothing at its end", async () => {
  const { root, mac } = await frame();
  await symlink(mac, join(root, "space", "lien"));
  expect(await inChild(moveEntry, [join(root, "space", "lien"), "sous", "parti"])).toBe("refused");
  expect((await readdir(mac)).sort()).toEqual(["a.txt", "sous"]);
});

/** Child side: the first lstat of `grown` appends to it, as the agent can between the lstat and the read; then `enter` and `readFiles`. */
function growThenRead(enterSource: string, readSource: string, top: string, names: string[], args: unknown[], grown: string): unknown {
  const fs = process.getBuiltinModule("node:fs");
  const lstat = fs.lstatSync;
  let done = false;
  (fs as { lstatSync: unknown }).lstatSync = (p: string, o?: object) => {
    const r = lstat(p, o as never);
    if (p === grown && !done) {
      done = true;
      fs.appendFileSync(p, "grown past the cap");
    }
    return r;
  };
  (0, eval)(`(${enterSource})`)(top, names, false);
  return (0, eval)(`(${readSource})`)(...args);
}

test("readFiles refuses a file that grew past its cap after its lstat, never cuts it", async () => {
  const { root } = await frame();
  expect(await inChild(growThenRead, [enter.toString(), readFiles.toString(), join(root, "space"), ["app"], [["a.txt"], 10, 100], "a.txt"])).toEqual({ failed: 0, why: "big" });
});
