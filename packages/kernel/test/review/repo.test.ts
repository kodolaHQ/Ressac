import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ACCESS_DENIED, ReviewStore, ReviewError, GIT_REQUIRED, gitAvailable } from "../../src/review/repo.js";
import { tempFolder } from "../helpers/temp.js";

const GIT = process.env.WEBAIOS_GIT ?? "/usr/bin/git";
let root: string;
let folder: string;
let depot: string;
let r: ReviewStore;

beforeEach(async () => {
  root = await tempFolder();
  folder = join(root, "projet");
  depot = join(root, "prive", "p.git");
  await mkdir(folder, { recursive: true });
  r = new ReviewStore({ depot, dossier: folder });
});
afterEach(async () => {
  await chmod(folder, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const write = (name: string, content: string | Buffer) => writeFile(join(folder, name), content);
const numbered = (n: number, f = (i: number) => `ligne ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

describe("reference", () => {
  test("gitDisponible", async () => {
    expect(await gitAvailable()).toBe(true);
    expect(await gitAvailable("/chemin/absent")).toBe(false);
  });
  test("assurerReference creates refs/webaios/relu in the private repo; a second call returns false; no .git in the folder", async () => {
    await write("a.txt", "a\n");
    expect(await r.assurerReference()).toBe(true);
    expect(await r.assurerReference()).toBe(false);
    const ref = execFileSync(GIT, ["--git-dir", depot, "rev-parse", "refs/webaios/relu"]).toString().trim();
    expect(ref).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await readdir(folder)).toEqual(["a.txt"]);
  });
  test("retenir() then comparer(): no difference", async () => {
    await write("a.txt", "a\n");
    await r.assurerReference();
    await write("a.txt", "b\n");
    expect((await r.comparer()).fichiers).toHaveLength(1);
    await r.retenir();
    const c = await r.comparer();
    expect(c.fichiers).toEqual([]);
    expect(c.arbreRelu).toBe(c.arbreCourant);
  });
});

describe("comparer and file", () => {
  test("modification, addition and deletion; blocks with 3 lines of context", async () => {
    await write("m.txt", numbered(20));
    await write("s.txt", "x\ny\n");
    await r.assurerReference();
    await write("m.txt", numbered(20, (i) => (i === 10 ? "changée" : `ligne ${i}`)));
    await write("n.txt", "un\ndeux\n");
    await rm(join(folder, "s.txt"));
    const c = await r.comparer();
    expect(c.fichiers).toEqual([
      { chemin: "m.txt", statut: "modifie", ajouts: 1, suppressions: 1, affichable: true },
      { chemin: "n.txt", statut: "ajoute", ajouts: 2, suppressions: 0, affichable: true },
      { chemin: "s.txt", statut: "supprime", ajouts: 0, suppressions: 2, affichable: true },
    ]);
    const f = await r.fichier(c, "m.txt");
    expect(f.statut).toBe("modifie");
    expect(f.blocs).toHaveLength(1);
    const b = f.blocs[0]!;
    expect(b).toMatchObject({ ancienDebut: 7, ancienNombre: 7, nouveauDebut: 7, nouveauNombre: 7 });
    expect(b.lignes.filter((l) => l.marque === " ")).toHaveLength(6);
    expect(b.lignes.find((l) => l.marque === "+")).toMatchObject({ texte: "changée", nouveau: 10 });
  });
  test("exclusions and the folder's .gitignore", async () => {
    await r.assurerReference();
    for (const d of ["node_modules", "dist", "build", ".next"]) {
      await mkdir(join(folder, d), { recursive: true });
      await write(join(d, "x.js"), "x");
    }
    await write(".DS_Store", "x");
    await write(".gitignore", "secret.txt\n");
    await write("secret.txt", "s");
    await write("visible.txt", "v");
    const c = await r.comparer();
    expect(c.fichiers.map((f) => f.chemin)).toEqual([".gitignore", "visible.txt"]);
  });
  test("name « mon fichier é \"x\".txt »: listed and diffed", async () => {
    await r.assurerReference();
    const name = 'mon fichier é "x".txt';
    await write(name, "salut\n");
    const c = await r.comparer();
    expect(c.fichiers.map((f) => f.chemin)).toEqual([name]);
    const f = await r.fichier(c, name);
    expect(f.blocs[0]!.lignes).toEqual([{ marque: "+", texte: "salut", ancien: null, nouveau: 1 }]);
  });
  test("binaire, trop gros (octets), trop gros (lignes) : blocs vides", async () => {
    await r.assurerReference();
    await write("bin.dat", Buffer.from([65, 0, 66]));
    await write("gros.txt", Buffer.alloc(1048577, 97));
    await write("long.txt", numbered(5001));
    await write("limite.txt", Buffer.alloc(1048576, 97));
    const c = await r.comparer();
    const by = Object.fromEntries(c.fichiers.map((f) => [f.chemin, f.affichable]));
    expect(by).toEqual({ "bin.dat": "binaire", "gros.txt": "trop-gros", "long.txt": "trop-gros", "limite.txt": true });
    for (const n of ["bin.dat", "gros.txt", "long.txt"]) expect((await r.fichier(c, n)).blocs).toEqual([]);
  });
  test("a name that starts with « : » or contains « * » also passes the size check", async () => {
    await r.assurerReference();
    await write(":gros.txt", Buffer.alloc(1048577, 97));
    await write("gr*s.txt", Buffer.alloc(1048577, 98));
    const c = await r.comparer();
    const by = Object.fromEntries(c.fichiers.map((f) => [f.chemin, f.affichable]));
    expect(by).toEqual({ ":gros.txt": "trop-gros", "gr*s.txt": "trop-gros" });
  });
  test("lignes(arbreCourant, chemin, 10, 12) rend ces trois lignes", async () => {
    await r.assurerReference();
    await write("t.txt", numbered(30));
    const c = await r.comparer();
    expect(await r.lignes(c.arbreCourant, "t.txt", 10, 12)).toEqual(["ligne 10", "ligne 11", "ligne 12"]);
  });
  test("supprimer removes the private repo", async () => {
    await r.assurerReference();
    await r.supprimer();
    await expect(stat(depot)).rejects.toThrow();
    expect(await r.assurerReference()).toBe(true);
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
    await r.assurerReference();
    await write("n.txt", "n2\n");
    const c = await r.comparer();
    expect(c.fichiers.map((f) => f.chemin).sort()).toEqual(["n.txt"]);
    await r.fichier(c, "n.txt");
    await r.retenir();
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
    await r.assurerReference();
    await writeFile(join(sub, "f.txt"), "g\n");
    const c = await r.comparer();
    expect(c.fichiers.every((f) => !f.chemin.includes(".git/") && f.chemin !== "sous")).toBe(true);
    await r.retenir();
    expect([...(await hash(join(sub, ".git"))), ...(await hash(join(withCommit, ".git")))]).toEqual(before);
  });
});

describe("erreurs", () => {
  test("git absent : GIT_NECESSAIRE", async () => {
    const without = new ReviewStore({ depot, dossier: folder, git: "/chemin/absent" });
    await expect(without.assurerReference()).rejects.toMatchObject({ raison: GIT_REQUIRED });
    await expect(without.assurerReference()).rejects.toBeInstanceOf(ReviewError);
  });
  test("git whose --version fails: GIT_NECESSAIRE", async () => {
    const fake = join(root, "faux-git");
    await writeFile(fake, "#!/bin/sh\necho 'xcrun: error' >&2\nexit 1\n", { mode: 0o755 });
    await expect(new ReviewStore({ depot, dossier: folder, git: fake }).assurerReference()).rejects.toMatchObject({ raison: GIT_REQUIRED });
  });
  test("WEBAIOS_GIT=/chemin/absent : GIT_NECESSAIRE", async () => {
    const before = process.env.WEBAIOS_GIT;
    process.env.WEBAIOS_GIT = "/chemin/absent";
    try {
      await expect(new ReviewStore({ depot, dossier: folder }).assurerReference()).rejects.toMatchObject({ raison: GIT_REQUIRED });
    } finally {
      if (before === undefined) delete process.env.WEBAIOS_GIT; else process.env.WEBAIOS_GIT = before;
    }
  });
  test.skipIf(process.getuid?.() === 0)("sous-dossier chmod 000 : ACCES_REFUSE", async () => {
    await write("a.txt", "a");
    await mkdir(join(folder, "sub"));
    await writeFile(join(folder, "sub", "x.txt"), "x");
    await chmod(join(folder, "sub"), 0o000);
    try {
      await expect(r.assurerReference()).rejects.toMatchObject({ raison: ACCESS_DENIED });
    } finally {
      await chmod(join(folder, "sub"), 0o755);
    }
  });
  test.skipIf(process.getuid?.() === 0)("dossier chmod 000 : ACCES_REFUSE", async () => {
    await write("a.txt", "a");
    await chmod(folder, 0o000);
    await expect(r.assurerReference()).rejects.toMatchObject({ raison: ACCESS_DENIED });
  });
});
