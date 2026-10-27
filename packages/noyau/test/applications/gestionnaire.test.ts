import { afterEach, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { cheminsEspace, type CheminsEspace } from "../../src/chemins.js";
import { Atelier } from "../../src/conteneur/atelier.js";
import { createServer as serveurHttp } from "node:http";
import { createServer as serveurTcp, type AddressInfo, type Server } from "node:net";
import { GestionnaireApplications, sonderParDefaut, type EtatApplication, type Lanceur } from "../../src/applications/gestionnaire.js";
import { executeurFactice, type Reponse } from "../aide/executeur-factice.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const gestionnaires: GestionnaireApplications[] = [];
afterEach(async () => {
  for (const g of gestionnaires.splice(0)) await g.arreterSurveillance();
});

/** Lanceur factice : garde les argv, et chaque processus se termine quand le test appelle `finir`. */
function lanceurFactice() {
  const processus: { argv: string[]; tue: boolean; finir: (code: number | null) => void }[] = [];
  const lanceur: Lanceur = (argv) => {
    const rappels: ((code: number | null) => void)[] = [];
    const p = { argv, tue: false, finir: (code: number | null) => rappels.forEach((r) => r(code)) };
    processus.push(p);
    return {
      surFin: (r) => rappels.push(r),
      tuer: () => {
        p.tue = true;
      },
    };
  };
  return { lanceur, processus };
}

/** Sonde scriptée : chaque port rend ses réponses dans l'ordre, puis répète la dernière (par défaut « libre »). */
function sondeScriptee(script: Record<number, ("http" | "occupe" | "libre")[]>) {
  return async (port: number) => {
    const r = script[port] ?? ["libre"];
    return r.length > 1 ? r.shift()! : r[0]!;
  };
}

async function espace(projets: Record<string, string | null> = { todo: '{"nom":"Todo","type":"application","lancement":"npx vite --port {port}"}' }) {
  const c = cheminsEspace(await dossierTemporaire());
  for (const [dossier, manifeste] of Object.entries(projets)) {
    await mkdir(join(c.projets, dossier), { recursive: true });
    if (manifeste !== null) await writeFile(join(c.projets, dossier, "webaios.json"), manifeste);
  }
  return c;
}

function preparer(o: {
  chemins: CheminsEspace;
  sonder?: (port: number) => Promise<"http" | "occupe" | "libre">;
  ports?: [number, number];
  inspect?: Reponse;
  info?: Reponse;
}) {
  const { executer, appels } = executeurFactice([
    [/ info$/, o.info ?? { code: 0 }],
    [/ inspect /, o.inspect ?? { code: 0, stdout: "true\n" }],
  ]);
  const atelier = new Atelier({ chemins: o.chemins, docker: "docker", executer });
  const { lanceur, processus } = lanceurFactice();
  const etats: EtatApplication[] = [];
  const g: GestionnaireApplications = new GestionnaireApplications({
    chemins: o.chemins,
    atelier,
    lanceur,
    ports: o.ports ?? [5280, 5284],
    delaiPretMs: 200,
    intervalleSondeMs: 20,
    sonder: o.sonder ?? sondeScriptee({ 5280: ["libre", "http"] }),
    surChange: () => etats.push(g.etatDe("todo")),
  });
  gestionnaires.push(g);
  const arrets = () => appels.filter((a) => a.args[0] === "exec" && a.args[4]?.includes("WEBAIOS_APP=")).map((a) => a.args[4]!);
  return { g, atelier, processus, etats, appels, arrets };
}

async function jusqua(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await attendre(5);
  expect(condition()).toBe(true);
}

test("lancer : port libre, en-marche quand le port répond", async () => {
  const c = await espace();
  const { g, processus, etats } = preparer({ chemins: c });
  expect(await g.lancer("todo")).toMatchObject({ dossier: "todo", nom: "Todo", type: "application", etat: "en-marche", port: 5280 });
  expect(etats).toEqual(["lancement", "en-marche"]);
  expect(processus).toHaveLength(1);
  expect(processus[0]!.argv).toContain("-e");
  expect(processus[0]!.argv).toContain("WEBAIOS_APP=todo");
  expect(processus[0]!.argv.at(-1)).toBe("npx vite --port 5280");
  expect(await g.liste()).toMatchObject([{ dossier: "todo", etat: "en-marche", port: 5280 }]);
});

test("un port occupé est sauté", async () => {
  const c = await espace();
  const { g } = preparer({ chemins: c, sonder: sondeScriptee({ 5280: ["occupe"], 5281: ["libre", "http"] }) });
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche", port: 5281 });
});

test("un port qui répond en HTTP (serveur lancé à la main par l'agent) est sauté", async () => {
  const c = await espace();
  const { g } = preparer({ chemins: c, sonder: sondeScriptee({ 5280: ["http"], 5281: ["libre", "http"] }) });
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche", port: 5281 });
});

test("plus de port libre", async () => {
  const c = await espace({
    todo: '{"type":"application","lancement":"x"}',
    autre: '{"type":"application","lancement":"y"}',
  });
  const { g } = preparer({ chemins: c, ports: [5280, 5280], sonder: sondeScriptee({ 5280: ["libre", "http"] }) });
  expect(await g.lancer("autre")).toMatchObject({ etat: "en-marche", port: 5280 });
  expect(await g.lancer("todo")).toMatchObject({ etat: "erreur", erreur: "Plus de port libre : arrête une application." });
});

test("le processus sort tout de suite : erreur sans attendre le délai", async () => {
  const c = await espace();
  const { g, processus } = preparer({ chemins: c, sonder: sondeScriptee({}) });
  const resultat = g.lancer("todo");
  await jusqua(() => processus.length === 1);
  await mkdir(c.journaux, { recursive: true });
  await writeFile(join(c.journaux, "todo.log"), "démarrage\nboum\n");
  const debut = Date.now();
  processus[0]!.finir(3);
  const app = await resultat;
  expect(Date.now() - debut).toBeLessThan(50);
  expect(app.etat).toBe("erreur");
  expect(app.erreur).toContain("Arrêtée avec le code 3");
  expect(app.erreur).toContain("boum");
});

test("le port ne répond jamais : erreur après delaiPretMs, processus arrêté", async () => {
  const c = await espace();
  const { g, processus, arrets } = preparer({ chemins: c, sonder: sondeScriptee({}) });
  const debut = Date.now();
  const app = await g.lancer("todo");
  expect(Date.now() - debut).toBeGreaterThanOrEqual(190);
  expect(app.etat).toBe("erreur");
  expect(app.erreur).toContain("5280");
  expect(processus[0]!.tue).toBe(true);
  expect(arrets()).toHaveLength(1);
  expect(arrets()[0]).toContain("WEBAIOS_APP=todo");
  // La fin du processus tué ne remplace pas l'erreur.
  processus[0]!.finir(null);
  expect((await g.liste())[0]).toMatchObject({ etat: "erreur", erreur: app.erreur });
});

test("arreter pendant le lancement : arretee, pas erreur", async () => {
  const c = await espace();
  const { g, processus, arrets } = preparer({ chemins: c, sonder: sondeScriptee({}) });
  const resultat = g.lancer("todo");
  await jusqua(() => processus.length === 1);
  await g.arreter("todo");
  processus[0]!.finir(143);
  expect(await resultat).toMatchObject({ etat: "arretee" });
  expect(processus[0]!.tue).toBe(true);
  expect(arrets()).toHaveLength(1);
  expect((await g.liste())[0]).toMatchObject({ etat: "arretee" });
  expect((await g.liste())[0]!.erreur).toBeUndefined();
});

test("arreter pendant qu'un second lancement attend dans la file : il est annulé aussi", async () => {
  const c = await espace();
  const { g, processus } = preparer({ chemins: c, sonder: sondeScriptee({}) });
  const premier = g.lancer("todo");
  await jusqua(() => processus.length === 1);
  const second = g.lancer("todo");
  await g.arreter("todo");
  expect(await premier).toMatchObject({ etat: "arretee" });
  expect(await second).toMatchObject({ etat: "arretee" });
  expect(processus).toHaveLength(1);
  expect(g.etatDe("todo")).toBe("arretee");
});

test("arreter avant que le lancement ait commencé (lecture des projets) : arretee, rien de lancé", async () => {
  const c = await espace();
  const { g, processus } = preparer({ chemins: c });
  const resultat = g.lancer("todo");
  await g.arreter("todo");
  expect(await resultat).toMatchObject({ etat: "arretee" });
  expect(processus).toHaveLength(0);
});

test("un lancement demandé après un arrêt n'est pas annulé par lui", async () => {
  const c = await espace();
  const { g } = preparer({ chemins: c });
  await g.arreter("todo");
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche" });
});

/** Promesse résolue par le test. */
function differe() {
  let resoudre!: () => void;
  const promesse = new Promise<void>((r) => (resoudre = r));
  return { promesse, resoudre };
}

test("un lancement juste après un arrêt attend la fin du script d'arrêt (qui le tuerait)", async () => {
  const c = await espace();
  const { g, atelier, processus } = preparer({ chemins: c, sonder: sondeScriptee({ 5280: ["libre", "http", "libre", "http"] }) });
  await g.lancer("todo");
  const script = differe();
  vi.spyOn(atelier, "arreterApplication").mockReturnValue(script.promesse);
  const arret = g.arreter("todo");
  const relance = g.lancer("todo");
  await attendre(50);
  expect(processus).toHaveLength(1);
  script.resoudre();
  await arret;
  expect(await relance).toMatchObject({ etat: "en-marche" });
  expect(processus).toHaveLength(2);
});

test("un lancement pendant le ménage des orphelins attend sa fin", async () => {
  const c = await espace();
  const { g, atelier, processus } = preparer({ chemins: c });
  const menage = differe();
  vi.spyOn(atelier, "arreterApplicationsOrphelines").mockReturnValue(menage.promesse);
  const demarrage = g.demarrer();
  const lancement = g.lancer("todo");
  await attendre(50);
  expect(processus).toHaveLength(0);
  menage.resoudre();
  await demarrage;
  expect(await lancement).toMatchObject({ etat: "en-marche" });
  expect(processus).toHaveLength(1);
});

test("la surveillance des projets n'attend pas le ménage des orphelins (Docker qui démarre)", async () => {
  const c = await espace();
  const { g, atelier, etats } = preparer({ chemins: c });
  const menage = differe();
  vi.spyOn(atelier, "arreterApplicationsOrphelines").mockReturnValue(menage.promesse);
  const demarrage = g.demarrer();
  await attendre(400);
  await mkdir(join(c.projets, "nouveau"), { recursive: true });
  await writeFile(join(c.projets, "nouveau", "webaios.json"), '{"type":"poc","lancement":"x"}');
  await jusqua(() => etats.length > 0);
  menage.resoudre();
  await demarrage;
});

test("toutArreter annule aussi un lancement en file : rien n'est lancé après", async () => {
  const c = await espace();
  const { g, processus } = preparer({ chemins: c, sonder: sondeScriptee({}) });
  const premier = g.lancer("todo");
  await jusqua(() => processus.length === 1);
  const second = g.lancer("todo");
  await g.toutArreter();
  expect(await premier).toMatchObject({ etat: "arretee" });
  expect(await second).toMatchObject({ etat: "arretee" });
  await attendre(50);
  expect(processus).toHaveLength(1);
  expect(processus[0]!.tue).toBe(true);
});

test("arrêt de l'appli en marche par sa fin de processus : erreur", async () => {
  const c = await espace();
  const { g, processus, etats } = preparer({ chemins: c });
  await g.lancer("todo");
  processus[0]!.finir(1);
  await jusqua(() => etats.at(-1) === "erreur");
  const app = (await g.liste())[0]!;
  expect(app).toMatchObject({ etat: "erreur" });
  expect(app.erreur).toContain("Arrêtée avec le code 1");
  expect(app.port).toBeUndefined();
});

test("relancer une appli en marche l'arrête d'abord", async () => {
  const c = await espace();
  const { g, processus, arrets } = preparer({ chemins: c, sonder: sondeScriptee({ 5280: ["libre", "http", "libre", "http"] }) });
  await g.lancer("todo");
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche", port: 5280 });
  expect(processus[0]!.tue).toBe(true);
  expect(arrets()).toHaveLength(1);
  expect(processus).toHaveLength(2);
});

test("sans fiche ou dossier inconnu : lancer refuse", async () => {
  const c = await espace({ brut: null });
  const { g, processus } = preparer({ chemins: c });
  await expect(g.lancer("brut")).rejects.toThrow(/sans fiche/);
  await expect(g.lancer("absent")).rejects.toThrow(/inconnu/);
  expect(processus).toHaveLength(0);
  expect(await g.liste()).toMatchObject([{ dossier: "brut", type: "sans-fiche", sansFiche: "pas de webaios.json", etat: "arretee" }]);
});

test("oublier : un projet recréé sous le même nom ne montre plus l'ancienne erreur", async () => {
  const c = await espace();
  const { g } = preparer({ chemins: c, info: { code: 1 } });
  expect(await g.lancer("todo")).toMatchObject({ etat: "erreur" });
  g.oublier("todo");
  expect(g.etatDe("todo")).toBe("arretee");
  const [todo] = await g.liste();
  expect(todo).toMatchObject({ etat: "arretee" });
  expect(todo!.erreur).toBeUndefined();
});

test("docker absent : erreur Docker n'est pas lancé", async () => {
  const c = await espace();
  const { g, processus } = preparer({ chemins: c, info: { code: 1 } });
  expect(await g.lancer("todo")).toMatchObject({ etat: "erreur", erreur: "Docker n'est pas lancé." });
  expect(processus).toHaveLength(0);
});

test("conteneur arrêté : preparation puis lancement", async () => {
  const c = await espace();
  const { g, atelier, etats } = preparer({ chemins: c, inspect: { code: 0, stdout: "false\n" } });
  const assurer = vi.spyOn(atelier, "assurerDemarre").mockResolvedValue("demarre");
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche" });
  expect(assurer).toHaveBeenCalledOnce();
  expect(etats).toEqual(["preparation", "lancement", "en-marche"]);
});

test("demarrer arrête les orphelins WEBAIOS_APP", async () => {
  const c = await espace();
  const { g, arrets } = preparer({ chemins: c });
  await g.demarrer();
  expect(arrets()).toHaveLength(1);
  expect(arrets()[0]).toContain("WEBAIOS_APP=.*");
});

test("demarrer sur un conteneur arrêté : rien à arrêter", async () => {
  const c = await espace();
  const { g, arrets } = preparer({ chemins: c, inspect: { code: 0, stdout: "false\n" } });
  await g.demarrer();
  expect(arrets()).toHaveLength(0);
});

test("toutArreter arrête chaque appli en marche", async () => {
  const c = await espace({
    todo: '{"type":"application","lancement":"x"}',
    autre: '{"type":"poc","lancement":"y"}',
  });
  const { g, processus, arrets } = preparer({ chemins: c, sonder: sondeScriptee({ 5280: ["libre", "http"], 5281: ["libre", "http"] }) });
  await g.lancer("todo");
  await g.lancer("autre");
  await g.toutArreter();
  expect(processus.every((p) => p.tue)).toBe(true);
  expect(arrets().sort()).toHaveLength(2);
  expect((await g.liste()).map((a) => a.etat)).toEqual(["arretee", "arretee"]);
});

test("journal : les dernières lignes, vide si absent", async () => {
  const c = await espace();
  const { g } = preparer({ chemins: c });
  expect(await g.journal("todo")).toBe("");
  await mkdir(c.journaux, { recursive: true });
  await writeFile(join(c.journaux, "todo.log"), "a\nb\nc\n");
  expect(await g.journal("todo", 2)).toBe("b\nc");
  await expect(g.journal("../x")).rejects.toThrow();
});

async function ecouter(serveur: Server): Promise<number> {
  await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", r));
  return (serveur.address() as AddressInfo).port;
}

test("sonde par défaut : port fermé → libre", async () => {
  const serveur = serveurTcp();
  const port = await ecouter(serveur);
  await new Promise((r) => serveur.close(r));
  expect(await sonderParDefaut(port)).toBe("libre");
});

test("sonde par défaut : connexion acceptée puis coupée (proxy Docker sans serveur) → libre", async () => {
  const serveur = serveurTcp((s) => s.resetAndDestroy());
  try {
    expect(await sonderParDefaut(await ecouter(serveur))).toBe("libre");
  } finally {
    serveur.close();
  }
});

test("sonde par défaut : serveur HTTP → http", async () => {
  const serveur = serveurHttp((_, res) => res.writeHead(404).end());
  try {
    expect(await sonderParDefaut(await ecouter(serveur))).toBe("http");
  } finally {
    serveur.closeAllConnections();
    serveur.close();
  }
});

test("sonde par défaut : connexion acceptée sans réponse en 1 s → occupe", async () => {
  const sockets: import("node:net").Socket[] = [];
  const serveur = serveurTcp((s) => sockets.push(s));
  try {
    expect(await sonderParDefaut(await ecouter(serveur))).toBe("occupe");
  } finally {
    for (const s of sockets) s.destroy();
    serveur.close();
  }
});
