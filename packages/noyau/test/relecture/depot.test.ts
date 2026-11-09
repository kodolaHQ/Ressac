import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ACCESS_DENIED, ReviewStore, ReviewError, GIT_REQUIRED, gitAvailable } from "../../src/relecture/depot.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const GIT = process.env.WEBAIOS_GIT ?? "/usr/bin/git";
let racine: string;
let dossier: string;
let depot: string;
let r: ReviewStore;

beforeEach(async () => {
  racine = await dossierTemporaire();
  dossier = join(racine, "projet");
  depot = join(racine, "prive", "p.git");
  await mkdir(dossier, { recursive: true });
  r = new ReviewStore({ depot, dossier });
});
afterEach(async () => {
  await chmod(dossier, 0o755).catch(() => {});
  await rm(racine, { recursive: true, force: true });
});

const ecrire = (nom: string, contenu: string | Buffer) => writeFile(join(dossier, nom), contenu);
const numerotees = (n: number, f = (i: number) => `ligne ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

describe("reference", () => {
  test("gitDisponible", async () => {
    expect(await gitAvailable()).toBe(true);
    expect(await gitAvailable("/chemin/absent")).toBe(false);
  });
  test("assurerReference creates refs/webaios/relu in the private repo; a second call returns false; no .git in the folder", async () => {
    await ecrire("a.txt", "a\n");
    expect(await r.assurerReference()).toBe(true);
    expect(await r.assurerReference()).toBe(false);
    const ref = execFileSync(GIT, ["--git-dir", depot, "rev-parse", "refs/webaios/relu"]).toString().trim();
    expect(ref).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await readdir(dossier)).toEqual(["a.txt"]);
  });
  test("retenir() then comparer(): no difference", async () => {
    await ecrire("a.txt", "a\n");
    await r.assurerReference();
    await ecrire("a.txt", "b\n");
    expect((await r.comparer()).fichiers).toHaveLength(1);
    await r.retenir();
    const c = await r.comparer();
    expect(c.fichiers).toEqual([]);
    expect(c.arbreRelu).toBe(c.arbreCourant);
  });
});

describe("comparer and file", () => {
  test("modification, addition and deletion; blocks with 3 lines of context", async () => {
    await ecrire("m.txt", numerotees(20));
    await ecrire("s.txt", "x\ny\n");
    await r.assurerReference();
    await ecrire("m.txt", numerotees(20, (i) => (i === 10 ? "changée" : `ligne ${i}`)));
    await ecrire("n.txt", "un\ndeux\n");
    await rm(join(dossier, "s.txt"));
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
      await mkdir(join(dossier, d), { recursive: true });
      await ecrire(join(d, "x.js"), "x");
    }
    await ecrire(".DS_Store", "x");
    await ecrire(".gitignore", "secret.txt\n");
    await ecrire("secret.txt", "s");
    await ecrire("visible.txt", "v");
    const c = await r.comparer();
    expect(c.fichiers.map((f) => f.chemin)).toEqual([".gitignore", "visible.txt"]);
  });
  test("name « mon fichier é \"x\".txt »: listed and diffed", async () => {
    await r.assurerReference();
    const nom = 'mon fichier é "x".txt';
    await ecrire(nom, "salut\n");
    const c = await r.comparer();
    expect(c.fichiers.map((f) => f.chemin)).toEqual([nom]);
    const f = await r.fichier(c, nom);
    expect(f.blocs[0]!.lignes).toEqual([{ marque: "+", texte: "salut", ancien: null, nouveau: 1 }]);
  });
  test("binaire, trop gros (octets), trop gros (lignes) : blocs vides", async () => {
    await r.assurerReference();
    await ecrire("bin.dat", Buffer.from([65, 0, 66]));
    await ecrire("gros.txt", Buffer.alloc(1048577, 97));
    await ecrire("long.txt", numerotees(5001));
    await ecrire("limite.txt", Buffer.alloc(1048576, 97));
    const c = await r.comparer();
    const par = Object.fromEntries(c.fichiers.map((f) => [f.chemin, f.affichable]));
    expect(par).toEqual({ "bin.dat": "binaire", "gros.txt": "trop-gros", "long.txt": "trop-gros", "limite.txt": true });
    for (const n of ["bin.dat", "gros.txt", "long.txt"]) expect((await r.fichier(c, n)).blocs).toEqual([]);
  });
  test("a name that starts with « : » or contains « * » also passes the size check", async () => {
    await r.assurerReference();
    await ecrire(":gros.txt", Buffer.alloc(1048577, 97));
    await ecrire("gr*s.txt", Buffer.alloc(1048577, 98));
    const c = await r.comparer();
    const par = Object.fromEntries(c.fichiers.map((f) => [f.chemin, f.affichable]));
    expect(par).toEqual({ ":gros.txt": "trop-gros", "gr*s.txt": "trop-gros" });
  });
  test("lignes(arbreCourant, chemin, 10, 12) rend ces trois lignes", async () => {
    await r.assurerReference();
    await ecrire("t.txt", numerotees(30));
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

async function empreinte(base: string): Promise<string[]> {
  const sortie: string[] = [];
  const marche = async (d: string) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      const s = await stat(p);
      sortie.push(`${p}|${s.mtimeMs}|${e.isDirectory() ? "" : (await readFile(p)).toString("base64")}`);
      if (e.isDirectory()) await marche(p);
    }
  };
  await marche(base);
  return sortie;
}

describe("the project's repo is never touched", () => {
  test("folder with git, staged uncommitted and untracked: .git hash and status identical", async () => {
    const g = (...a: string[]) => execFileSync(GIT, ["-C", dossier, ...a], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString();
    g("init", "-q");
    await ecrire("c.txt", "c\n");
    g("add", "c.txt");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
    await ecrire("i.txt", "i\n");
    g("add", "i.txt");
    await ecrire("n.txt", "n\n");
    const statusAvant = g("status", "--porcelain");
    const avant = await empreinte(join(dossier, ".git"));
    await r.assurerReference();
    await ecrire("n.txt", "n2\n");
    const c = await r.comparer();
    expect(c.fichiers.map((f) => f.chemin).sort()).toEqual(["n.txt"]);
    await r.fichier(c, "n.txt");
    await r.retenir();
    expect(await empreinte(join(dossier, ".git"))).toEqual(avant);
    expect(g("status", "--porcelain")).toBe(statusAvant);
  });
  test("subfolder that is a repo: nothing of its .git read as a file, nothing written inside", async () => {
    const sous = join(dossier, "sous");
    await mkdir(sous);
    execFileSync(GIT, ["-C", sous, "init", "-q"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    await writeFile(join(sous, "f.txt"), "f\n");
    const avecCommit = join(dossier, "avec");
    await mkdir(avecCommit);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
    execFileSync(GIT, ["-C", avecCommit, "init", "-q"], { env });
    await writeFile(join(avecCommit, "h.txt"), "h\n");
    execFileSync(GIT, ["-C", avecCommit, "add", "h.txt"], { env });
    execFileSync(GIT, ["-C", avecCommit, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], { env });
    const avant = [...(await empreinte(join(sous, ".git"))), ...(await empreinte(join(avecCommit, ".git")))];
    await r.assurerReference();
    await writeFile(join(sous, "f.txt"), "g\n");
    const c = await r.comparer();
    expect(c.fichiers.every((f) => !f.chemin.includes(".git/") && f.chemin !== "sous")).toBe(true);
    await r.retenir();
    expect([...(await empreinte(join(sous, ".git"))), ...(await empreinte(join(avecCommit, ".git")))]).toEqual(avant);
  });
});

describe("erreurs", () => {
  test("git absent : GIT_NECESSAIRE", async () => {
    const sans = new ReviewStore({ depot, dossier, git: "/chemin/absent" });
    await expect(sans.assurerReference()).rejects.toMatchObject({ raison: GIT_REQUIRED });
    await expect(sans.assurerReference()).rejects.toBeInstanceOf(ReviewError);
  });
  test("git whose --version fails: GIT_NECESSAIRE", async () => {
    const faux = join(racine, "faux-git");
    await writeFile(faux, "#!/bin/sh\necho 'xcrun: error' >&2\nexit 1\n", { mode: 0o755 });
    await expect(new ReviewStore({ depot, dossier, git: faux }).assurerReference()).rejects.toMatchObject({ raison: GIT_REQUIRED });
  });
  test("WEBAIOS_GIT=/chemin/absent : GIT_NECESSAIRE", async () => {
    const avant = process.env.WEBAIOS_GIT;
    process.env.WEBAIOS_GIT = "/chemin/absent";
    try {
      await expect(new ReviewStore({ depot, dossier }).assurerReference()).rejects.toMatchObject({ raison: GIT_REQUIRED });
    } finally {
      if (avant === undefined) delete process.env.WEBAIOS_GIT; else process.env.WEBAIOS_GIT = avant;
    }
  });
  test.skipIf(process.getuid?.() === 0)("sous-dossier chmod 000 : ACCES_REFUSE", async () => {
    await ecrire("a.txt", "a");
    await mkdir(join(dossier, "sub"));
    await writeFile(join(dossier, "sub", "x.txt"), "x");
    await chmod(join(dossier, "sub"), 0o000);
    try {
      await expect(r.assurerReference()).rejects.toMatchObject({ raison: ACCESS_DENIED });
    } finally {
      await chmod(join(dossier, "sub"), 0o755);
    }
  });
  test.skipIf(process.getuid?.() === 0)("dossier chmod 000 : ACCES_REFUSE", async () => {
    await ecrire("a.txt", "a");
    await chmod(dossier, 0o000);
    await expect(r.assurerReference()).rejects.toMatchObject({ raison: ACCESS_DENIED });
  });
});
