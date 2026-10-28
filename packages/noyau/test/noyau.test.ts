import { afterEach, expect, test, vi } from "vitest";
import { Atelier } from "../src/conteneur/atelier.js";
import { cheminsEspace } from "../src/chemins.js";
import { existsSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { creerNoyau, ErreurAtelier, type Noyau } from "../src/noyau.js";
import type { IaLocale } from "../src/ia/ia-locale.js";
import { PlanificateurWidgets } from "../src/widgets/planificateur.js";
import { lireAccords } from "../src/widgets/accords.js";
import { lireEtatWidget } from "../src/accueil/donnees.js";
import { declarationWidget, ecrireWidget } from "./aide/accueil.js";
import { PontFactice } from "../src/mcp/pont-factice.js";
import { dossierTemporaire } from "./aide/temporaire.js";
import { executeurFactice } from "./aide/executeur-factice.js";

let noyau: Noyau | undefined;
afterEach(async () => {
  await noyau?.arreter();
  noyau = undefined;
});

async function creerSansDocker() {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  return noyau;
}

const lireMcp = async (n: Noyau) => JSON.parse(await readFile(n.chemins.configMcp, "utf8")).mcpServers.webaios;

test("creerNoyau initialise l'espace et écrit mcp.json avec host.docker.internal", async () => {
  const n = await creerSansDocker();
  expect(existsSync(join(n.chemins.racine, "AGENTS.md"))).toBe(true);
  const mcp = await lireMcp(n);
  expect(mcp.url).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
  expect(mcp.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
});

test("Docker absent : creerNoyau réussit, etatAtelier → docker-absent, ouvrirSessionAgent lève ErreurAtelier", async () => {
  const n = await creerSansDocker();
  expect(await n.etatAtelier()).toBe("docker-absent");
  const erreur = await n.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(erreur).toBeInstanceOf(ErreurAtelier);
  expect(erreur.etat).toBe("docker-absent");
});

test("le serveur MCP répond avec le jeton, puis arreter le ferme", async () => {
  const n = await creerSansDocker();
  const mcp = await lireMcp(n);
  const local = mcp.url.replace("host.docker.internal", "127.0.0.1");
  expect((await fetch(local, { method: "POST" })).status).toBe(401);
  await n.arreter();
  noyau = undefined;
  await expect(fetch(local, { method: "POST" })).rejects.toThrow();
});

test("profil inconnu → erreur claire", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  await expect(
    creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, profilId: "inconnu" }),
  ).rejects.toThrow(/inconnu/);
});

test("creerNoyau n'attend pas une construction d'image lente", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 1 }],
    [/ build /, () => new Promise(() => {})], // ne se termine jamais
  ]);
  const debut = Date.now();
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  expect(Date.now() - debut).toBeLessThan(2000);
});

test("échec de démarrage du conteneur : creerNoyau réussit, la session lève ErreurAtelier avec le message", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 0 }],
    [/ run /, { code: 125, stderr: "Bind for 127.0.0.1:5280 failed: port is already allocated" }],
  ]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  const erreur = await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(erreur).toBeInstanceOf(ErreurAtelier);
  expect(erreur.message).toContain("port is already allocated");
});

test("construction échouée au lancement : la première session rend cet échec sans reconstruire aussitôt", async () => {
  const racine = await dossierTemporaire();
  const { executer, appels } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 1 }],
    [/ inspect -f/, { code: 1 }],
    [/ build /, { code: 1, stderr: "réseau coupé" }],
  ]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  const erreur = await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(erreur.message).toContain("réseau coupé");
  expect(appels.filter((a) => a.args[0] === "build")).toHaveLength(1);
  // Réessayer : une nouvelle tentative.
  await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch(() => {});
  expect(appels.filter((a) => a.args[0] === "build")).toHaveLength(2);
});

test("au lancement, une fois le conteneur prêt, les agents d'une app précédente sont arrêtés avant toute session", async () => {
  const racine = await dossierTemporaire();
  const { executer, appels } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  // Conteneur à jour : la sonde de montage renvoie la racine et l'empreinte attendues.
  const { empreinteDockerfile } = await import("../src/conteneur/atelier.js");
  const executerAJour: typeof executer = (c, args, o) =>
    args.includes("{{.State.Running}}") ? executer(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${racine}|${empreinteDockerfile()}\n`, stderr: "" }) : executer(c, args, o);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer: executerAJour });
  await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).then((s) => s.arreter(), () => {});
  const execs = appels.filter((a) => a.args[0] === "exec").map((a) => a.args.join(" "));
  // Le nettoyage (toutes les sessions marquées) passe avant l'arrêt de la session ouverte ici.
  expect(execs[0]).toContain("/tmp/webaios-session-*.pid");
  expect(execs[1]).toMatch(/webaios-session-[0-9a-f]+\.pid/);
});

test("creerNoyau lit modèles et Dockerfile depuis ressources", async () => {
  const racine = await dossierTemporaire();
  const copie = await dossierTemporaire();
  await cp(join(import.meta.dirname, "..", "modeles"), join(copie, "modeles"), { recursive: true });
  await cp(join(import.meta.dirname, "..", "docker"), join(copie, "docker"), { recursive: true });
  await writeFile(join(copie, "modeles", "AGENTS.md"), "# copie");
  const { executer } = executeurFactice([[/ info$/, { code: 1, stderr: "absent" }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, ressources: copie, executer });
  expect(await readFile(join(racine, "AGENTS.md"), "utf8")).toBe("# copie");
});

test("creerNoyau réutilise l'atelier fourni", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1, stderr: "absent" }]]);
  const atelier = new Atelier({ chemins: cheminsEspace(racine), executer });
  const etat = vi.spyOn(atelier, "etat").mockResolvedValue("docker-absent");
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, atelier });
  await noyau.etatAtelier();
  expect(etat).toHaveBeenCalled();
});

test("arreter : nouvelle conversation pour la politique (les cartes en attente tombent) et outils de développement libérés", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  const liberes: number[] = [];
  let n = 0;
  const pont = new PontFactice([], { actif: null, autoriser: false, outilsDev: true });
  const outils = pont.outilsDev!;
  (outils as { proprietaire?: () => unknown }).proprietaire = () => {
    const numero = ++n;
    return Object.assign(Object.create(outils), { liberer: () => liberes.push(numero) });
  };
  const premier = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont, racine, executer });
  const conversation = premier.politique.conversation;
  await premier.arreter();
  expect(premier.politique.conversation).toBe(conversation + 1);
  expect(liberes).toEqual([1]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont, racine, executer });
  expect(n).toBe(2);
});

test("noyau : arreter() arrête le planificateur et l'IA locale", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  const ordre: string[] = [];
  const original = PlanificateurWidgets.prototype.arreter;
  const planif = vi.spyOn(PlanificateurWidgets.prototype, "arreter").mockImplementation(async function (this: PlanificateurWidgets) {
    await original.call(this);
    ordre.push("planificateur");
  });
  const ia = { arreter: vi.fn(async () => void ordre.push("ia")) } as unknown as IaLocale;
  const n = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, ia });
  expect(n.ia).toBe(ia);
  await n.arreter();
  expect(ordre).toEqual(["planificateur", "ia"]);
  planif.mockRestore();
});

test("noyau : lireAccueil lit les widgets ; ia vaut null sans IA locale", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  await ecrireWidget(noyau.chemins, "meteo", declarationWidget());
  const etat = await noyau.lireAccueil();
  expect(etat.widgets.map((w) => w.id)).toContain("meteo");
  expect(noyau.ia).toBeNull();
});

test("noyau : accorder enregistre l'accord (domaines triés), prévient et lance une récolte ; refuserAccord le retire", async () => {
  const racine = await dossierTemporaire();
  const dossierWidgets = `${racine}-widgets`;
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  const surChange = vi.fn();
  noyau = await creerNoyau({ dossierWidgets, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, surChange });
  await ecrireWidget(
    noyau.chemins,
    "daily",
    declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: ["b.dev", "a.dev"], publiques: ["z.com", "y.com"] } }),
    { "recolte.mjs": "export default () => 1" },
  );
  await noyau.accorder("daily", "perso");
  expect((await lireAccords(dossierWidgets)).daily).toEqual({ domaines: ["a.dev", "b.dev"], publiques: ["y.com", "z.com"], profil: "perso" });
  expect(surChange).toHaveBeenCalled();
  // Docker absent : la récolte lancée aboutit à « atelier arrêté ».
  await vi.waitFor(async () => expect((await lireEtatWidget(dossierWidgets, "daily")).statut).toBe("atelier-arrete"));

  surChange.mockClear();
  await noyau.refuserAccord("daily");
  expect((await lireAccords(dossierWidgets)).daily).toBeUndefined();
  expect((await lireEtatWidget(dossierWidgets, "daily")).statut).toBe("accord-requis");
  expect(surChange).toHaveBeenCalled();
});

test("noyau : accorder refuse un widget sans compte", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  await ecrireWidget(noyau.chemins, "meteo", declarationWidget());
  await expect(noyau.accorder("meteo", "perso")).rejects.toThrow(/compte/);
});
