import { afterEach, expect, test, vi } from "vitest";
import { Atelier } from "../src/conteneur/atelier.js";
import type { Executeur } from "../src/conteneur/executeur.js";
import { cheminsEspace } from "../src/chemins.js";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { creerNoyau, ErreurAtelier, type Noyau } from "../src/noyau.js";
import type { IaLocale } from "../src/ia/ia-locale.js";
import { PlanificateurWidgets } from "../src/widgets/planificateur.js";
import { accorder as accorderAccord, lireAccords } from "../src/widgets/accords.js";
import { ecrireExecution, idExecution, type Execution } from "../src/workflows/executions.js";
import { ecrireResultat } from "../src/actions/donnees.js";
import { ecrireDonnees, lireDonnees, lireEtatWidget } from "../src/accueil/donnees.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  return noyau;
}

const lireMcp = async (n: Noyau) => JSON.parse(await readFile(n.chemins.configMcp, "utf8")).mcpServers.webaios;

/** Atelier dont le « docker » est un faux script (il ne dort que pour un `exec -it`, une session ; tout autre appel échoue vite) : un pty de session ne touche jamais le vrai Docker. */
async function atelierSansDocker(racine: string, executer: Executeur): Promise<Atelier> {
  const faux = join(`${racine}-bin`, "docker");
  await mkdir(dirname(faux), { recursive: true });
  await writeFile(faux, '#!/bin/sh\ncase " $* " in *" -it "*) exec sleep 60;; *) exit 1;; esac\n', { mode: 0o755 });
  return new Atelier({ chemins: cheminsEspace(racine), executer, docker: faux });
}

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
    creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, profilId: "inconnu" }),
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
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
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
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
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
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
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
  const atelier = await atelierSansDocker(racine, executerAJour);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer: executerAJour, atelier });
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
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, ressources: copie, executer });
  expect(await readFile(join(racine, "AGENTS.md"), "utf8")).toBe("# copie");
});

test("creerNoyau réutilise l'atelier fourni", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1, stderr: "absent" }]]);
  const atelier = new Atelier({ chemins: cheminsEspace(racine), executer });
  const etat = vi.spyOn(atelier, "etat").mockResolvedValue("docker-absent");
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, atelier });
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
  const premier = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont, racine, executer });
  const conversation = premier.politique.conversation;
  await premier.arreter();
  expect(premier.politique.conversation).toBe(conversation + 1);
  expect(liberes).toEqual([1]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont, racine, executer });
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
  // Le noyau ferme son propre accès à l'IA (une récolte en retard ne relance pas Kev), pas l'IA partagée.
  const acces = { kev: vi.fn(), gemma: vi.fn(), fermer: vi.fn(async () => void ordre.push("ia")) };
  const ia = { acces: () => acces, arreter: vi.fn() } as unknown as IaLocale;
  const n = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, ia });
  expect(n.ia).toBe(ia);
  await n.arreter();
  expect(ordre).toEqual(["planificateur", "ia"]);
  expect(ia.arreter).not.toHaveBeenCalled();
  planif.mockRestore();
});

test("noyau : lireAccueil lit les widgets ; ia vaut null sans IA locale", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
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
  noyau = await creerNoyau({ dossierWidgets, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, surChange });
  await ecrireWidget(
    noyau.chemins,
    "daily",
    declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: ["b.dev", "a.dev"], publiques: ["z.com", "y.com"] } }),
    { "recolte.mjs": "export default () => 1" },
  );
  await noyau.accorder({ id: "daily", profil: "perso", compte: ["a.dev", "b.dev"], publiques: ["z.com", "y.com"] });
  expect((await lireAccords(dossierWidgets)).daily).toEqual({ domaines: ["a.dev", "b.dev"], publiques: ["y.com", "z.com"], profil: "perso" });
  expect(surChange).toHaveBeenCalled();
  // Docker absent : la récolte lancée aboutit à « atelier arrêté ».
  await vi.waitFor(async () => expect((await lireEtatWidget(dossierWidgets, "daily")).statut).toBe("atelier-arrete"));
  // Messages écrits par le noyau : marqués comme tels (ils peuvent sortir vers l'agent sans accord).
  expect((await lireEtatWidget(dossierWidgets, "daily")).erreurNoyau).toBe(true);

  surChange.mockClear();
  await noyau.refuserAccord("daily");
  expect((await lireAccords(dossierWidgets)).daily).toBeUndefined();
  expect(await lireEtatWidget(dossierWidgets, "daily")).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
  expect(surChange).toHaveBeenCalled();
});

test("noyau : accorder refuse un widget sans compte", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  await ecrireWidget(noyau.chemins, "meteo", declarationWidget());
  await expect(noyau.accorder({ id: "meteo", profil: "perso", compte: [], publiques: [] })).rejects.toThrow(/compte/);
});

test("noyau : accorder refuse si la déclaration n'est plus celle montrée à l'utilisateur (compte ou publiques)", async () => {
  const racine = await dossierTemporaire();
  const dossierWidgets = `${racine}-widgets`;
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  noyau = await creerNoyau({ dossierWidgets, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  await ecrireWidget(
    noyau.chemins,
    "daily",
    declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: ["app.daily.dev"], publiques: ["espion.example"] } }),
    { "recolte.mjs": "export default () => 1" },
  );
  // Montré sans le domaine public (ancienne déclaration) : refusé.
  await expect(noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: [] })).rejects.toThrow(/a changé/);
  await expect(noyau.accorder({ id: "daily", profil: "perso", compte: ["autre.dev"], publiques: ["espion.example"] })).rejects.toThrow(/a changé/);
  await expect(noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev", "app.daily.dev"], publiques: ["espion.example"] })).rejects.toThrow(/a changé/);
  expect(await lireAccords(dossierWidgets)).toEqual({});
  // Exactement ce qui est déclaré : accordé.
  await noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: ["espion.example"] });
  expect((await lireAccords(dossierWidgets)).daily).toEqual({ domaines: ["app.daily.dev"], publiques: ["espion.example"], profil: "perso" });
});

test("noyau : refuserAccord efface les données ; compte retiré ensuite → donnees_widget ne rend rien du compte", async () => {
  const racine = await dossierTemporaire();
  const dossierWidgets = `${racine}-widgets`;
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  noyau = await creerNoyau({ dossierWidgets, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  const decl = (compte: string[]) => declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte, publiques: [] } });
  await ecrireWidget(noyau.chemins, "daily", decl(["app.daily.dev"]), { "recolte.mjs": "export default () => 1" });
  await noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: [] });
  await ecrireDonnees(dossierWidgets, "daily", { secret: "du compte" });
  await noyau.refuserAccord("daily");
  expect(await lireDonnees(dossierWidgets, "daily")).toBeNull();
  // L'agent retire compte : le widget redevient public, sans rien du compte.
  await ecrireWidget(noyau.chemins, "daily", decl([]), { "recolte.mjs": "export default () => 1" });
  const mcp = await lireMcp(noyau);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url.replace("host.docker.internal", "127.0.0.1")), {
      requestInit: { headers: { Authorization: mcp.headers.Authorization } },
    }),
  );
  const r = await client.callTool({ name: "donnees_widget", arguments: { id: "daily" } });
  await client.close();
  const t = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
  expect(t).not.toContain("du compte");
  expect(t).toContain("Aucune donnée");
});

test("noyau : rejouer passe par la file du planificateur ; surDirect suit la file et se désabonne", async () => {
  const n = await creerSansDocker();
  await ecrireWidget(n.chemins, "meteo", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
  const vus: unknown[] = [];
  const desabonner = n.surDirect((e) => vus.push(e));
  expect(await n.rejouer("meteo", "2026-10-28T09-00-00-000Z", "recolte")).toEqual({ ok: false, erreur: "Mise à jour impossible : atelier arrêté" });
  expect(vus).toContainEqual({ courants: [], enAttente: ["meteo"] });
  expect(vus.at(-1)).toEqual({ courants: [], enAttente: [] });
  expect(n.direct()).toEqual({ courants: [], enAttente: [] });
  desabonner();
  const avant = vus.length;
  await n.rejouer("meteo", "2026-10-28T09-00-00-000Z", "recolte");
  expect(vus).toHaveLength(avant);
});

// Docker « prêt » (exécuteur factice) ; le pty de la session lance un faux binaire qui dort, jamais le vrai Docker.
async function creerPret() {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  const { empreinteDockerfile } = await import("../src/conteneur/atelier.js");
  const executerAJour: typeof executer = (c, args, o) =>
    args.includes("{{.State.Running}}") ? executer(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${racine}|${empreinteDockerfile()}\n`, stderr: "" }) : executer(c, args, o);
  const atelier = await atelierSansDocker(racine, executerAJour);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer: executerAJour, atelier });
  return noyau;
}

test("une session ouverte pour une fenêtre écrit sa propre config MCP, supprimée à la fin de la session", async () => {
  const n = await creerPret();
  const dossier = join(n.chemins.interne, "sessions");
  const session = await n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" });
  const fichiers = await readdir(dossier);
  expect(fichiers).toHaveLength(1);
  const propre = JSON.parse(await readFile(join(dossier, fichiers[0]!), "utf8")).mcpServers.webaios;
  const principal = await lireMcp(n);
  expect(propre.url).toBe(principal.url);
  expect(propre.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
  expect(propre.headers.Authorization).not.toBe(principal.headers.Authorization);
  expect((await (await import("node:fs/promises")).stat(join(dossier, fichiers[0]!))).mode & 0o777).toBe(0o600);
  await session.arreter();
  await vi.waitFor(async () => expect(await readdir(dossier)).toEqual([]));
});

test("au démarrage du noyau, les configs de session laissées par un plantage sont purgées", async () => {
  const racine = await dossierTemporaire();
  const dossier = join(cheminsEspace(racine).interne, "sessions");
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, "reste.json"), "{}");
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions: `${racine}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  expect(existsSync(join(dossier, "reste.json"))).toBe(false);
});

test("arreter supprime la config d'une session encore ouverte", async () => {
  const n = await creerPret();
  const dossier = join(n.chemins.interne, "sessions");
  const session = await n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" });
  const [fichier] = await readdir(dossier);
  expect(existsSync(join(dossier, fichier!))).toBe(true);
  const arret = n.arreter();
  noyau = undefined;
  await arret;
  expect(existsSync(join(dossier, fichier!))).toBe(false);
  await session.arreter();
});

test("une session dont le dossier est un lien symbolique est refusée, rien n'est écrit ailleurs", async () => {
  const n = await creerPret();
  const cible = await dossierTemporaire();
  const dossier = join(n.chemins.interne, "sessions");
  await mkdir(n.chemins.interne, { recursive: true });
  await symlink(cible, dossier);
  await expect(n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" })).rejects.toThrow(/Dossier des sessions invalide/);
  expect(await readdir(cible)).toEqual([]);
  expect((await stat(cible)).isDirectory()).toBe(true);
});

async function creerAvecActions(preparerEspace?: (racine: string, dossierActions: string) => Promise<void>) {
  const racine = await dossierTemporaire();
  const dossierActions = await dossierTemporaire();
  await preparerEspace?.(racine, dossierActions);
  const { executer } = executeurFactice([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  noyau = await creerNoyau({ dossierWidgets: `${racine}-widgets`, dossierActions, pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  return { n: noyau, dossierActions };
}

const executionAction = (id: string, debut: string): Execution => ({
  version: 1, id: idExecution(debut), proprietaire: { type: "action", id }, declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs: [],
});

test("noyau.actions : page(id, null) rend le dernier résultat résolu ; page d'une exécution inconnue : null", async () => {
  const { n, dossierActions } = await creerAvecActions(async (racine) => {
    const dossier = join(cheminsEspace(racine).actions, "gitlab");
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, "action.json"), JSON.stringify({ nom: "GitLab", sources: { compte: ["gitlab.com"] } }));
  });
  const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
  await ecrireExecution(join(dossierActions, "gitlab"), { ...e, saisie: "x" });
  const plan = { blocs: [{ composant: "liste", props: { elements: "tickets", titre: "titre" } }] };
  await ecrireResultat(dossierActions, "gitlab", { version: 1, execution: e.id, saisie: "x", resultats: { tickets: [{ titre: "A" }] }, plan, secours: false, vide: false });
  const p = await n.actions.page("gitlab", null);
  expect(p).toMatchObject({ execution: e.id, debut: e.debut, fin: e.fin, saisie: "x", statut: "reussie", compte: true });
  expect(p!.page).toMatchObject({ secours: false, vide: false });
  expect(p!.page!.blocs[0]).toMatchObject({ composant: "liste" });
  expect(await n.actions.page("gitlab", e.id)).toEqual(p);
  expect(await n.actions.page("gitlab", "2020-01-01T00-00-00-000Z")).toBeNull();
  expect(await n.actions.page("absente", null)).toBeNull();
  expect(await n.actions.page("gitlab", "../x")).toBeNull();
  expect(await n.actions.execution("gitlab", "../x")).toBeNull();
  expect((await n.actions.lister()).map((a) => a.id)).toEqual(["gitlab"]);
  expect((await n.actions.executions("gitlab")).map((x) => x.id)).toEqual([e.id]);
  expect(await n.actions.execution("gitlab", e.id)).toMatchObject({ id: e.id });
  expect(n.actions.direct()).toEqual({ courantes: [], enAttente: [] });
});

test("noyau.actions : au démarrage, les données d'une action disparue sont effacées", async () => {
  const { dossierActions } = await creerAvecActions(async (racine, dossierActions) => {
    await mkdir(cheminsEspace(racine).actions, { recursive: true });
    await ecrireExecution(join(dossierActions, "partie"), executionAction("partie", "2026-10-31T08:00:00.000Z"));
    await accorderAccord(dossierActions, "partie", { domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  });
  expect(existsSync(join(dossierActions, "partie"))).toBe(false);
  expect((await lireAccords(dossierActions)).partie).toBeUndefined();
});

test("noyau.actions : accorder enregistre l'accord sans rien lancer ; refuserAccord le retire et efface", async () => {
  const { n, dossierActions } = await creerAvecActions(async (racine) => {
    const dossier = join(cheminsEspace(racine).actions, "gitlab");
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, "action.json"), JSON.stringify({ nom: "GitLab", sources: { compte: ["gitlab.com"] } }));
  });
  await expect(n.actions.accorder({ id: "gitlab", profil: "perso", compte: ["github.com"], publiques: [] })).rejects.toThrow(/changé/);
  await n.actions.accorder({ id: "gitlab", profil: "perso", compte: ["gitlab.com"], publiques: [] });
  expect((await lireAccords(dossierActions)).gitlab).toEqual({ domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  expect(n.actions.direct().courantes).toEqual([]);
  await ecrireExecution(join(dossierActions, "gitlab"), executionAction("gitlab", "2026-10-31T08:00:00.000Z"));
  await n.actions.refuserAccord("gitlab");
  expect((await lireAccords(dossierActions)).gitlab).toBeUndefined();
  expect(await n.actions.executions("gitlab")).toEqual([]);
});
