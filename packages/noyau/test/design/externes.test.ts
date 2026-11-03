import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DOSSIER_ESPACE, DOSSIER_INTROUVABLE, DOSSIER_NON_ABSOLU, DOSSIER_TROP_LARGE, RegistreExternes, portRefuse,
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
  test("brancher crée un client dont seul le sha256 du jeton est écrit ; clientDuJeton le rend", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
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
    const relu = await RegistreExternes.ouvrir(c.prive);
    expect(relu.clientDuJeton(jeton)?.id).toBe(client.id);
  });

  test("les fichiers ont le mode 0600, leur dossier 0700", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    await r.declarer(client.id, { dossier: await c.projet("p"), ports: [4321] }, c.options);
    expect((await stat(join(c.prive, "clients-externes.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(c.prive, "projets-externes.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(c.prive)).mode & 0o777).toBe(0o700);
  });

  test("revoquer : le jeton ne marche plus, les projets restent avec client null", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
    const { client, jeton } = await r.brancher("x");
    const { projet } = await r.declarer(client.id, { dossier: await c.projet("p"), ports: [4321] }, c.options);
    await r.revoquer(client.id);
    expect(r.clientDuJeton(jeton)).toBeNull();
    expect(r.clients()).toEqual([]);
    expect(r.projets().find((p) => p.id === projet.id)?.client).toBeNull();
  });

  test("declarer refuse les dossiers invalides avec les messages exacts", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    const refus = (dossier: string) => r.declarer(client.id, { dossier, ports: [4321] }, c.options);
    await expect(refus("relatif")).rejects.toThrow(DOSSIER_NON_ABSOLU);
    await expect(refus(join(c.maison, "absent"))).rejects.toThrow(DOSSIER_INTROUVABLE);
    const fichier = join(c.maison, "f.txt");
    await writeFile(fichier, "x");
    await expect(refus(fichier)).rejects.toThrow(DOSSIER_INTROUVABLE);
    await expect(refus("/")).rejects.toThrow(DOSSIER_TROP_LARGE);
    await expect(refus(c.maison)).rejects.toThrow(DOSSIER_TROP_LARGE);
    await expect(refus(c.racineEspace)).rejects.toThrow(DOSSIER_ESPACE);
    const sous = join(c.racineEspace, "projets", "x");
    await mkdir(sous, { recursive: true });
    await expect(refus(sous)).rejects.toThrow(DOSSIER_ESPACE);
    const pointpoint = join(c.racineEspace, "..x", "p");
    await mkdir(pointpoint, { recursive: true });
    await expect(refus(pointpoint)).rejects.toThrow(DOSSIER_ESPACE);
    expect(DOSSIER_NON_ABSOLU).toBe("Le dossier doit être un chemin absolu.");
    expect(DOSSIER_ESPACE).toBe("Ce dossier est dans l'espace de WebAiOs : ses applis se relisent depuis la page Applications.");
    expect(r.projets()).toEqual([]);
  });

  test("declarer refuse les ports hors bornes, non entiers ou du conteneur ; accepte 4321", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
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

  test("déclarer deux fois le même dossier (dont par lien symbolique) : un seul projet mis à jour", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
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

  test("un port repris est retiré de l'autre projet", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    const pa = await r.declarer(client.id, { dossier: await c.projet("a"), ports: [4321, 4400] }, c.options);
    await r.declarer(client.id, { dossier: await c.projet("b"), ports: [4321] }, c.options);
    expect(r.projets().find((p) => p.id === pa.projet.id)?.ports).toEqual([4400]);
  });

  test("projetDe : seulement pour le client du projet, dossier avec / final accepté", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
    const a = (await r.brancher("a")).client;
    const b = (await r.brancher("b")).client;
    const dossier = await c.projet("p");
    const { projet } = await r.declarer(a.id, { dossier, ports: [4321] }, c.options);
    expect(await r.projetDe(b.id, dossier)).toBeNull();
    expect((await r.projetDe(a.id, `${dossier}/`))?.id).toBe(projet.id);
    expect(await r.projetDe(a.id, join(c.maison, "absent"))).toBeNull();
  });

  test.skipIf(process.getuid?.() === 0)("dossier chmod 000 : declarer réussit avec lisible faux", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
    const { client } = await r.brancher("x");
    const dossier = await c.projet("ferme");
    expect((await r.declarer(client.id, { dossier: await c.projet("ouvert"), ports: [4400] }, c.options)).lisible).toBe(true);
    await chmod(dossier, 0o000);
    try {
      const res = await r.declarer(client.id, { dossier, ports: [4321] }, c.options);
      expect(res.lisible).toBe(false);
    } finally { await chmod(dossier, 0o700); }
  });

  test("un clients-externes.json sous racineEspace/.webaios n'est jamais lu", async () => {
    const c = await cadre();
    const jeton = "jeton-pose-par-l-agent";
    await mkdir(join(c.racineEspace, ".webaios"), { recursive: true });
    await writeFile(join(c.racineEspace, ".webaios", "clients-externes.json"), JSON.stringify([
      { id: "pirate", nom: "p", empreinte: createHash("sha256").update(jeton).digest("hex"), cree: "2026-11-02T10:00:00Z" },
    ]));
    const r = await RegistreExternes.ouvrir(c.prive);
    expect(r.clients()).toEqual([]);
    expect(r.clientDuJeton(jeton)).toBeNull();
  });

  test("un fichier illisible est copié en .abime-<date> et le registre repart vide", async () => {
    const c = await cadre();
    await mkdir(c.prive, { recursive: true });
    await writeFile(join(c.prive, "projets-externes.json"), "{pas du json");
    const r = await RegistreExternes.ouvrir(c.prive);
    expect(r.projets()).toEqual([]);
    expect((await readdir(c.prive)).some((f) => f.startsWith("projets-externes.json.abime-"))).toBe(true);
  });

  test("oublier retire le projet ; surChange est appelé après chaque écriture", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
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

  test("revoquer : si l'écriture échoue, l'appel est rejeté et le client reste cohérent avec le disque", async () => {
    const c = await cadre();
    const r = await RegistreExternes.ouvrir(c.prive);
    const { client, jeton } = await r.brancher("x");
    const fichier = join(c.prive, "clients-externes.json");
    const contenu = await readFile(fichier, "utf8");
    await rm(fichier);
    await mkdir(join(fichier, "bloque"), { recursive: true }); // le rename du fichier sur ce dossier échoue
    await expect(r.revoquer(client.id)).rejects.toThrow();
    expect(r.clientDuJeton(jeton)?.id).toBe(client.id);
    await rm(fichier, { recursive: true });
    await writeFile(fichier, contenu);
    expect((await RegistreExternes.ouvrir(c.prive)).clientDuJeton(jeton)?.id).toBe(client.id);
  });
});
