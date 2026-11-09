import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  SPACE_FOLDER, FOLDER_NOT_FOUND, FOLDER_NOT_ABSOLUTE, FOLDER_TOO_LARGE, ExternalRegistry, portRefuse,
} from "../../src/design/externes.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const PLAGES: [number, number][] = [[5280, 5299], [15280, 15284]];

async function cadre() {
  const base = await dossierTemporaire();
  const prive = join(base, "design");
  const maison = join(base, "maison");
  const racineEspace = join(base, "WebAiOs");
  await mkdir(maison, { recursive: true });
  await mkdir(racineEspace, { recursive: true });
  const options = { plages: PLAGES, racineEspace, maison };
  const projet = async (nom: string) => { const d = join(maison, nom); await mkdir(d, { recursive: true }); return d; };
  return { base, prive, maison, racineEspace, options, projet };
}

describe("RegistreExternes", () => {
  test("brancher creates a client of which only the sha256 of the token is written; clientDuJeton returns it", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client, jeton } = await r.brancher("Mon Claude");
    expect(client.nom).toBe("Mon Claude");
    expect(client.empreinte).toBe(createHash("sha256").update(jeton).digest("hex"));
    expect(r.clientDuJeton(jeton)?.id).toBe(client.id);
    expect(r.clientDuJeton("autre")).toBeNull();
    expect(r.clientDuJeton("")).toBeNull();
    const brut = await readFile(join(c.prive, "clients-externes.json"), "utf8");
    expect(brut).not.toContain(jeton);
    expect(brut).toContain(client.empreinte);
    expect((await r.brancher("  ")).client.nom).toBe("Claude Code");
    const relu = await ExternalRegistry.ouvrir(c.prive);
    expect(relu.clientDuJeton(jeton)?.id).toBe(client.id);
  });

  test("the files have mode 0600, their folder 0700", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    await r.declarer(client.id, { dossier: await c.projet("p"), ports: [4321] }, c.options);
    expect((await stat(join(c.prive, "clients-externes.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(c.prive, "projets-externes.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(c.prive)).mode & 0o777).toBe(0o700);
  });

  test("revoquer: the token no longer works, the projects stay with client null", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client, jeton } = await r.brancher("x");
    const { projet } = await r.declarer(client.id, { dossier: await c.projet("p"), ports: [4321] }, c.options);
    await r.revoquer(client.id);
    expect(r.clientDuJeton(jeton)).toBeNull();
    expect(r.clients()).toEqual([]);
    expect(r.projets().find((p) => p.id === projet.id)?.client).toBeNull();
  });

  test("declarer refuses invalid folders with the exact messages", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    const refus = (dossier: string) => r.declarer(client.id, { dossier, ports: [4321] }, c.options);
    await expect(refus("relatif")).rejects.toThrow(FOLDER_NOT_ABSOLUTE);
    await expect(refus(join(c.maison, "absent"))).rejects.toThrow(FOLDER_NOT_FOUND);
    const fichier = join(c.maison, "f.txt");
    await writeFile(fichier, "x");
    await expect(refus(fichier)).rejects.toThrow(FOLDER_NOT_FOUND);
    await expect(refus("/")).rejects.toThrow(FOLDER_TOO_LARGE);
    await expect(refus(c.maison)).rejects.toThrow(FOLDER_TOO_LARGE);
    await expect(refus(c.racineEspace)).rejects.toThrow(SPACE_FOLDER);
    const sous = join(c.racineEspace, "projets", "x");
    await mkdir(sous, { recursive: true });
    await expect(refus(sous)).rejects.toThrow(SPACE_FOLDER);
    const pointpoint = join(c.racineEspace, "..x", "p");
    await mkdir(pointpoint, { recursive: true });
    await expect(refus(pointpoint)).rejects.toThrow(SPACE_FOLDER);
    expect(FOLDER_NOT_ABSOLUTE).toBe("Le dossier doit être un chemin absolu.");
    expect(SPACE_FOLDER).toBe("Ce dossier est dans l'espace de WebAiOs : ses applis se relisent depuis la page Applications.");
    expect(r.projets()).toEqual([]);
  });

  test("declarer refuses out-of-range, non-integer or container ports; accepts 4321", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    const dossier = await c.projet("p");
    for (const p of [80, 70000, 1.5, 5285, 15281]) {
      await expect(r.declarer(client.id, { dossier, ports: [4321, p] }, c.options)).rejects.toThrow(portRefuse(p));
    }
    await expect(r.declarer(client.id, { dossier, ports: [] }, c.options)).rejects.toThrow();
    await expect(r.declarer(client.id, { dossier, ports: Array.from({ length: 11 }, (_, i) => 4000 + i) }, c.options)).rejects.toThrow();
    const { projet } = await r.declarer(client.id, { dossier, ports: [4321] }, c.options);
    expect(projet.ports).toEqual([4321]);
  });

  test("declaring the same folder twice (including through a symbolic link): a single project updated", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const a = (await r.brancher("a")).client;
    const b = (await r.brancher("b")).client;
    const dossier = await c.projet("p");
    const lien = join(c.maison, "lien");
    await symlink(dossier, lien);
    const un = await r.declarer(a.id, { dossier, ports: [4321] }, c.options);
    const deux = await r.declarer(b.id, { dossier: lien, ports: [4322], nom: "Beau" }, c.options);
    expect(un.premiere).toBe(true);
    expect(deux.premiere).toBe(false);
    expect(r.projets()).toHaveLength(1);
    expect(deux.projet).toMatchObject({ id: un.projet.id, ports: [4322], client: b.id, nom: "Beau", dossier });
    expect(un.projet.nom).toBe("p");
    const trois = await r.declarer(b.id, { dossier, ports: [4322] }, c.options);
    expect(trois.projet.nom).toBe("Beau");
  });

  test("a reclaimed port is removed from the other project", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    const pa = await r.declarer(client.id, { dossier: await c.projet("a"), ports: [4321, 4400] }, c.options);
    await r.declarer(client.id, { dossier: await c.projet("b"), ports: [4321] }, c.options);
    expect(r.projets().find((p) => p.id === pa.projet.id)?.ports).toEqual([4400]);
  });

  test("projetDe: only for the project's client, folder with trailing / accepted", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const a = (await r.brancher("a")).client;
    const b = (await r.brancher("b")).client;
    const dossier = await c.projet("p");
    const { projet } = await r.declarer(a.id, { dossier, ports: [4321] }, c.options);
    expect(await r.projetDe(b.id, dossier)).toBeNull();
    expect((await r.projetDe(a.id, `${dossier}/`))?.id).toBe(projet.id);
    expect(await r.projetDe(a.id, join(c.maison, "absent"))).toBeNull();
  });

  test.skipIf(process.getuid?.() === 0)("folder chmod 000: declarer succeeds with lisible false", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    const dossier = await c.projet("ferme");
    expect((await r.declarer(client.id, { dossier: await c.projet("ouvert"), ports: [4400] }, c.options)).lisible).toBe(true);
    await chmod(dossier, 0o000);
    try {
      const res = await r.declarer(client.id, { dossier, ports: [4321] }, c.options);
      expect(res.lisible).toBe(false);
    } finally { await chmod(dossier, 0o700); }
  });

  test("a clients-externes.json under racineEspace/.webaios is never read", async () => {
    const c = await cadre();
    const jeton = "jeton-pose-par-l-agent";
    await mkdir(join(c.racineEspace, ".webaios"), { recursive: true });
    await writeFile(join(c.racineEspace, ".webaios", "clients-externes.json"), JSON.stringify([
      { id: "pirate", nom: "p", empreinte: createHash("sha256").update(jeton).digest("hex"), cree: "2026-11-02T10:00:00Z" },
    ]));
    const r = await ExternalRegistry.ouvrir(c.prive);
    expect(r.clients()).toEqual([]);
    expect(r.clientDuJeton(jeton)).toBeNull();
  });

  test("an unreadable file is copied to .abime-<date> and the registry starts empty again", async () => {
    const c = await cadre();
    await mkdir(c.prive, { recursive: true });
    await writeFile(join(c.prive, "projets-externes.json"), "{pas du json");
    const r = await ExternalRegistry.ouvrir(c.prive);
    expect(r.projets()).toEqual([]);
    expect((await readdir(c.prive)).some((f) => f.startsWith("projets-externes.json.abime-"))).toBe(true);
  });

  test("oublier removes the project; surChange is called after each write", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    let n = 0;
    const arret = r.surChange(() => { n++; });
    const { client } = await r.brancher("x");
    const { projet } = await r.declarer(client.id, { dossier: await c.projet("p"), ports: [4321] }, c.options);
    await r.oublier(projet.id);
    expect(r.projets()).toEqual([]);
    expect(n).toBe(3);
    arret();
    await r.revoquer(client.id);
    expect(n).toBe(3);
  });

  test("revoquer: if the write fails, the call is rejected and the client stays consistent with the disk", async () => {
    const c = await cadre();
    const r = await ExternalRegistry.ouvrir(c.prive);
    const { client, jeton } = await r.brancher("x");
    const fichier = join(c.prive, "clients-externes.json");
    const contenu = await readFile(fichier, "utf8");
    await rm(fichier);
    await mkdir(join(fichier, "bloque"), { recursive: true }); // the file's rename on this folder fails
    await expect(r.revoquer(client.id)).rejects.toThrow();
    expect(r.clientDuJeton(jeton)?.id).toBe(client.id);
    await rm(fichier, { recursive: true });
    await writeFile(fichier, contenu);
    expect((await ExternalRegistry.ouvrir(c.prive)).clientDuJeton(jeton)?.id).toBe(client.id);
  });
});
