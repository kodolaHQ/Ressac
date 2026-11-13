import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ACCESS_DENIED, ReviewStore, ReviewError, GIT_REQUIRED, gitAvailable } from "../../src/review/repo.js";
import { tempFolder } from "../helpers/temp.js";

const GIT = process.env.RESSAC_GIT ?? "/usr/bin/git";
let root: string;
let folder: string;
let repo: string;
let r: ReviewStore;

beforeEach(async () => {
  root = await tempFolder();
  folder = join(root, "projet");
  repo = join(root, "prive", "p.git");
  await mkdir(folder, { recursive: true });
  r = new ReviewStore({ repo, folder: folder });
});
afterEach(async () => {
  await chmod(folder, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const write = (name: string, content: string | Buffer) => writeFile(join(folder, name), content);
const numbered = (n: number, f = (i: number) => `ligne ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

describe("reference", () => {
  test("gitAvailable", async () => {
    expect(await gitAvailable()).toBe(true);
    expect(await gitAvailable("/chemin/absent")).toBe(false);
  });
  test("assurerReference creates refs/ressac/relu in the private repo; a second call returns false; no .git in the folder", async () => {
    await write("a.txt", "a\n");
    expect(await r.ensureReference()).toBe(true);
    expect(await r.ensureReference()).toBe(false);
    const ref = execFileSync(GIT, ["--git-dir", repo, "rev-parse", "refs/ressac/relu"]).toString().trim();
    expect(ref).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await readdir(folder)).toEqual(["a.txt"]);
  });
  test("retenir() then comparer(): no difference", async () => {
    await write("a.txt", "a\n");
    await r.ensureReference();
    await write("a.txt", "b\n");
    expect((await r.compare()).files).toHaveLength(1);
    await r.keep();
    const c = await r.compare();
    expect(c.files).toEqual([]);
    expect(c.reviewedTree).toBe(c.currentTree);
  });
  test("a project reviewed under WebAiOs (refs/webaios/relu only) reads as reviewed there; « Marquer comme relu » writes the new ref, which wins", async () => {
    const g = (...a: string[]) => execFileSync(GIT, ["--git-dir", repo, ...a]).toString().trim();
    await write("a.txt", "a\n");
    await r.ensureReference();
    const old = g("rev-parse", "refs/ressac/relu");
    g("update-ref", "refs/webaios/relu", old);
    g("update-ref", "-d", "refs/ressac/relu");
    await write("a.txt", "b\n");
    expect(await r.ensureReference()).toBe(false);
    const c = await r.compare();
    expect(c.reviewedTree).toBe(g("rev-parse", "refs/webaios/relu^{tree}"));
    expect(c.files).toHaveLength(1);
    await r.keep();
    expect((await r.compare()).files).toEqual([]);
    expect(g("rev-parse", "refs/ressac/relu^{tree}")).toBe((await r.compare()).currentTree);
    expect(g("rev-parse", "refs/webaios/relu")).toBe(old);
  });
});

describe("comparer and file", () => {
  test("modification, addition and deletion; blocks with 3 lines of context", async () => {
    await write("m.txt", numbered(20));
    await write("s.txt", "x\ny\n");
    await r.ensureReference();
    await write("m.txt", numbered(20, (i) => (i === 10 ? "changée" : `ligne ${i}`)));
    await write("n.txt", "un\ndeux\n");
    await rm(join(folder, "s.txt"));
    const c = await r.compare();
    expect(c.files).toEqual([
      { path: "m.txt", status: "modified", additions: 1, deletions: 1, displayable: true },
      { path: "n.txt", status: "added", additions: 2, deletions: 0, displayable: true },
      { path: "s.txt", status: "deleted", additions: 0, deletions: 2, displayable: true },
    ]);
    const f = await r.file(c, "m.txt");
    expect(f.status).toBe("modified");
    expect(f.blocks).toHaveLength(1);
    const b = f.blocks[0]!;
    expect(b).toMatchObject({ oldStart: 7, oldCount: 7, newStart: 7, newCount: 7 });
    expect(b.lines.filter((l) => l.mark === " ")).toHaveLength(6);
    expect(b.lines.find((l) => l.mark === "+")).toMatchObject({ text: "changée", new: 10 });
  });
  test("exclusions and the folder's .gitignore", async () => {
    await r.ensureReference();
    for (const d of ["node_modules", "dist", "build", ".next"]) {
      await mkdir(join(folder, d), { recursive: true });
      await write(join(d, "x.js"), "x");
    }
    await write(".DS_Store", "x");
    await write(".gitignore", "secret.txt\n");
    await write("secret.txt", "s");
    await write("visible.txt", "v");
    const c = await r.compare();
    expect(c.files.map((f) => f.path)).toEqual([".gitignore", "visible.txt"]);
  });
  test("name « mon fichier é \"x\".txt »: listed and diffed", async () => {
    await r.ensureReference();
    const name = 'mon fichier é "x".txt';
    await write(name, "salut\n");
    const c = await r.compare();
    expect(c.files.map((f) => f.path)).toEqual([name]);
    const f = await r.file(c, name);
    expect(f.blocks[0]!.lines).toEqual([{ mark: "+", text: "salut", old: null, new: 1 }]);
  });
  test("binaire, trop gros (octets), trop gros (lignes) : blocs vides", async () => {
    await r.ensureReference();
    await write("bin.dat", Buffer.from([65, 0, 66]));
    await write("gros.txt", Buffer.alloc(1048577, 97));
    await write("long.txt", numbered(5001));
    await write("limite.txt", Buffer.alloc(1048576, 97));
    const c = await r.compare();
    const by = Object.fromEntries(c.files.map((f) => [f.path, f.displayable]));
    expect(by).toEqual({ "bin.dat": "binary", "gros.txt": "too-big", "long.txt": "too-big", "limite.txt": true });
    for (const n of ["bin.dat", "gros.txt", "long.txt"]) expect((await r.file(c, n)).blocks).toEqual([]);
  });
  test("a name that starts with « : » or contains « * » also passes the size check", async () => {
    await r.ensureReference();
    await write(":gros.txt", Buffer.alloc(1048577, 97));
    await write("gr*s.txt", Buffer.alloc(1048577, 98));
    const c = await r.compare();
    const by = Object.fromEntries(c.files.map((f) => [f.path, f.displayable]));
    expect(by).toEqual({ ":gros.txt": "too-big", "gr*s.txt": "too-big" });
  });
  test("lignes(arbreCourant, chemin, 10, 12) rend ces trois lignes", async () => {
    await r.ensureReference();
    await write("t.txt", numbered(30));
    const c = await r.compare();
    expect(await r.lines(c.currentTree, "t.txt", 10, 12)).toEqual(["ligne 10", "ligne 11", "ligne 12"]);
  });
  test("delete removes the private repo", async () => {
    await r.ensureReference();
    await r.delete();
    await expect(stat(repo)).rejects.toThrow();
    expect(await r.ensureReference()).toBe(true);
  });
});

async function hash(base: string): Promise<string[]> {
  const output: string[] = [];
  const works = async (d: string) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      const s = await stat(p);
      output.push(`${p}|${s.mtimeMs}|${e.isDirectory() ? "" : (await readFile(p)).toString("base64")}`);
      if (e.isDirectory()) await works(p);
    }
  };
  await works(base);
  return output;
}

describe("the project's repo is never touched", () => {
  test("folder with git, staged uncommitted and untracked: .git hash and status identical", async () => {
    const g = (...a: string[]) => execFileSync(GIT, ["-C", folder, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString();
    g("init", "-q");
    await write("c.txt", "c\n");
    g("add", "c.txt");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
    await write("i.txt", "i\n");
    g("add", "i.txt");
    await write("n.txt", "n\n");
    const statusBefore = g("status", "--porcelain");
    const before = await hash(join(folder, ".git"));
    await r.ensureReference();
    await write("n.txt", "n2\n");
    const c = await r.compare();
    expect(c.files.map((f) => f.path).sort()).toEqual(["n.txt"]);
    await r.file(c, "n.txt");
    await r.keep();
    expect(await hash(join(folder, ".git"))).toEqual(before);
    expect(g("status", "--porcelain")).toBe(statusBefore);
  });
  test("subfolder that is a repo: nothing of its .git read as a file, nothing written inside", async () => {
    const sub = join(folder, "sous");
    await mkdir(sub);
    execFileSync(GIT, ["-C", sub, "init", "-q"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    await writeFile(join(sub, "f.txt"), "f\n");
    const withCommit = join(folder, "avec");
    await mkdir(withCommit);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
    execFileSync(GIT, ["-C", withCommit, "init", "-q"], { env });
    await writeFile(join(withCommit, "h.txt"), "h\n");
    execFileSync(GIT, ["-C", withCommit, "add", "h.txt"], { env });
    execFileSync(GIT, ["-C", withCommit, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], { env });
    const before = [...(await hash(join(sub, ".git"))), ...(await hash(join(withCommit, ".git")))];
    await r.ensureReference();
    await writeFile(join(sub, "f.txt"), "g\n");
    const c = await r.compare();
    expect(c.files.every((f) => !f.path.includes(".git/") && f.path !== "sous")).toBe(true);
    await r.keep();
    expect([...(await hash(join(sub, ".git"))), ...(await hash(join(withCommit, ".git")))]).toEqual(before);
  });
});

describe("erreurs", () => {
  test("git absent : GIT_REQUIRED", async () => {
    const without = new ReviewStore({ repo, folder: folder, git: "/chemin/absent" });
    await expect(without.ensureReference()).rejects.toMatchObject({ reason: GIT_REQUIRED });
    await expect(without.ensureReference()).rejects.toBeInstanceOf(ReviewError);
  });
  test("git whose --version fails: GIT_REQUIRED", async () => {
    const fake = join(root, "faux-git");
    await writeFile(fake, "#!/bin/sh\necho 'xcrun: error' >&2\nexit 1\n", { mode: 0o755 });
    await expect(new ReviewStore({ repo, folder: folder, git: fake }).ensureReference()).rejects.toMatchObject({ reason: GIT_REQUIRED });
  });
  test("RESSAC_GIT=/chemin/absent : GIT_REQUIRED", async () => {
    const before = process.env.RESSAC_GIT;
    process.env.RESSAC_GIT = "/chemin/absent";
    try {
      await expect(new ReviewStore({ repo, folder: folder }).ensureReference()).rejects.toMatchObject({ reason: GIT_REQUIRED });
    } finally {
      if (before === undefined) delete process.env.RESSAC_GIT; else process.env.RESSAC_GIT = before;
    }
  });
  test.skipIf(process.getuid?.() === 0)("sous-dossier chmod 000 : ACCES_REFUSE", async () => {
    await write("a.txt", "a");
    await mkdir(join(folder, "sub"));
    await writeFile(join(folder, "sub", "x.txt"), "x");
    await chmod(join(folder, "sub"), 0o000);
    try {
      await expect(r.ensureReference()).rejects.toMatchObject({ reason: ACCESS_DENIED });
    } finally {
      await chmod(join(folder, "sub"), 0o755);
    }
  });
  test.skipIf(process.getuid?.() === 0)("dossier chmod 000 : ACCES_REFUSE", async () => {
    await write("a.txt", "a");
    await chmod(folder, 0o000);
    await expect(r.ensureReference()).rejects.toMatchObject({ reason: ACCESS_DENIED });
  });
});
