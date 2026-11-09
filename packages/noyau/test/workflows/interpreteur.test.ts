import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dossierTemporaire } from "../aide/temporaire.js";
import type { MemoireBlocs } from "../../src/workflows/memoire.js";
import { workflowImplicite } from "../../src/workflows/valider.js";
import { MOTEUR, SCRIPT, bloc, chaine, lancer, sortie } from "../aide/moteur.js";
import { PLAFOND_RECHERCHES, RECHERCHES_ARRETEES } from "../../src/workflows/acces.js";
import { RECHERCHE_REFUSEE } from "../../src/workflows/duckduckgo.js";

// The engine is the container's JavaScript: imported as is, without types.
const { executerWorkflow } = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);
const { default: listeNouveaux } = await import(pathToFileURL(join(MOTEUR, "blocs", "liste-nouveaux.mjs")).href);
const { default: listeGarder } = await import(pathToFileURL(join(MOTEUR, "blocs", "liste-garder.mjs")).href);
const { ElementNonLance } = await import(pathToFileURL(join(MOTEUR, "erreurs.mjs")).href);

describe("interpreter (in the container)", () => {
  it("runs the blocks in order and sends debut then fin for each block before fin", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        // In the array's disorder: the order comes from the links.
        blocs: [sortie, bloc("garder", "liste.garder", { nombre: 2 }), bloc("src", "code", { source: "src.mjs" })],
        liens: chaine("src", "garder", "sortie"),
      },
      fichiers: { "src.mjs": `export default async () => [1, 2, 3];` },
    });
    expect(r.code).toBe(0);
    expect(r.traces.map((l) => (l.t === "bloc" ? `${l.etape}:${l.id}` : l.t))).toEqual([
      "debut:src", "fin:src",
      "debut:garder", "fin:garder",
      "debut:sortie", "fin:sortie",
      "memoire", "fin",
    ]);
    expect(r.finBloc("src")).toEqual({ t: "bloc", id: "src", etape: "fin", statut: "reussi", sortie: [1, 2, 3] });
    expect(r.finBloc("garder").sortie).toEqual([1, 2]);
    expect(r.terminal).toEqual({ t: "fin", donnees: [1, 2] });
  });

  it("a block with several inputs receives { id: output }", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [
          bloc("a", "code", { source: "a.mjs" }),
          bloc("b", "code", { source: "b.mjs" }),
          bloc("tout", "code", { source: "tout.mjs" }),
          sortie,
        ],
        liens: [{ de: "a", vers: "tout" }, { de: "b", vers: "tout" }, { de: "tout", vers: "sortie" }],
      },
      fichiers: {
        "a.mjs": `export default async (entree) => ({ entreeDeA: entree });`,
        "b.mjs": `export default async () => "B";`,
        "tout.mjs": `export default async (entree) => entree;`,
      },
    });
    expect(r.terminal).toEqual({ t: "fin", donnees: { a: { entreeDeA: null }, b: "B" } });
  });

  it("code receives (entree, webaios) with config, precedent, maintenant, journal; its log lines are attached to the block and also go to stderr", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("lire", "code", { source: "lire.mjs" }), sortie],
        liens: chaine("src", "lire", "sortie"),
      },
      config: { ville: "Bordeaux" },
      precedent: { avant: 1 },
      fichiers: {
        "src.mjs": `export default async () => "x";`,
        "lire.mjs": `export default async (entree, w) => {
          w.journal("bonjour", { a: 1 });
          const p = await w.lirePage("https://a.fr/");
          return { entree, config: w.config, precedent: w.precedent, maintenant: w.maintenant, titre: p.titre };
        };`,
      },
      repondre: (a) => ({ ok: { url: a.a.url, titre: "T", texte: "", liens: [] } }),
    });
    expect(r.terminal.donnees).toEqual({
      entree: "x",
      config: { ville: "Bordeaux" },
      precedent: { avant: 1 },
      maintenant: "2026-10-29T10:00:00.000Z",
      titre: "T",
    });
    expect(r.lignes.filter((l) => l.t === "journal")).toEqual([{ t: "journal", bloc: "lire", texte: 'bonjour {"a":1}' }]);
    expect(r.stderr).toContain('bonjour {"a":1}');
    expect(r.appels[0]!.a).toEqual({ url: "https://a.fr/" });
  });

  it("code with appel: recolte calls default(webaios) as today", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("recolte", "code", { source: "recolte.mjs", appel: "recolte" }), sortie],
        liens: chaine("recolte", "sortie"),
      },
      config: { a: 1 },
      precedent: { v: 2 },
      fichiers: {
        "recolte.mjs": `export default async (w) => ({ cfg: w.config, prec: w.precedent, k: await w.kev("etat", { q: { type: "noul" } }) });`,
      },
      repondre: () => ({ ok: { q: { type: "noul", noul: 0.5 } } }),
    });
    expect(r.appels.map((a) => [a.f, a.a])).toEqual([["kev", { state: "etat", questions: { q: { type: "noul" } } }]]);
    expect(r.terminal).toEqual({ t: "fin", donnees: { cfg: { a: 1 }, prec: { v: 2 }, k: { q: { type: "noul", noul: 0.5 } } } });
  });

  it("an error thrown by the code ends the block failed and the run in echec with the same message", async () => {
    const r = await lancer({
      workflow: { version: 1, blocs: [bloc("recolte", "code", { source: "recolte.mjs", appel: "recolte" }), sortie], liens: chaine("recolte", "sortie") },
      fichiers: { "recolte.mjs": `export default async () => { throw new Error("boum"); };` },
    });
    expect(r.finBloc("recolte")).toEqual({ t: "bloc", id: "recolte", etape: "fin", statut: "echoue", erreur: "boum" });
    expect(r.terminal).toEqual({ t: "echec", erreur: "boum" });
    expect(r.lignes.some((l) => l.t === "memoire")).toBe(false);
  });

  it("a missing code file fails the block, the following ones are not launched, then echec", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("a", "code", { source: "absent.mjs" }), bloc("b", "liste.garder", { nombre: 1 }), sortie],
        liens: chaine("a", "b", "sortie"),
      },
    });
    expect(r.finBloc("a")).toMatchObject({ statut: "echoue", erreur: "fichier de code absent : absent.mjs" });
    expect(r.lignes.some((l) => l.t === "bloc" && l.id !== "a")).toBe(false);
    expect(r.terminal).toEqual({ t: "echec", erreur: "fichier de code absent : absent.mjs" });
    expect(r.code).toBe(1);
  });

  it("liste.nouveaux keeps only the never-seen keys and retains at most 5000 keys", async () => {
    const anciennes = Array.from({ length: 5000 }, (_, i) => `k${i}`);
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("nv", "liste.nouveaux", { cle: "url" }), sortie],
        liens: chaine("src", "nv", "sortie"),
      },
      memoire: { nv: { type: "liste.nouveaux", valeur: anciennes } },
      fichiers: { "src.mjs": `export default async () => [{ url: "k4999" }, { url: "neuf" }, { url: "k0" }, { url: "autre" }];` },
    });
    expect(r.terminal.donnees).toEqual([{ url: "neuf" }, { url: "autre" }]);
    const m = r.lignes.find((l) => l.t === "memoire").memoire.nv;
    expect(m.type).toBe("liste.nouveaux");
    expect(m.valeur).toHaveLength(5000);
    const cles = m.valeur.map(([c]: [string, string]) => c);
    // The keys seen this time are the most recent; the oldest never seen again are forgotten.
    expect(cles.slice(-4)).toEqual(["k4999", "neuf", "k0", "autre"]);
    expect(cles).not.toContain("k1");
    expect(cles).not.toContain("k2");
    expect(cles).toContain("k3");
  });

  it("liste.nouveaux: a duplicate in the same list is not new; a long key is kept cut to 500 characters", async () => {
    const longue = "u".repeat(800);
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("nv", "liste.nouveaux", { cle: "url" }), sortie],
        liens: chaine("src", "nv", "sortie"),
      },
      memoire: { nv: { type: "liste.nouveaux", valeur: ["u".repeat(500)] } },
      fichiers: {
        "src.mjs": `export default async () => [{ url: "a", n: 1 }, { url: "a", n: 2 }, { url: "b" }, { url: ${JSON.stringify(longue)} }];`,
      },
    });
    expect(r.terminal.donnees).toEqual([{ url: "a", n: 1 }, { url: "b" }]);
    expect(r.lignes.find((l) => l.t === "memoire").memoire.nv.valeur).toEqual([
      ["a", "2026-10-29T10:00:00.000Z"],
      ["b", "2026-10-29T10:00:00.000Z"],
      ["u".repeat(500), "2026-10-29T10:00:00.000Z"],
    ]);
  });

  it("liste.dedoublonner: duplicate on one of the normalized keys (utm_, www., trailing /; title accents and case)", async () => {
    const elements = [
      { titre: "Été à Paris", url: "https://www.a.fr/x/?utm_source=rss&id=1" },
      { titre: "Autre", url: "https://a.fr/x?id=1" }, // same normalized URL
      { titre: "ete a paris!", url: "https://b.fr/y" }, // same normalized title
      { titre: "Troisième", url: "https://b.fr/z" },
      { titre: "Sans url" },
      { titre: "Sans url 2" },
    ];
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("d", "liste.dedoublonner", { cles: ["url", "titre"] }), sortie],
        liens: chaine("src", "d", "sortie"),
      },
      fichiers: { "src.mjs": `export default async () => ${JSON.stringify(elements)};` },
    });
    expect(r.terminal.donnees).toEqual([elements[0], elements[3], elements[4], elements[5]]);
  });

  it("liste.garder keeps the first N; an input that is not a list fails the block", async () => {
    const ok = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("g", "liste.garder", { nombre: 3 }), sortie],
        liens: chaine("src", "g", "sortie"),
      },
      fichiers: { "src.mjs": `export default async () => [5, 4, 3, 2, 1];` },
    });
    expect(ok.terminal.donnees).toEqual([5, 4, 3]);
    const ko = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("g", "liste.garder", { nombre: 3 }), sortie],
        liens: chaine("src", "g", "sortie"),
      },
      fichiers: { "src.mjs": `export default async () => ({ pas: "une liste" });` },
    });
    expect(ko.finBloc("g")).toMatchObject({ statut: "echoue", erreur: "liste attendue en entrée" });
  });

  it("the memory sent before fin contains only the workflow's blocks, with their type; a memory of another type is ignored", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("nv", "liste.nouveaux", { cle: "id" }), sortie],
        liens: chaine("src", "nv", "sortie"),
      },
      memoire: {
        // Same id, other type: ignored (everything is new).
        nv: { type: "liste.dedoublonner", valeur: ["1"] },
        // Block that no longer exists: forgotten.
        ancien: { type: "liste.nouveaux", valeur: ["z"] },
        // Block present, same type, without a new value: kept as is.
        src: { type: "code", valeur: { garde: true } },
      },
      fichiers: { "src.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` },
    });
    expect(r.terminal.donnees).toEqual([{ id: 1 }, { id: 2 }]);
    const lignes = r.lignes.map((l) => l.t);
    expect(lignes.indexOf("memoire")).toBe(lignes.indexOf("fin") - 1);
    expect(r.lignes.find((l) => l.t === "memoire").memoire).toEqual({
      src: { type: "code", valeur: { garde: true } },
      nv: { type: "liste.nouveaux", valeur: [["1", "2026-10-29T10:00:00.000Z"], ["2", "2026-10-29T10:00:00.000Z"]] },
    });
  });

  it("a block output too big for a line is sent without output, with sortieTropGrosse", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("gros", "code", { source: "gros.mjs" }), bloc("taille", "code", { source: "taille.mjs" }), sortie],
        liens: chaine("gros", "taille", "sortie"),
      },
      fichiers: {
        "gros.mjs": `export default async () => "x".repeat(4 * 1024 * 1024 + 10);`,
        "taille.mjs": `export default async (entree) => entree.length;`,
      },
    });
    expect(r.finBloc("gros")).toEqual({ t: "bloc", id: "gros", etape: "fin", statut: "reussi", sortieTropGrosse: true });
    expect(r.terminal).toEqual({ t: "fin", donnees: 4 * 1024 * 1024 + 10 });
  });

  it("a debut without a workflow is refused: recolte.mjs no longer runs outside a workflow", async () => {
    const dossier = await dossierTemporaire();
    await writeFile(join(dossier, "recolte.mjs"), `export default async () => ({ lance: true });`);
    const enfant = spawn("node", [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    enfant.stdout.on("data", (d) => (out += d));
    const fini = new Promise<number | null>((ok) => enfant.on("close", (c) => ok(c)));
    enfant.stdin.write(JSON.stringify({ t: "debut", precedent: { v: 1 }, maintenant: "2026-10-29T10:00:00.000Z", config: { a: 1 } }) + "\n");
    expect(await fini).toBe(1);
    expect(out.trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ t: "echec", erreur: "debut sans workflow" }]);
  });

  it("the implicit workflow of a recolte.mjs: default(webaios) with the debut config, log on stderr", async () => {
    const r = await lancer({
      workflow: workflowImplicite(),
      config: { a: 1 },
      precedent: { v: 1 },
      fichiers: { "recolte.mjs": `export default async (w) => { w.journal("j"); return { cfg: w.config, prec: w.precedent, quand: w.maintenant }; };` },
    });
    expect(r.terminal).toEqual({ t: "fin", donnees: { cfg: { a: 1 }, prec: { v: 1 }, quand: "2026-10-29T10:00:00.000Z" } });
    expect(r.finBloc("recolte")).toMatchObject({ statut: "reussi" });
    expect(r.stderr).toContain("j");
  });
});

describe("interpreter: replay from a block", () => {
  it("with replay, only the relaunched blocks are traced, in order, and receive the reused outputs", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("b", "code", { source: "b.mjs" }), sortie],
        liens: chaine("src", "b", "sortie"),
      },
      fichiers: {
        "src.mjs": `export default async () => { throw new Error("src ne doit pas être lancé"); };`,
        "b.mjs": `export default async (entree) => ({ recu: entree });`,
      },
      rejeu: { relances: ["b", "sortie"], sorties: { src: [1, 2] } },
    });
    expect(r.code).toBe(0);
    // No trace for src, and no memory returned: the kernel keeps none for a trial.
    expect(r.traces.map((l) => (l.t === "bloc" ? `${l.etape}:${l.id}` : l.t))).toEqual([
      "debut:b", "fin:b",
      "debut:sortie", "fin:sortie",
      "fin",
    ]);
    expect(r.terminal).toEqual({ t: "fin", donnees: { recu: [1, 2] } });
  });

  it("a relaunched block with two inputs receives { id: output } mixing reuse and relaunch", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("a", "code", { source: "a.mjs" }), bloc("b", "code", { source: "b.mjs" }), bloc("tout", "code", { source: "tout.mjs" }), sortie],
        liens: [{ de: "a", vers: "tout" }, { de: "b", vers: "tout" }, { de: "tout", vers: "sortie" }],
      },
      fichiers: {
        "a.mjs": `export default async () => { throw new Error("a ne doit pas être lancé"); };`,
        "b.mjs": `export default async () => "B relancé";`,
        "tout.mjs": `export default async (entree) => entree;`,
      },
      rejeu: { relances: ["b", "tout", "sortie"], sorties: { a: { repris: true } } },
    });
    expect(r.terminal).toEqual({ t: "fin", donnees: { a: { repris: true }, b: "B relancé" } });
    expect(r.lignes.filter((l) => l.t === "bloc" && l.etape === "debut").map((l) => l.id)).toEqual(["b", "tout", "sortie"]);
  });

  it("without the sortie block among the relaunched ones, the data is null", async () => {
    const r = await lancer({
      workflow: { version: 1, blocs: [bloc("a", "code", { source: "a.mjs" }), sortie], liens: chaine("a", "sortie") },
      fichiers: { "a.mjs": `export default async () => "a";` },
      rejeu: { relances: ["a"], sorties: {} },
    });
    expect(r.terminal).toEqual({ t: "fin", donnees: null });
    expect(r.finBloc("sortie")).toBeUndefined();
  });

  it("with replay, the interpreter ignores the received memory: liste.nouveaux lets everything through, reutiliser reuses nothing, no block returns a memory", async () => {
    // The kernel sends an empty memory for a trial; the interpreter does not rely on it: even a received memory
    // (including that of a block not relaunched) is neither read nor returned.
    const calcules: string[] = [];
    const r = await executer({
      entree: "jamais lu",
      memoire: {
        src: { type: "test.source", valeur: "ancienne" },
        nv: { type: "liste.nouveaux", valeur: ["a", "b"] },
        b: { type: "test.resume", valeur: { reutilises: [["a", "ancien résumé"]] } },
      },
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "b", type: "test.resume", parametres: { champ: "resume", reutiliser: "url" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "test.resume": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            calcules.push(ctx.element.url);
            return `résumé de ${ctx.element.url}`;
          },
        },
      },
      rejeu: { relances: ["nv", "b", "sortie"], sorties: { src: [{ url: "a" }, { url: "b" }] } },
    });
    expect(r.erreur).toBeNull();
    expect(r.traces.some((l) => l.id === "src")).toBe(false);
    expect(calcules).toEqual(["a", "b"]);
    expect(r.resultat!.donnees).toEqual([{ url: "a", resume: "résumé de a" }, { url: "b", resume: "résumé de b" }]);
    expect(r.resultat!.memoire).toEqual({});
  });
});

/** Direct run of the interpreter, with a registry of test blocks. */
async function executer(o: {
  blocs: { id: string; type: string; parametres?: Record<string, unknown> }[];
  registre: Record<string, unknown>;
  entree: unknown;
  memoire?: MemoireBlocs;
  echeance?: number;
  horloge?: () => number;
  rejeu?: { relances: string[]; sorties: Record<string, unknown> };
  progressif?: boolean;
  avancement?: boolean;
  saisie?: string;
  /** Called on each line sent, at the moment it leaves. */
  espion?: (m: any) => void;
}) {
  const traces: any[] = [];
  const workflow = {
    blocs: [{ id: "src", type: "test.source", parametres: {} }, ...o.blocs.map((b) => ({ parametres: {}, ...b }))],
    liens: chaine("src", ...o.blocs.map((b) => b.id)),
    ordre: ["src", ...o.blocs.map((b) => b.id)],
  };
  const registre = {
    "test.source": { parElement: "non", executer: async () => ({ sortie: o.entree }) },
    sortie: { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree }) },
    ...o.registre,
  };
  let erreur: Error | null = null;
  let resultat: { donnees: unknown; memoire: MemoireBlocs } | null = null;
  try {
    resultat = await executerWorkflow({
      workflow,
      config: null,
      memoire: o.memoire ?? {},
      maintenant: "2026-10-29T10:00:00.000Z",
      precedent: null,
      dossier: "/nulle-part",
      appeler: async () => null,
      tracer: (m: unknown) => {
        o.espion?.(m);
        traces.push(m);
      },
      blocs: registre,
      ...(o.echeance !== undefined ? { echeance: o.echeance } : {}),
      ...(o.horloge ? { horloge: o.horloge } : {}),
      ...(o.rejeu ? { rejeu: o.rejeu } : {}),
      ...(o.progressif !== undefined ? { progressif: o.progressif } : {}),
      ...(o.avancement !== undefined ? { avancement: o.avancement } : {}),
      ...(o.saisie !== undefined ? { saisie: o.saisie } : {}),
    });
  } catch (e) {
    erreur = e as Error;
  }
  return {
    erreur,
    resultat,
    traces,
    finBloc: (id: string) => traces.find((l) => l.t === "bloc" && l.id === id && l.etape === "fin"),
    journal: (id: string) => traces.filter((l) => l.t === "journal" && l.bloc === id).map((l) => l.texte as string),
  };
}

const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const liste = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i }));

describe("interpreter: input and progress (actions)", () => {
  /** A per-element block where each element takes 300 ms on the fake clock. */
  const lent = (horloge: { t: number }) => ({
    "test.lent": {
      parElement: "toujours",
      async traiterElement(ctx: any) {
        await attendre(1);
        horloge.t += 300;
        return ctx.element.n;
      },
    },
  });

  it("with progress, a per-element block over 12 elements sends spaced avancement lines and the last one 12/12", async () => {
    const horloge = { t: 0 };
    const heures: number[] = [];
    const r = await executer({
      entree: liste(12),
      blocs: [{ id: "b", type: "test.lent", parametres: { champ: "v" } }, { id: "sortie", type: "sortie" }],
      registre: lent(horloge),
      horloge: () => horloge.t,
      avancement: true,
      espion: (m) => {
        if (m.etape === "avancement") heures.push(horloge.t);
      },
    });
    expect(r.erreur).toBeNull();
    const avancements = r.traces.filter((l) => l.etape === "avancement");
    expect(avancements.every((l) => l.t === "bloc" && l.id === "b" && l.total === 12)).toBe(true);
    expect(avancements.at(-1)).toEqual({ t: "bloc", id: "b", etape: "avancement", faits: 12, total: 12 });
    // Spaced by at least ECART_AVANCEMENT_MS, except the last, always sent.
    for (let i = 1; i < heures.length - 1; i++) expect(heures[i]! - heures[i - 1]!).toBeGreaterThanOrEqual(1000);
    expect(avancements.length).toBeGreaterThanOrEqual(2);
    expect(avancements.length).toBeLessThan(12);
    const faits = avancements.map((l) => l.faits);
    expect([...faits].sort((a, b) => a - b)).toEqual(faits);
    // Between the start and the end of the block.
    const indice = (f: (l: any) => boolean) => r.traces.findIndex(f);
    expect(indice((l) => l.etape === "avancement")).toBeGreaterThan(indice((l) => l.id === "b" && l.etape === "debut"));
    expect(r.traces.findLastIndex((l) => l.etape === "avancement")).toBeLessThan(indice((l) => l.id === "b" && l.etape === "fin"));
  });

  it("without progress, no avancement line", async () => {
    const horloge = { t: 0 };
    const r = await executer({
      entree: liste(12),
      blocs: [{ id: "b", type: "test.lent", parametres: { champ: "v" } }, { id: "sortie", type: "sortie" }],
      registre: lent(horloge),
      horloge: () => horloge.t,
    });
    expect(r.erreur).toBeNull();
    expect(r.traces.some((l) => l.etape === "avancement")).toBe(false);
  });

  it("ctx.saisie is given to the code", async () => {
    const workflow = {
      version: 1,
      blocs: [bloc("lire", "source.page", { url: "https://www.leboncoin.fr/recherche?text={saisie}" }), bloc("c", "code", { source: "c.mjs" }), sortie],
      liens: chaine("lire", "c", "sortie"),
    };
    const fichiers = { "c.mjs": `export default async (entree, w) => ({ saisie: w.saisie ?? null, aLaCle: "saisie" in w });` };
    const repondre = (a: any) => ({ ok: { url: a.a.url, titre: "", texte: "", liens: [] } });
    const r = await lancer({ workflow, fichiers, repondre, debut: { saisie: "clio lyon" } });
    expect(r.terminal).toEqual({ t: "fin", donnees: { saisie: "clio lyon", aLaCle: true } });
    expect(r.appels[0]!.a.url).toBe("https://www.leboncoin.fr/recherche?text=clio%20lyon");
    // An engine block receives it too in its ctx.
    let vue: unknown;
    await executer({
      entree: null,
      blocs: [{ id: "b", type: "test.voir" }, { id: "sortie", type: "sortie" }],
      registre: { "test.voir": { parElement: "non", executer: async (ctx: any) => ((vue = ctx.saisie), { sortie: null }) } },
      saisie: "clio lyon",
    });
    expect(vue).toBe("clio lyon");
    // A widget (without input): nothing new in webaios.
    const widget = await lancer({ workflow: { ...workflow, blocs: [bloc("lire", "code", { source: "c.mjs" }), bloc("c", "code", { source: "c.mjs" }), sortie] }, fichiers });
    expect(widget.terminal).toEqual({ t: "fin", donnees: { saisie: null, aLaCle: false } });
  });

  it("ECART_AVANCEMENT_MS equal in interpreteur.mjs and executer.ts", async () => {
    const interpreteur = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);
    const { ECART_AVANCEMENT_MS } = await import("../../src/workflows/executer.js");
    expect(ECART_AVANCEMENT_MS).toBe(1000);
    expect(interpreteur.ECART_AVANCEMENT_MS).toBe(ECART_AVANCEMENT_MS);
  });
});

describe("interpreter: per-element blocks", () => {
  it("per element: two elements at a time, result under champ, order kept", async () => {
    let enCours = 0;
    let max = 0;
    const r = await executer({
      entree: liste(6),
      blocs: [{ id: "double", type: "test.double", parametres: { champ: "d" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.double": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            enCours++;
            max = Math.max(max, enCours);
            // The first ones finish after the following ones: the output order stays the input's.
            await attendre(ctx.element.n < 2 ? 40 : 5);
            enCours--;
            return ctx.element.n * 2;
          },
        },
      },
    });
    expect(r.erreur).toBeNull();
    expect(max).toBe(2);
    expect(r.resultat!.donnees).toEqual(liste(6).map((e) => ({ ...e, d: e.n * 2 })));
    expect(r.finBloc("double")).toMatchObject({ statut: "reussi" });
  });

  it("per element « option »: without parElement, executer runs once on the whole input", async () => {
    const r = await executer({
      entree: liste(3),
      blocs: [{ id: "b", type: "test.option", parametres: { parElement: false, champ: "x" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.option": {
          parElement: "option",
          executer: async (ctx: any) => ({ sortie: ctx.entree.length }),
          traiterElement: async () => "élément",
        },
      },
    });
    expect(r.resultat!.donnees).toBe(3);
  });

  it("per element: an input that is not a list fails the block", async () => {
    const r = await executer({
      entree: { pas: "liste" },
      blocs: [{ id: "b", type: "test.x", parametres: { champ: "x" } }, { id: "sortie", type: "sortie" }],
      registre: { "test.x": { parElement: "toujours", traiterElement: async () => 1 } },
    });
    expect(r.erreur?.message).toBe("liste attendue en entrée");
    expect(r.finBloc("b")).toMatchObject({ statut: "echoue", erreur: "liste attendue en entrée" });
  });

  it("per element: a failing element is skipped, the block ends partial; siErreur echouer fails the block", async () => {
    const registre = {
      "test.x": {
        parElement: "toujours",
        async traiterElement(ctx: any) {
          if (ctx.element.n === 1) throw new Error("raté");
          return "ok";
        },
      },
    };
    const saute = await executer({
      entree: liste(3),
      blocs: [{ id: "b", type: "test.x", parametres: { champ: "r" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(saute.resultat!.donnees).toEqual([{ n: 0, r: "ok" }, { n: 1 }, { n: 2, r: "ok" }]);
    expect(saute.finBloc("b")).toMatchObject({ statut: "partiel" });
    expect(saute.journal("b").join("\n")).toContain("raté");

    const echoue = await executer({
      entree: liste(3),
      blocs: [{ id: "b", type: "test.x", parametres: { champ: "r", siErreur: "echouer" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(echoue.erreur?.message).toBe("raté");
    expect(echoue.finBloc("b")).toMatchObject({ statut: "echoue", erreur: "raté" });
    expect(echoue.traces.some((l) => l.id === "sortie")).toBe(false);
  });

  it("per element: all elements failing fail a block that asks for it, even with sauter; the others end partial; an empty list is not a failure", async () => {
    const registre = {
      "test.x": { parElement: "toujours", echecSiTousEchouent: true, traiterElement: async () => { throw new Error("Kev indisponible"); } },
      "test.enrichir": { parElement: "toujours", traiterElement: async () => { throw new Error("page illisible"); } },
    };
    const tous = await executer({
      entree: liste(2),
      blocs: [{ id: "b", type: "test.x", parametres: { champ: "r" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(tous.finBloc("b")).toMatchObject({ statut: "echoue" });
    expect(tous.erreur?.message).toContain("Kev indisponible");

    const enrichir = await executer({
      entree: liste(2),
      blocs: [{ id: "b", type: "test.enrichir", parametres: { champ: "r" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(enrichir.erreur).toBeNull();
    expect(enrichir.finBloc("b")).toMatchObject({ statut: "partiel" });
    expect(enrichir.resultat!.donnees).toEqual(liste(2));
    expect(enrichir.journal("b").join("\n")).toContain("page illisible");

    const vide = await executer({
      entree: [],
      blocs: [{ id: "b", type: "test.x", parametres: { champ: "r" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(vide.erreur).toBeNull();
    expect(vide.finBloc("b")).toMatchObject({ statut: "reussi", sortie: [] });
  });

  it("per element: a missing template value leaves the element without a field, without an error; in simple mode the output is null", async () => {
    const registre = {
      "test.gabarit": {
        parElement: "option",
        executer: async (ctx: any) => ({ sortie: ctx.remplir("{config.ville}").texte }),
        traiterElement: async (ctx: any) => ctx.remplir("url={url}", { url: true }).texte,
      },
    };
    const parElement = await executer({
      // An old value under `champ` does not survive an element without a value this time.
      entree: [{ url: "a b", u: "ancienne" }, { autre: 1, u: "ancienne" }],
      blocs: [{ id: "b", type: "test.gabarit", parametres: { parElement: true, champ: "u" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(parElement.resultat!.donnees).toEqual([{ url: "a b", u: "url=a%20b" }, { autre: 1 }]);
    expect(parElement.finBloc("b")).toMatchObject({ statut: "reussi" });
    expect(parElement.journal("b").join("\n")).toContain("valeur absente : url");

    const simple = await executer({
      entree: null,
      blocs: [{ id: "b", type: "test.gabarit", parametres: { parElement: false, champ: "u" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(simple.finBloc("b")).toEqual({ t: "bloc", id: "b", etape: "fin", statut: "reussi", sortie: null });
    expect(simple.journal("b")).toEqual(["valeur absente : config.ville"]);
  });

  it("per element: an optional marker {chemin?} that is absent gives an empty string, present it is filled; the element is processed", async () => {
    const registre = {
      "test.gabarit": { parElement: "option", traiterElement: async (ctx: any) => ctx.remplir("Avis de {titre} ; fiabilité : {fiabilite?}.").texte },
    };
    const r = await executer({
      entree: [{ titre: "A", fiabilite: "bonne" }, { titre: "B" }],
      blocs: [{ id: "b", type: "test.gabarit", parametres: { parElement: true, champ: "avis" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(r.resultat!.donnees).toEqual([
      { titre: "A", fiabilite: "bonne", avis: "Avis de A ; fiabilité : bonne." },
      { titre: "B", avis: "Avis de B ; fiabilité : ." },
    ]);
    expect(r.finBloc("b")).toMatchObject({ statut: "reussi" });
  });

  it("budgetSecondes: past the time, no more element launched, the following ones without champ, partial block", async () => {
    // Simulated clock: each element « lasts » 300 ms, the element's end advances the time.
    let maintenant = 0;
    const lances: number[] = [];
    const r = await executer({
      entree: liste(12),
      horloge: () => maintenant,
      blocs: [{ id: "b", type: "test.lent", parametres: { champ: "r", budgetSecondes: 1 } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.lent": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            lances.push(ctx.element.n);
            await Promise.resolve();
            maintenant += 300;
            return "fait";
          },
        },
      },
    });
    // The two elements in progress finish before the next check: pairs launched at 0 and 600; at 1200, nothing more.
    expect(lances).toEqual([0, 1, 2, 3]);
    const sortie = r.resultat!.donnees as { n: number; r?: string }[];
    expect(sortie.filter((e) => e.r === "fait").map((e) => e.n)).toEqual([0, 1, 2, 3]);
    expect(sortie.slice(4).every((e) => !("r" in e))).toBe(true);
    expect(r.finBloc("b")).toMatchObject({ statut: "partiel" });
    expect(r.journal("b")).toContain("temps écoulé : 8 élément(s) non lancé(s)");
  });

  it("the global time (150 s since debut) also stops launching elements", async () => {
    let maintenant = 0;
    let lances = 0;
    const r = await executer({
      entree: liste(10),
      horloge: () => maintenant,
      echeance: 250,
      blocs: [{ id: "b", type: "test.lent", parametres: { champ: "r" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.lent": {
          parElement: "toujours",
          async traiterElement() {
            lances++;
            await Promise.resolve();
            maintenant += 100;
            return 1;
          },
        },
      },
    });
    // Pairs launched at 0 and 200; at 400, nothing more.
    expect(lances).toBe(4);
    expect(r.finBloc("b")).toMatchObject({ statut: "partiel" });
  });

  it("among the launched elements, none succeeded and at least one failed: the block fails (not launched and absent values do not count)", async () => {
    let maintenant = 0;
    const registre = {
      "test.ko": {
        parElement: "toujours",
        echecSiTousEchouent: true,
        async traiterElement(ctx: any) {
          ctx.remplir("{url}");
          await Promise.resolve();
          maintenant += 600;
          throw new Error("raté");
        },
      },
    };
    const temps = await executer({
      entree: liste(6).map((e) => ({ ...e, url: "u" })),
      horloge: () => maintenant,
      blocs: [{ id: "b", type: "test.ko", parametres: { champ: "r", budgetSecondes: 1 } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(temps.finBloc("b")).toMatchObject({ statut: "echoue" });
    expect(temps.erreur?.message).toContain("raté");

    const absente = await executer({
      entree: [{ url: "u" }, { autre: 1 }],
      blocs: [{ id: "b", type: "test.ko", parametres: { champ: "r" } }, { id: "sortie", type: "sortie" }],
      registre,
    });
    expect(absente.finBloc("b")).toMatchObject({ statut: "echoue" });
  });

  it("reutiliser reuses the memory's value without a call and stores the new ones", async () => {
    const calcules: string[] = [];
    const r = await executer({
      entree: [{ url: "https://a.fr/1" }, { url: "https://a.fr/2" }, { url: null }],
      memoire: { b: { type: "test.resume", valeur: { reutilises: [["https://a.fr/1", "déjà fait"], ["https://vieux.fr/", "vieux"]] } } },
      blocs: [{ id: "b", type: "test.resume", parametres: { champ: "resume", reutiliser: "url" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.resume": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            calcules.push(String(ctx.element.url));
            return `résumé de ${ctx.element.url}`;
          },
        },
      },
    });
    expect(calcules).toEqual(["https://a.fr/2", "null"]);
    expect(r.resultat!.donnees).toEqual([
      { url: "https://a.fr/1", resume: "déjà fait" },
      { url: "https://a.fr/2", resume: "résumé de https://a.fr/2" },
      { url: null, resume: "résumé de null" },
    ]);
    // The reused or computed values are the most recent; an element without a key is not stored. The old
    // pairs without a date are dated now.
    const m = "2026-10-29T10:00:00.000Z";
    expect(r.resultat!.memoire.b).toEqual({
      type: "test.resume",
      valeur: { reutilises: [["https://vieux.fr/", "vieux", m], ["https://a.fr/1", "déjà fait", m], ["https://a.fr/2", "résumé de https://a.fr/2", m]] },
    });
  });

  it("reutiliser keeps at most 2 MB per block, forgetting the oldest", async () => {
    const gros = "x".repeat(600 * 1024);
    const r = await executer({
      entree: liste(5).map((e) => ({ ...e, cle: `k${e.n}` })),
      blocs: [{ id: "b", type: "test.gros", parametres: { champ: "g", reutiliser: "cle" } }, { id: "sortie", type: "sortie" }],
      registre: { "test.gros": { parElement: "toujours", traiterElement: async () => gros } },
    });
    const gardees = (r.resultat!.memoire.b!.valeur as { reutilises: [string, string][] }).reutilises.map(([k]) => k);
    expect(gardees).toEqual(["k2", "k3", "k4"]);
  });

  it("all the memory sent fits in 2.5 MB: the oldest values of the biggest block go first", async () => {
    const gros = "x".repeat(450 * 1024);
    const r = await executer({
      entree: liste(5).map((e) => ({ ...e, cle: `k${e.n}` })),
      blocs: [
        { id: "b1", type: "test.gros", parametres: { champ: "g1", reutiliser: "cle" } },
        { id: "b2", type: "test.gros", parametres: { champ: "g2", reutiliser: "cle" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: { "test.gros": { parElement: "toujours", traiterElement: async () => gros } },
    });
    const memoire = r.resultat!.memoire;
    expect(Buffer.byteLength(JSON.stringify(memoire))).toBeLessThanOrEqual(2.5 * 1024 * 1024);
    const cles = (id: string) => (memoire[id]!.valeur as { reutilises: [string, string][] }).reutilises.map(([k]) => k);
    // Each bounded to 2 MB (4 kept), then the biggest loses its oldest, in turn.
    expect(cles("b1")).toEqual(["k3", "k4"]);
    expect(cles("b2")).toEqual(["k2", "k3", "k4"]);
  });

  it("finaliser receives the enriched list and returns the block's output", async () => {
    const r = await executer({
      entree: liste(4),
      blocs: [{ id: "b", type: "test.trier", parametres: { champ: "p" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.trier": {
          parElement: "toujours",
          traiterElement: async (ctx: any) => ctx.element.n / 4,
          finaliser: async (l: { p: number }[]) => ({ sortie: l.filter((e) => e.p >= 0.5).sort((a, b) => b.p - a.p) }),
        },
      },
    });
    expect(r.resultat!.donnees).toEqual([{ n: 3, p: 0.75 }, { n: 2, p: 0.5 }]);
  });

  it("a simple block can end partial; a type without a module fails « type inconnu dans le conteneur »", async () => {
    const partiel = await executer({
      entree: 1,
      blocs: [{ id: "b", type: "test.p", parametres: {} }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.p": {
          parElement: "non",
          executer: async (ctx: any) => {
            ctx.partiel("un flux en échec");
            return { sortie: 2 };
          },
        },
      },
    });
    expect(partiel.finBloc("b")).toMatchObject({ statut: "partiel", sortie: 2 });
    expect(partiel.journal("b")).toEqual(["un flux en échec"]);

    const inconnu = await executer({ entree: 1, blocs: [{ id: "b", type: "test.absent" }, { id: "sortie", type: "sortie" }], registre: {} });
    expect(inconnu.erreur?.message).toBe("type inconnu dans le conteneur : test.absent");
  });
});

describe("interpreter: web.chercher", () => {
  const WEB = { web: true, dureeMaxMinutes: null, proprietaire: "widget" as const, saisie: false };
  const annonces = [
    { marque: "Peugeot", modele: "208 & co/é" },
    { marque: "Renault", modele: "Clio" },
    { marque: "Fiat", modele: "Panda" },
  ];
  const workflow = (parametres: Record<string, unknown> = {}) => ({
    version: 1,
    blocs: [
      bloc("liste", "code", { source: "liste.mjs" }),
      bloc("cherche", "web.chercher", { requete: "{marque} {modele} fiabilité", parElement: true, ...parametres }),
      sortie,
    ],
    liens: chaine("liste", "cherche", "sortie"),
  });
  const fichiers = { "liste.mjs": `export default async () => (${JSON.stringify(annonces)});` };
  const resultat = (requete: string) => [{ titre: "Avis " + requete, url: "https://avis.fr/1", extrait: "Bien", rang: 1 }];
  const journalDe = (r: { lignes: any[] }, id: string) => r.lignes.filter((l) => l.t === "journal" && l.bloc === id).map((l) => l.texte);

  it("web.chercher per element stores the list under recherche, query filled with {marque} {modele} without encoding", async () => {
    const r = await lancer({
      workflow: workflow({ nombre: 5 }),
      fichiers,
      contexte: WEB,
      repondre: (a) => (a.f === "chercherWeb" ? { ok: resultat(a.a.requete) } : { erreur: "inattendu" }),
    });
    expect(r.appels.map((a) => [a.f, a.a]).sort()).toEqual(
      [
        ["chercherWeb", { requete: "Peugeot 208 & co/é fiabilité", nombre: 5 }],
        ["chercherWeb", { requete: "Renault Clio fiabilité", nombre: 5 }],
        ["chercherWeb", { requete: "Fiat Panda fiabilité", nombre: 5 }],
      ].sort(),
    );
    // Remise en forme : titre, url, extrait en textes ; rien d'autre.
    expect(r.terminal).toEqual({
      t: "fin",
      donnees: annonces.map((e) => ({ ...e, recherche: [{ titre: `Avis ${e.marque} ${e.modele} fiabilité`, url: "https://avis.fr/1", extrait: "Bien" }] })),
    });
    expect(r.finBloc("cherche")).toMatchObject({ statut: "reussi" });
  });

  it("ceiling reached: the remaining elements without champ, partial block, even with siErreur echouer", async () => {
    let n = 0;
    const r = await lancer({
      workflow: workflow({ siErreur: "echouer" }),
      fichiers,
      contexte: WEB,
      repondre: (a) => (++n === 1 ? { ok: resultat(a.a.requete) } : { erreur: PLAFOND_RECHERCHES }),
    });
    expect(r.terminal.t).toBe("fin");
    const donnees = r.terminal.donnees as Record<string, unknown>[];
    expect(donnees.filter((e) => "recherche" in e)).toHaveLength(1);
    expect(donnees.filter((e) => !("recherche" in e))).toHaveLength(2);
    expect(r.finBloc("cherche")).toMatchObject({ statut: "partiel" });
    const journal = journalDe(r, "cherche");
    // One line for the first refusal, one for the elements that follow: not one per element.
    expect(journal.filter((t) => /^élément \d : /.test(t))).toEqual([expect.stringContaining(` : ${PLAFOND_RECHERCHES}`)]);
    expect(journal.length).toBeLessThanOrEqual(2);
    // The sortie block did run.
    expect(r.finBloc("sortie")).toMatchObject({ statut: "reussi" });
  });

  it("after the kernel's first refusal, no more search: the remaining elements not launched, only one more line", async () => {
    const vingt = Array.from({ length: 20 }, (_, i) => ({ marque: "M" + i, modele: "X" }));
    const r = await lancer({
      workflow: workflow({ reutiliser: "marque" }),
      fichiers: { "liste.mjs": `export default async () => (${JSON.stringify(vingt)});` },
      contexte: WEB,
      // M15 is already known: it is reused without a search, even after the refusal.
      memoire: { cherche: { type: "web.chercher", valeur: { reutilises: [["M15", [{ titre: "Connu", url: "https://avis.fr/15", extrait: "" }]]] } } },
      repondre: (a) => (a.a.requete.startsWith("M0 ") ? { ok: resultat(a.a.requete) } : { erreur: RECHERCHES_ARRETEES }),
    });
    expect(r.terminal.t).toBe("fin");
    // M0 and M1 leave together (two at a time); M1 refused, M2 at most could leave before the refusal was known.
    expect(r.appels.length).toBeLessThanOrEqual(3);
    const donnees = r.terminal.donnees as Record<string, unknown>[];
    expect(donnees.filter((e) => "recherche" in e).map((e) => e.marque)).toEqual(["M0", "M15"]);
    expect(r.finBloc("cherche")).toMatchObject({ statut: "partiel" });
    const journal = journalDe(r, "cherche");
    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatch(new RegExp(`^élément \\d+ : ${RECHERCHES_ARRETEES.replace(/[()]/g, "\\$&")}$`));
    expect(journal[1]).toBe("17 autre(s) élément(s) non lancé(s)");
  });

  it("in simple mode, success returns the list itself, reshaped (non-texts as \"\", extra keys removed)", async () => {
    const r = await lancer({
      workflow: { version: 1, blocs: [bloc("cherche", "web.chercher", { requete: "rust" }), sortie], liens: chaine("cherche", "sortie") },
      contexte: WEB,
      repondre: () => ({ ok: [{ titre: 1, url: "u", extrait: null, rang: 2 }] }),
    });
    expect(r.terminal).toEqual({ t: "fin", donnees: [{ titre: "", url: "u", extrait: "" }] });
    expect(r.finBloc("cherche")).toMatchObject({ statut: "reussi" });
  });

  it("a response that is not a list: « résultats de recherche invalides »", async () => {
    const r = await lancer({
      workflow: { version: 1, blocs: [bloc("cherche", "web.chercher", { requete: "rust" }), sortie], liens: chaine("cherche", "sortie") },
      contexte: WEB,
      repondre: () => ({ ok: {} }),
    });
    expect(r.finBloc("cherche")).toMatchObject({ statut: "echoue", erreur: "résultats de recherche invalides" });
  });

  it("the filled query is cut to 500 characters and stripped of its blanks; empty, it is an absent value", async () => {
    const elements = [{ marque: "  " + "a".repeat(400), modele: "b".repeat(400) }, { marque: "   ", modele: "  " }];
    const r = await lancer({
      workflow: workflow({ requete: "{marque} {modele}" }),
      fichiers: { "liste.mjs": `export default async () => (${JSON.stringify(elements)});` },
      contexte: WEB,
      repondre: (a) => ({ ok: resultat(a.a.requete) }),
    });
    expect(r.appels.map((a) => a.a.requete)).toEqual(["a".repeat(400) + " " + "b".repeat(99)]);
    const donnees = r.terminal.donnees as Record<string, unknown>[];
    expect("recherche" in donnees[0]!).toBe(true);
    expect("recherche" in donnees[1]!).toBe(false);
    expect(journalDe(r, "cherche")).toEqual(["élément 2 : valeur absente : requete"]);
  });

  it("RECHERCHE_REFUSEE on an element with siErreur echouer: the block fails", async () => {
    const r = await lancer({
      workflow: workflow({ siErreur: "echouer" }),
      fichiers,
      contexte: WEB,
      repondre: (a) => (a.a.requete.startsWith("Renault") ? { erreur: RECHERCHE_REFUSEE } : { ok: resultat(a.a.requete) }),
    });
    expect(r.finBloc("cherche")).toMatchObject({ statut: "echoue", erreur: RECHERCHE_REFUSEE });
    expect(r.terminal).toEqual({ t: "echec", erreur: RECHERCHE_REFUSEE });
  });

  it("in simple mode, the ceiling is an ordinary error", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("cherche", "web.chercher", { requete: "{config.sujet} actualité" }), sortie],
        liens: chaine("cherche", "sortie"),
      },
      config: { sujet: "Rust" },
      contexte: WEB,
      repondre: () => ({ erreur: PLAFOND_RECHERCHES }),
    });
    expect(r.appels.map((a) => a.a)).toEqual([{ requete: "Rust actualité", nombre: 8 }]);
    expect(r.finBloc("cherche")).toMatchObject({ statut: "echoue", erreur: PLAFOND_RECHERCHES });
    expect(r.terminal).toEqual({ t: "echec", erreur: PLAFOND_RECHERCHES });
  });

  it("replay from the block after web.chercher: no chercherWeb call", async () => {
    const recherches = annonces.map((e) => ({ ...e, recherche: [{ titre: "T", url: "https://avis.fr/1", extrait: "E" }] }));
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [...workflow().blocs.slice(0, 2), bloc("garder", "liste.garder", { nombre: 2 }), sortie],
        liens: chaine("liste", "cherche", "garder", "sortie"),
      },
      fichiers,
      contexte: WEB,
      rejeu: { relances: ["garder", "sortie"], sorties: { cherche: recherches } },
      repondre: () => ({ erreur: "aucun appel attendu" }),
    });
    expect(r.appels).toEqual([]);
    expect(r.terminal).toEqual({ t: "fin", donnees: recherches.slice(0, 2) });
  });
});

describe("interpreter: dated memory (garderJours)", () => {
  const MAINTENANT = "2026-10-29T10:00:00.000Z";
  const ilYa = (jours: number) => new Date(Date.parse(MAINTENANT) - jours * 86_400_000).toISOString();
  const nouveaux = (entree: unknown[], memoire: unknown, parametres: Record<string, unknown> = {}) =>
    listeNouveaux.executer({ entree, parametres: { cle: "url", ...parametres }, memoire, journal: () => {}, maintenant: MAINTENANT });

  it("a key seen 31 days ago with garderJours 30 becomes new again; at 29 days, not", async () => {
    const r = await nouveaux([{ url: "vieille" }, { url: "recente" }], [["vieille", ilYa(31)], ["recente", ilYa(29)], ["oubliee", ilYa(31)]], {
      garderJours: 30,
    });
    expect(r.sortie).toEqual([{ url: "vieille" }]);
    expect(r.nouvelles).toEqual(["vieille"]);
    // The too-old, never-seen-again entry is not rewritten; the seen-again keys take today's date.
    expect(r.memoire).toEqual([["vieille", MAINTENANT], ["recente", MAINTENANT]]);
  });

  it("without garderJours, a 400-day-old key stays seen", async () => {
    const r = await nouveaux([{ url: "a" }, { url: "b" }], [["a", ilYa(400)], ["autre", ilYa(400)]]);
    expect(r.sortie).toEqual([{ url: "b" }]);
    expect(r.nouvelles).toEqual(["b"]);
    expect(r.memoire).toEqual([["autre", ilYa(400)], ["a", MAINTENANT], ["b", MAINTENANT]]);
  });

  it("a seen-again key takes today's date", async () => {
    const r = await nouveaux([{ url: "a" }], [["a", ilYa(10)], ["b", ilYa(5)]], { garderJours: 30 });
    expect(r.sortie).toEqual([]);
    expect(r.nouvelles).toEqual([]);
    expect(r.memoire).toEqual([["b", ilYa(5)], ["a", MAINTENANT]]);
  });

  it("old memory in texts: read as seen, rewritten dated now", async () => {
    const r = await nouveaux([{ url: "a" }, { url: "c" }], ["a", "b"], { garderJours: 1 });
    expect(r.sortie).toEqual([{ url: "c" }]);
    expect(r.memoire).toEqual([["b", MAINTENANT], ["a", MAINTENANT], ["c", MAINTENANT]]);
  });

  it("in the container, liste.nouveaux receives maintenant from the debut line and returns a dated memory", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("nv", "liste.nouveaux", { cle: "url", garderJours: 30 }), sortie],
        liens: chaine("src", "nv", "sortie"),
      },
      memoire: { nv: { type: "liste.nouveaux", valeur: [["a", ilYa(31)], ["b", ilYa(2)]] } },
      fichiers: { "src.mjs": `export default async () => [{ url: "a" }, { url: "b" }];` },
    });
    expect(r.terminal.donnees).toEqual([{ url: "a" }]);
    expect(r.lignes.find((l) => l.t === "memoire").memoire.nv.valeur).toEqual([["a", MAINTENANT], ["b", MAINTENANT]]);
  });

  const resume = (calcules: string[]) => ({
    "test.resume": {
      parElement: "toujours",
      async traiterElement(ctx: any) {
        calcules.push(String(ctx.element.url));
        return `résumé de ${ctx.element.url}`;
      },
    },
  });

  it("reutiliser with garderJours 30: 31-day value recomputed, 29-day one reused without a call and its date kept", async () => {
    const calcules: string[] = [];
    const r = await executer({
      entree: [{ url: "vieille" }, { url: "recente" }],
      memoire: {
        b: { type: "test.resume", valeur: { reutilises: [["vieille", "ancien", ilYa(31)], ["recente", "gardé", ilYa(29)], ["oubliee", "x", ilYa(40)]] } },
      },
      blocs: [{ id: "b", type: "test.resume", parametres: { champ: "resume", reutiliser: "url", garderJours: 30 } }, { id: "sortie", type: "sortie" }],
      registre: resume(calcules),
    });
    expect(calcules).toEqual(["vieille"]);
    expect(r.resultat!.donnees).toEqual([
      { url: "vieille", resume: "résumé de vieille" },
      { url: "recente", resume: "gardé" },
    ]);
    // The too-old entry never seen again is forgotten; the reuse does not refresh the date.
    expect([...(r.resultat!.memoire.b!.valeur as { reutilises: unknown[] }).reutilises].sort()).toEqual([
      ["recente", "gardé", ilYa(29)],
      ["vieille", "résumé de vieille", MAINTENANT],
    ]);
  });

  it("without garderJours, reutiliser reuses a 400-day value", async () => {
    const calcules: string[] = [];
    const r = await executer({
      entree: [{ url: "a" }],
      memoire: { b: { type: "test.resume", valeur: { reutilises: [["a", "très ancien", ilYa(400)]] } } },
      blocs: [{ id: "b", type: "test.resume", parametres: { champ: "resume", reutiliser: "url" } }, { id: "sortie", type: "sortie" }],
      registre: resume(calcules),
    });
    expect(calcules).toEqual([]);
    expect(r.resultat!.memoire.b!.valeur).toEqual({ reutilises: [["a", "très ancien", ilYa(400)]] });
  });

  it("old [cle, valeur] pairs of reutiliser reused without a call", async () => {
    const calcules: string[] = [];
    const r = await executer({
      entree: [{ url: "a" }],
      memoire: { b: { type: "test.resume", valeur: { reutilises: [["a", "ancien"], ["b", "autre"]] } } },
      blocs: [{ id: "b", type: "test.resume", parametres: { champ: "resume", reutiliser: "url", garderJours: 1 } }, { id: "sortie", type: "sortie" }],
      registre: resume(calcules),
    });
    expect(calcules).toEqual([]);
    expect(r.resultat!.donnees).toEqual([{ url: "a", resume: "ancien" }]);
    expect(r.resultat!.memoire.b!.valeur).toEqual({ reutilises: [["b", "autre", MAINTENANT], ["a", "ancien", MAINTENANT]] });
  });

  it("reutiliser: two elements with the same key processed at the same time make only one call", async () => {
    let appels = 0;
    const r = await executer({
      entree: [{ modele: "Clio", n: 1 }, { modele: "Clio", n: 2 }, { modele: "208", n: 3 }],
      blocs: [{ id: "b", type: "test.avis", parametres: { champ: "avis", reutiliser: "modele" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.avis": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            appels++;
            await attendre(20);
            return `avis ${ctx.element.modele}`;
          },
        },
      },
    });
    expect(appels).toBe(2);
    expect(r.resultat!.donnees).toEqual([
      { modele: "Clio", n: 1, avis: "avis Clio" },
      { modele: "Clio", n: 2, avis: "avis Clio" },
      { modele: "208", n: 3, avis: "avis 208" },
    ]);
    expect(r.finBloc("b")).toMatchObject({ statut: "reussi" });
  });

  it("reutiliser: if the in-progress computation of the same key fails, the second element computes itself", async () => {
    const lances: number[] = [];
    const r = await executer({
      entree: [{ modele: "Clio", n: 1 }, { modele: "Clio", n: 2 }],
      blocs: [{ id: "b", type: "test.avis", parametres: { champ: "avis", reutiliser: "modele" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.avis": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            lances.push(ctx.element.n);
            await attendre(10);
            if (ctx.element.n === 1) throw new Error("raté");
            return "avis";
          },
        },
      },
    });
    expect(lances).toEqual([1, 2]);
    expect(r.resultat!.donnees).toEqual([{ modele: "Clio", n: 1 }, { modele: "Clio", n: 2, avis: "avis" }]);
    expect(r.finBloc("b")).toMatchObject({ statut: "partiel" });
  });
});

describe("interpreter: progressive run", () => {
  const MAINTENANT = "2026-10-29T10:00:00.000Z";
  const VIEUX = "2026-10-01T10:00:00.000Z";
  const memoires = (r: { traces: any[] }) => r.traces.filter((l) => l.t === "memoire").map((l) => l.memoire);
  const avis = (echoueSur: string) => ({
    parElement: "toujours",
    async traiterElement(ctx: any) {
      await Promise.resolve();
      if (ctx.element.modele === echoueSur) throw new Error("raté");
      return `avis ${ctx.element.modele}`;
    },
  });
  const echecAvis = (progressif: boolean) =>
    executer({
      progressif,
      entree: [{ url: "a", modele: "Clio" }, { url: "b", modele: "208" }, { url: "c", modele: "Panda" }],
      memoire: { nv: { type: "liste.nouveaux", valeur: [["vieille", VIEUX]] } },
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "avis", type: "test.avis", parametres: { champ: "avis", reutiliser: "modele", siErreur: "echouer" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: { "liste.nouveaux": listeNouveaux, "test.avis": avis("Panda") },
    });

  // nouvelles → tri → garder 2 → lire (one failing read) → sortie
  const veille = (progressif: boolean) =>
    executer({
      progressif,
      entree: ["a", "b", "c", "d", "e", "f"].map((url) => ({ url, note: url === "b" ? 1 : 9 })),
      memoire: { nv: { type: "liste.nouveaux", valeur: [["a", VIEUX]] } },
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "tri", type: "test.tri", parametres: { champ: "n" } },
        { id: "garder", type: "liste.garder", parametres: { nombre: 2 } },
        { id: "lire", type: "test.lire", parametres: { champ: "page" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "liste.garder": listeGarder,
        "test.tri": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            return ctx.element.note;
          },
          async finaliser(liste: any[]) {
            return { sortie: liste.filter((e) => e.n >= 5) };
          },
        },
        "test.lire": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            if (ctx.element.url === "d") throw new Error("page illisible");
            return "texte";
          },
        },
      },
    });

  it("progressive: a block error sends the memory (reliabilities already found) before echec", async () => {
    const r = await echecAvis(true);
    expect(r.erreur?.message).toBe("raté");
    expect(memoires(r)).toEqual([
      {
        // a, b, c finished no block sequence: not retained, they will come back.
        nv: { type: "liste.nouveaux", valeur: [["vieille", VIEUX]] },
        avis: { type: "test.avis", valeur: { reutilises: [["Clio", "avis Clio", MAINTENANT], ["208", "avis 208", MAINTENANT]] } },
      },
    ]);
    // Sent after the block's failed end, just before rethrowing the error (so before echec).
    expect(r.traces.at(-1)?.t).toBe("memoire");
    expect(r.traces.at(-2)).toMatchObject({ t: "bloc", id: "avis", etape: "fin", statut: "echoue" });
  });

  it("progressive: memory sent at most every 30 s (fake clock), and the last one before fin", async () => {
    let maintenant = 0;
    const r = await executer({
      progressif: true,
      entree: liste(10).map((e) => ({ ...e, url: `u${e.n}` })),
      horloge: () => maintenant,
      blocs: [{ id: "lent", type: "test.lent", parametres: { champ: "r", reutiliser: "url" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.lent": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            await Promise.resolve();
            maintenant += 10_000;
            return `fait ${ctx.element.n}`;
          },
        },
      },
    });
    expect(r.erreur).toBeNull();
    // Ten 10 s elements, two at a time: the pairs finish at 20, 40, 60, 80, 100 s. Checked at the end of each
    // element and each block, the memory leaves at 40 s (4 opinions) and 80 s (8 opinions) only: not at 20, 60 or 100.
    expect(memoires(r).map((m) => m.lent.valeur.reutilises.length)).toEqual([4, 8]);
    expect((r.resultat!.memoire.lent!.valeur as { reutilises: unknown[] }).reutilises).toHaveLength(10);

    // In the container: the last memory just before fin, as today.
    const c = await lancer({
      workflow: { version: 1, blocs: [bloc("src", "code", { source: "src.mjs" }), sortie], liens: chaine("src", "sortie") },
      fichiers: { "src.mjs": `export default async () => [1];` },
      debut: { progressif: true },
    });
    expect(c.traces.slice(-2).map((l) => l.t)).toEqual(["memoire", "fin"]);
  });

  it("progressive: nouvelles → tri → garder 2 → lire (one failing read) → sortie: the failing listing's key is not retained, those dropped by garder and by the sort are, the two read ones too", async () => {
    const r = await veille(true);
    expect(r.erreur).toBeNull();
    expect(r.resultat!.donnees).toEqual([{ url: "c", note: 9, n: 9, page: "texte" }, { url: "d", note: 9, n: 9 }]);
    // b dropped by the sort, e and f by garder, c read and output; d failed; a seen again takes today's date.
    expect(r.resultat!.memoire.nv!.valeur).toEqual([["a", MAINTENANT], ["b", MAINTENANT], ["c", MAINTENANT], ["e", MAINTENANT], ["f", MAINTENANT]]);
  });

  it("progressive: element not launched for lack of time: its key is not retained", async () => {
    let maintenant = 0;
    const r = await executer({
      progressif: true,
      entree: liste(12).map((e) => ({ ...e, url: `u${e.n}` })),
      horloge: () => maintenant,
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "lent", type: "test.lent", parametres: { champ: "r", budgetSecondes: 1 } },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "test.lent": {
          parElement: "toujours",
          async traiterElement() {
            await Promise.resolve();
            maintenant += 300;
            return "fait";
          },
        },
      },
    });
    expect(r.finBloc("lent")).toMatchObject({ statut: "partiel" });
    expect(r.resultat!.memoire.nv!.valeur).toEqual(["u0", "u1", "u2", "u3"].map((c) => [c, MAINTENANT]));
  });

  it("progressive: element refused by the kernel (ElementNonLance): its key is not retained", async () => {
    const r = await executer({
      progressif: true,
      entree: liste(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "cherche", type: "test.cherche", parametres: { champ: "r" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "test.cherche": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            if (ctx.element.n === 2) throw new ElementNonLance(PLAFOND_RECHERCHES);
            return "ok";
          },
        },
      },
    });
    expect(r.resultat!.memoire.nv!.valeur).toEqual([["u0", MAINTENANT], ["u1", MAINTENANT]]);
  });

  it("without progressive: all the new keys retained and no memory before echec (as before)", async () => {
    const r = await veille(false);
    expect(r.resultat!.memoire.nv!.valeur).toEqual(["a", "b", "c", "d", "e", "f"].map((c) => [c, MAINTENANT]));
    expect(memoires(r)).toEqual([]);

    const ko = await echecAvis(false);
    expect(ko.erreur?.message).toBe("raté");
    expect(memoires(ko)).toEqual([]);
  });

  const lireSaufSur = (echoueSur: string, champ = "url") => ({
    parElement: "toujours",
    async traiterElement(ctx: any) {
      if (ctx.element[champ] === echoueSur) throw new Error("page illisible");
      return "texte";
    },
  });
  const abc = () => ["a", "b", "c"].map((url) => ({ url }));

  it("progressive: code that renames the key field then a failing element: nothing resolved afterwards, b comes back, one log line", async () => {
    const r = await executer({
      progressif: true,
      entree: abc(),
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "remodeler", type: "test.code" },
        { id: "lire", type: "test.lire", parametres: { champ: "page" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "test.code": { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree.map((e: any) => ({ lien: e.url })) }) },
        "test.lire": lireSaufSur("b", "lien"),
      },
    });
    expect(r.erreur).toBeNull();
    expect(r.resultat!.memoire.nv!.valeur).toEqual([]);
    expect(r.journal("nv")).toContain(
      "le champ url n'est plus dans les éléments : un élément en échec n'a pas pu être reconnu, les éléments pas encore résolus reviendront la fois suivante",
    );
  });

  it("progressive: code that renames the key field without a failure afterwards: all retained after the output", async () => {
    const r = await executer({
      progressif: true,
      entree: abc(),
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "remodeler", type: "test.code" },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "test.code": { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree.map((e: any) => ({ lien: e.url })) }) },
      },
    });
    expect(r.resultat!.memoire.nv!.valeur).toEqual(["a", "b", "c"].map((c) => [c, MAINTENANT]));
    expect(r.journal("nv")).toEqual([]);
  });

  it("progressive: code that filters drops b (resolved), c failing further on is not retained", async () => {
    const r = await executer({
      progressif: true,
      entree: abc(),
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "filtrer", type: "test.code" },
        { id: "lire", type: "test.lire", parametres: { champ: "page" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "test.code": { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree.filter((e: any) => e.url !== "b") }) },
        "test.lire": lireSaufSur("c"),
      },
    });
    expect(r.resultat!.donnees).toEqual([{ url: "a", page: "texte" }, { url: "c" }]);
    expect(r.resultat!.memoire.nv!.valeur).toEqual([["a", MAINTENANT], ["b", MAINTENANT]]);
  });

  it("progressive: parallel branches, b dropped by garder on one and failing on the other, is not retained (in both orders)", async () => {
    for (const ordre of [["src", "nv", "garder", "lire", "sortie"], ["src", "nv", "lire", "garder", "sortie"]]) {
      const traces: any[] = [];
      const r = await executerWorkflow({
        workflow: {
          blocs: [
            { id: "src", type: "test.source", parametres: {} },
            { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
            { id: "garder", type: "liste.garder", parametres: { nombre: 1 } },
            { id: "lire", type: "test.lire", parametres: { champ: "page" } },
            { id: "sortie", type: "sortie", parametres: {} },
          ],
          liens: [
            { de: "src", vers: "nv" },
            { de: "nv", vers: "garder" },
            { de: "nv", vers: "lire" },
            { de: "garder", vers: "sortie" },
            { de: "lire", vers: "sortie" },
          ],
          ordre,
        },
        memoire: {},
        maintenant: MAINTENANT,
        dossier: "/nulle-part",
        appeler: async () => null,
        tracer: (m: unknown) => traces.push(m),
        progressif: true,
        blocs: {
          "test.source": { parElement: "non", executer: async () => ({ sortie: abc() }) },
          "liste.nouveaux": listeNouveaux,
          "liste.garder": listeGarder,
          "test.lire": lireSaufSur("b"),
          sortie: { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree }) },
        },
      });
      expect(r.memoire.nv.valeur, ordre.join(",")).toEqual([["a", MAINTENANT], ["c", MAINTENANT]]);
    }
  });

  it("progressive: pending keys are removed before the 5000-key ceiling", async () => {
    const anciennes = Array.from({ length: 5000 }, (_, i) => [`k${i}`, VIEUX]);
    const r = await executer({
      progressif: true,
      entree: [{ url: "x" }],
      memoire: { nv: { type: "liste.nouveaux", valeur: anciennes } },
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "lire", type: "test.lire", parametres: { champ: "page" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: { "liste.nouveaux": listeNouveaux, "test.lire": lireSaufSur("x") },
    });
    // x failing is not retained and does not make k0 forgotten.
    expect(r.resultat!.memoire.nv!.valeur).toEqual(anciennes);
  });

  it("a progressive trial (replay) sends no memory", async () => {
    let maintenant = 0;
    const r = await executer({
      progressif: true,
      entree: null,
      horloge: () => maintenant,
      blocs: [
        { id: "avis", type: "test.avis", parametres: { champ: "avis", siErreur: "echouer" } },
        { id: "sortie", type: "sortie" },
      ],
      registre: {
        "test.avis": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            maintenant += 20_000;
            if (ctx.element.modele === "Panda") throw new Error("raté");
            return "avis";
          },
        },
      },
      rejeu: { relances: ["avis", "sortie"], sorties: { src: [{ modele: "Clio" }, { modele: "208" }, { modele: "Panda" }] } },
    });
    expect(r.erreur?.message).toBe("raté");
    expect(memoires(r)).toEqual([]);
  });

  it("reutiliser: if the in-progress computation of the same key is refused by the kernel, the second element does not relaunch it", async () => {
    const lances: number[] = [];
    const r = await executer({
      entree: [{ modele: "Clio", n: 1 }, { modele: "Clio", n: 2 }],
      blocs: [{ id: "b", type: "test.avis", parametres: { champ: "avis", reutiliser: "modele" } }, { id: "sortie", type: "sortie" }],
      registre: {
        "test.avis": {
          parElement: "toujours",
          async traiterElement(ctx: any) {
            lances.push(ctx.element.n);
            await attendre(10);
            throw new ElementNonLance(PLAFOND_RECHERCHES);
          },
        },
      },
    });
    expect(lances).toEqual([1]);
    expect(r.finBloc("b")).toMatchObject({ statut: "partiel" });
  });
});

describe("interpreter: streaming chain", () => {
  type Evenement = string;
  /** A chainable test block: notes `debut:<block>:<n>` and `fin:<block>:<n>` and returns `<block> <n>`. */
  const etape = (nom: string, evenements: Evenement[], o: { duree?: (n: number) => number; horloge?: { t: number }; echoueSur?: number; tours?: (n: number) => number } = {}) => ({
    parElement: "option",
    async executer(ctx: any) {
      evenements.push(`bloc:${nom}`);
      return { sortie: ctx.entree.map((e: any) => ({ ...e, [ctx.parametres.champ]: `${nom} ${e.n}` })) };
    },
    async traiterElement(ctx: any) {
      const n = ctx.element.n;
      evenements.push(`debut:${nom}:${n}`);
      // A « slow » element waits more micro-task queue turns: it finishes after others launched after it.
      for (let k = 0; k < (o.tours?.(n) ?? 1); k++) await Promise.resolve();
      if (o.horloge && o.duree) o.horloge.t += o.duree(n);
      evenements.push(`fin:${nom}:${n}`);
      if (n === o.echoueSur) throw new Error(`${nom} raté`);
      return `${nom} ${n}`;
    },
  });
  const BLOCS_CHAINE = (sortieParams: Record<string, unknown> = { auFilDeLEau: true }, extra: Record<string, Record<string, unknown>> = {}) => [
    { id: "fiche", type: "test.fiche", parametres: { parElement: true, champ: "page", ...extra.fiche } },
    { id: "fiabilite", type: "test.fiabilite", parametres: { parElement: true, champ: "fiabilite", ...extra.fiabilite } },
    { id: "avis", type: "test.avis", parametres: { parElement: true, champ: "avis", ...extra.avis } },
    { id: "sortie", type: "sortie", parametres: sortieParams },
  ];
  const registreChaine = (evenements: Evenement[], o: Parameters<typeof etape>[2] = {}, parBloc: Record<string, Parameters<typeof etape>[2]> = {}) => ({
    "test.fiche": etape("fiche", evenements, { ...o, ...parBloc.fiche }),
    "test.fiabilite": etape("fiabilite", evenements, { ...o, ...parBloc.fiabilite }),
    "test.avis": etape("avis", evenements, { ...o, ...parBloc.avis }),
  });
  const annonce = (n: number) => ({ n, url: `u${n}`, page: `fiche ${n}`, fiabilite: `fiabilite ${n}`, avis: `avis ${n}` });
  const publications = (r: { traces: any[] }) => r.traces.filter((l) => l.t === "publication");
  const resume = (r: { traces: any[] }) =>
    r.traces.filter((l) => l.t === "bloc").map((l) => `${l.etape}:${l.id}`);

  it("streaming: each listing goes through fiche → fiabilite → avis before being finished, two at a time", async () => {
    const evenements: Evenement[] = [];
    const r = await executer({
      progressif: true,
      entree: liste(6),
      blocs: BLOCS_CHAINE(),
      registre: registreChaine(evenements),
    });
    expect(r.erreur).toBeNull();
    // Each listing passes the three blocks in order.
    for (let n = 0; n < 6; n++) {
      const pos = (e: string) => evenements.indexOf(e);
      expect(pos(`fin:fiche:${n}`)).toBeLessThan(pos(`debut:fiabilite:${n}`));
      expect(pos(`fin:fiabilite:${n}`)).toBeLessThan(pos(`debut:avis:${n}`));
    }
    // Two listings at a time at most: a listing is in progress from the start of its fiche to the end of its avis.
    let enCours = 0;
    let max = 0;
    for (const e of evenements) {
      if (e.startsWith("debut:fiche:")) max = Math.max(max, ++enCours);
      if (e.startsWith("fin:avis:")) enCours--;
    }
    expect(max).toBe(2);
    // The third only starts after one of the first two has finished its avis.
    expect(Math.min(evenements.indexOf("fin:avis:0"), evenements.indexOf("fin:avis:1"))).toBeLessThan(evenements.indexOf("debut:fiche:2"));
    expect(r.resultat!.donnees).toEqual(liste(6).map((e) => ({ ...e, page: `fiche ${e.n}`, fiabilite: `fiabilite ${e.n}`, avis: `avis ${e.n}` })));
  });

  it("publications: elements finished in list order, at most one every 5 s, done and total correct", async () => {
    const evenements: Evenement[] = [];
    const horloge = { t: 0 };
    const traces: any[] = [];
    // Listing 0 is slow (9 s fiche, and more turns): listing 1 finishes before it. The other blocks take 1 s.
    const r = await executer({
      progressif: true,
      entree: liste(10),
      horloge: () => horloge.t,
      blocs: BLOCS_CHAINE(),
      registre: registreChaine(evenements, { horloge, duree: () => 1000 }, { fiche: { horloge, duree: (n) => (n === 0 ? 9000 : 1000), tours: (n) => (n === 0 ? 50 : 1) } }),
    });
    expect(r.erreur).toBeNull();
    traces.push(...r.traces);
    const pubs = publications(r);
    const final = liste(10).map((e) => ({ ...e, page: `fiche ${e.n}`, fiabilite: `fiabilite ${e.n}`, avis: `avis ${e.n}` }));
    expect(pubs.length).toBeGreaterThan(1);
    expect(pubs.length).toBeLessThan(10);
    // The first as soon as the first listing is finished: listing 1, before 0.
    expect(pubs[0]).toEqual({ t: "publication", donnees: [final[1]], faits: 1, total: 10 });
    // Once listing 0 is finished, it comes first: the order is the list's, not the finishes'.
    expect(pubs.at(-1).donnees[0]).toEqual(final[0]);
    let faitsAvant = 0;
    for (const p of pubs) {
      expect(p.total).toBe(10);
      expect(p.faits).toBe(p.donnees.length);
      expect(p.faits).toBeGreaterThan(faitsAvant);
      faitsAvant = p.faits;
      // In list order, as after the last block.
      const ns = p.donnees.map((e: any) => e.n);
      expect(ns).toEqual([...ns].sort((a: number, b: number) => a - b));
      for (const e of p.donnees) expect(e).toEqual(final[e.n]);
    }
    // Each publication right after a memoire line; 5 s at least between two publications (time of the memory
    // sent just before, seen by the trace stream).
    const indices = traces.map((l, i) => (l.t === "publication" ? i : -1)).filter((i) => i >= 0);
    for (const i of indices) expect(traces[i - 1].t).toBe("memoire");
    expect(r.resultat!.donnees).toEqual(final);
  });

  it("publications: never two within 5 s (fake clock time at each publication)", async () => {
    const horloge = { t: 0 };
    const heures: number[] = [];
    const evenements: Evenement[] = [];
    const registre = registreChaine(evenements, { horloge, duree: () => 700 });
    const traces: any[] = [];
    const workflow = {
      blocs: [{ id: "src", type: "test.source", parametres: {} }, ...BLOCS_CHAINE()],
      liens: chaine("src", "fiche", "fiabilite", "avis", "sortie"),
      ordre: ["src", "fiche", "fiabilite", "avis", "sortie"],
    };
    await executerWorkflow({
      workflow,
      memoire: {},
      maintenant: "2026-10-29T10:00:00.000Z",
      dossier: "/nulle-part",
      appeler: async () => null,
      tracer: (m: any) => {
        traces.push(m);
        if (m.t === "publication") heures.push(horloge.t);
      },
      blocs: {
        "test.source": { parElement: "non", executer: async () => ({ sortie: liste(20) }) },
        sortie: { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree }) },
        ...registre,
      },
      horloge: () => horloge.t,
      progressif: true,
    });
    expect(heures[0]).toBeLessThan(5000);
    for (let i = 1; i < heures.length; i++) expect(heures[i]! - heures[i - 1]!).toBeGreaterThanOrEqual(5000);
    // 20 listings of 2.1 s two at a time (~21 s): several publications, not one per listing.
    expect(heures.length).toBeGreaterThanOrEqual(3);
    expect(heures.length).toBeLessThanOrEqual(6);
  });

  it("traces: debut of the three blocks then their ends in order; each block's output = the list after it", async () => {
    const r = await executer({ progressif: true, entree: liste(3), blocs: BLOCS_CHAINE(), registre: registreChaine([]) });
    expect(resume(r)).toEqual([
      "debut:src", "fin:src",
      "debut:fiche", "debut:fiabilite", "debut:avis",
      "fin:fiche", "fin:fiabilite", "fin:avis",
      "debut:sortie", "fin:sortie",
    ]);
    expect(r.finBloc("fiche")).toEqual({ t: "bloc", id: "fiche", etape: "fin", statut: "reussi", sortie: liste(3).map((e) => ({ ...e, page: `fiche ${e.n}` })) });
    expect(r.finBloc("fiabilite").sortie).toEqual(liste(3).map((e) => ({ ...e, page: `fiche ${e.n}`, fiabilite: `fiabilite ${e.n}` })));
    expect(r.finBloc("avis")).toMatchObject({ statut: "reussi", sortie: r.resultat!.donnees });
    expect(r.finBloc("sortie").sortie).toEqual(liste(3).map((e) => ({ ...e, page: `fiche ${e.n}`, fiabilite: `fiabilite ${e.n}`, avis: `avis ${e.n}` })));
  });

  it("fiche's budgetSecondes counted from the start of the chain: the following listings pass without a page, partial", async () => {
    const evenements: Evenement[] = [];
    const horloge = { t: 0 };
    // fiche takes no time, fiabilite 600 ms: past 1 s since the start of the chain, no more fiche.
    const r = await executer({
      progressif: true,
      entree: liste(5),
      horloge: () => horloge.t,
      blocs: BLOCS_CHAINE({ auFilDeLEau: true }, { fiche: { budgetSecondes: 1 } }),
      registre: registreChaine(evenements, {}, { fiabilite: { horloge, duree: () => 600 } }),
    });
    expect(r.erreur).toBeNull();
    expect(evenements.filter((e) => e.startsWith("debut:fiche:"))).toEqual(["debut:fiche:0", "debut:fiche:1"]);
    expect(evenements.filter((e) => e.startsWith("debut:avis:"))).toHaveLength(5);
    expect(r.finBloc("fiche")).toMatchObject({ statut: "partiel" });
    expect(r.journal("fiche")).toContain("temps écoulé : 3 élément(s) non lancé(s)");
    expect(r.finBloc("fiabilite")).toMatchObject({ statut: "reussi" });
    expect(r.finBloc("avis")).toMatchObject({ statut: "reussi" });
    expect(r.resultat!.donnees).toEqual(
      liste(5).map((e) => (e.n < 2 ? { ...e, page: `fiche ${e.n}` } : { ...e }) ).map((e) => ({ ...e, fiabilite: `fiabilite ${e.n}`, avis: `avis ${e.n}` })),
    );
  });

  it("without auFilDeLEau: calls and traces block by block, identical to today", async () => {
    const evenements: Evenement[] = [];
    const r = await executer({ progressif: true, entree: liste(3), blocs: BLOCS_CHAINE({}), registre: registreChaine(evenements) });
    expect(r.erreur).toBeNull();
    const debuts = evenements.filter((e) => e.startsWith("debut:"));
    expect(debuts.slice(0, 3).every((e) => e.startsWith("debut:fiche:"))).toBe(true);
    expect(debuts.slice(3, 6).every((e) => e.startsWith("debut:fiabilite:"))).toBe(true);
    expect(debuts.slice(6).every((e) => e.startsWith("debut:avis:"))).toBe(true);
    expect(resume(r)).toEqual([
      "debut:src", "fin:src", "debut:fiche", "fin:fiche", "debut:fiabilite", "fin:fiabilite", "debut:avis", "fin:avis", "debut:sortie", "fin:sortie",
    ]);
    expect(publications(r)).toEqual([]);
  });

  it("without progressive (a run that is not progressive): block by block, no publication", async () => {
    const evenements: Evenement[] = [];
    const r = await executer({ entree: liste(3), blocs: BLOCS_CHAINE(), registre: registreChaine(evenements) });
    expect(resume(r)).toEqual([
      "debut:src", "fin:src", "debut:fiche", "fin:fiche", "debut:fiabilite", "fin:fiabilite", "debut:avis", "fin:avis", "debut:sortie", "fin:sortie",
    ]);
    expect(publications(r)).toEqual([]);
  });

  it("trial (replay) of an auFilDeLEau workflow: block by block, no publication", async () => {
    const evenements: Evenement[] = [];
    const r = await executer({
      progressif: true,
      entree: liste(3),
      blocs: BLOCS_CHAINE(),
      registre: registreChaine(evenements),
      rejeu: { relances: ["src", "fiche", "fiabilite", "avis", "sortie"], sorties: {} },
    });
    expect(r.erreur).toBeNull();
    expect(resume(r)).toEqual([
      "debut:src", "fin:src", "debut:fiche", "fin:fiche", "debut:fiabilite", "fin:fiabilite", "debut:avis", "fin:avis", "debut:sortie", "fin:sortie",
    ]);
    expect(evenements.indexOf("fin:fiche:2")).toBeLessThan(evenements.indexOf("debut:fiabilite:0"));
    expect(publications(r)).toEqual([]);
  });

  it("auFilDeLEau behind liste.garder: no publication, output at the end", async () => {
    const evenements: Evenement[] = [];
    const [fiche, fiabilite, avis, s] = BLOCS_CHAINE();
    const r = await executer({
      progressif: true,
      entree: liste(4),
      blocs: [fiche!, fiabilite!, avis!, { id: "garder", type: "liste.garder", parametres: { nombre: 2 } }, s!],
      registre: { ...registreChaine(evenements), "liste.garder": listeGarder },
    });
    expect(r.erreur).toBeNull();
    expect(publications(r)).toEqual([]);
    expect(resume(r)).toEqual([
      "debut:src", "fin:src", "debut:fiche", "fin:fiche", "debut:fiabilite", "fin:fiabilite", "debut:avis", "fin:avis",
      "debut:garder", "fin:garder", "debut:sortie", "fin:sortie",
    ]);
    expect(r.resultat!.donnees).toHaveLength(2);
  });

  it("a failing element in the chain (sauter) is finished without the field, it is published; the block ends partial", async () => {
    const r = await executer({
      progressif: true,
      entree: liste(3),
      blocs: BLOCS_CHAINE(),
      registre: registreChaine([], {}, { fiabilite: { echoueSur: 1 } }),
    });
    expect(r.erreur).toBeNull();
    expect(r.finBloc("fiabilite")).toMatchObject({ statut: "partiel" });
    expect(r.finBloc("fiche")).toMatchObject({ statut: "reussi" });
    expect(r.journal("fiabilite").join("\n")).toContain("élément 2 : fiabilite raté");
    expect(r.resultat!.donnees).toEqual([
      { n: 0, page: "fiche 0", fiabilite: "fiabilite 0", avis: "avis 0" },
      { n: 1, page: "fiche 1", avis: "avis 1" },
      { n: 2, page: "fiche 2", fiabilite: "fiabilite 2", avis: "avis 2" },
    ]);
  });

  it("siErreur echouer in the chain: the block concerned fails, the others of the chain end partial, then memory and error", async () => {
    const r = await executer({
      progressif: true,
      entree: liste(4),
      blocs: BLOCS_CHAINE({ auFilDeLEau: true }, { fiabilite: { siErreur: "echouer" } }),
      registre: registreChaine([], {}, { fiabilite: { echoueSur: 1 } }),
    });
    expect(r.erreur?.message).toBe("fiabilite raté");
    const fins = r.traces.filter((l) => l.t === "bloc" && l.etape === "fin" && l.id !== "src");
    expect(fins.map((l) => [l.id, l.statut])).toEqual([["fiche", "partiel"], ["fiabilite", "echoue"], ["avis", "partiel"]]);
    expect(r.finBloc("fiabilite").erreur).toBe("fiabilite raté");
    expect(r.traces.some((l) => l.id === "sortie")).toBe(false);
    expect(r.traces.at(-1)?.t).toBe("memoire");
  });

  it("keys: a listing that reached the end of the chain is retained in the memory sent before its publication; a failing listing is not", async () => {
    const r = await executer({
      progressif: true,
      entree: liste(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocs: [{ id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } }, ...BLOCS_CHAINE()],
      registre: { "liste.nouveaux": listeNouveaux, ...registreChaine([], {}, { avis: { echoueSur: 1 } }) },
    });
    expect(r.erreur).toBeNull();
    const pubs = r.traces.map((l, i) => [l, i] as const).filter(([l]) => l.t === "publication");
    // The first publication (u0 alone) follows a memory that already retains u0.
    const [premiere, i] = pubs[0]!;
    expect(premiere.donnees.map((e: any) => e.url)).toEqual(["u0"]);
    expect(r.traces[i - 1].memoire.nv.valeur.map((e: any) => e[0])).toEqual(["u0"]);
    // At the end: u0 and u2 retained, u1 (failing opinion) will come back.
    expect((r.resultat!.memoire.nv!.valeur as [string, string][]).map((e) => e[0])).toEqual(["u0", "u2"]);
  });

  it("keys: an element finished less than 5 s after a publication, then an echouer: its key is not in the last memory", async () => {
    const evenements: Evenement[] = [];
    const r = await executer({
      progressif: true,
      horloge: () => 0,
      entree: liste(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocs: [{ id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } }, ...BLOCS_CHAINE({ auFilDeLEau: true }, { fiabilite: { siErreur: "echouer" } })],
      registre: { "liste.nouveaux": listeNouveaux, ...registreChaine(evenements, {}, { fiabilite: { echoueSur: 2 } }) },
    });
    expect(r.erreur?.message).toBe("fiabilite raté");
    // u0 published; u1 finished afterwards (not published, under 5 s); then u2 fails.
    expect(publications(r).map((p) => p.donnees.map((e: any) => e.url))).toEqual([["u0"]]);
    expect(evenements.indexOf("fin:avis:1")).toBeGreaterThanOrEqual(0);
    expect(evenements.indexOf("fin:avis:1")).toBeLessThan(evenements.indexOf("fin:fiabilite:2"));
    const derniere = r.traces.filter((l) => l.t === "memoire").at(-1);
    expect(r.traces.at(-1)).toBe(derniere);
    // u1 was never shown: it comes back next time.
    expect(derniere.memoire.nv.valeur.map((e: any) => e[0])).toEqual(["u0"]);
  });

  it("a publication over 2 MB (TAILLE_MAX_DONNEES) is not sent, and none of its keys is retained before the end of the chain", async () => {
    const evenements: Evenement[] = [];
    const horloge = { t: 0 };
    const gros = "x".repeat(1.2 * 1024 * 1024);
    // u0 finishes fast and is published alone (1.2 MB); u1, slow, finishes more than 5 s later: [u0, u1] would be 2.4 MB.
    const r = await executer({
      progressif: true,
      horloge: () => horloge.t,
      entree: liste(2).map((e) => ({ ...e, url: `u${e.n}`, gros })),
      blocs: [{ id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } }, ...BLOCS_CHAINE()],
      registre: {
        "liste.nouveaux": listeNouveaux,
        ...registreChaine(evenements, {}, { fiche: { horloge, duree: (n) => (n === 1 ? 9000 : 1000), tours: (n) => (n === 1 ? 50 : 1) } }),
      },
    });
    expect(r.erreur).toBeNull();
    expect(publications(r).map((p) => p.donnees.map((e: any) => e.url))).toEqual([["u0"]]);
    // Until the end of the chain, no memory retains u1 (never shown by a publication).
    const finChaine = r.traces.findIndex((l) => l.t === "bloc" && l.etape === "fin" && l.id === "fiche");
    const memoires = r.traces.slice(0, finChaine).filter((l) => l.t === "memoire");
    expect(memoires.length).toBeGreaterThan(0);
    for (const m of memoires) expect((m.memoire.nv?.valeur ?? []).map((e: any) => e[0])).not.toContain("u1");
    // The output shows everything: u1 is retained at the end.
    expect((r.resultat!.memoire.nv!.valeur as any[]).map((e) => e[0])).toEqual(["u0", "u1"]);
  });

  it("keys: the memory sent by verifierMemoire after the chain does not retain an element finished but not published; the output does", async () => {
    const horloge = { t: 0 };
    const traces: any[] = [];
    const r = await executerWorkflow({
      workflow: {
        // « lent », without a link, runs between the chain (fiche) and the output, and takes 40 s.
        blocs: [
          { id: "src", type: "test.source", parametres: {} },
          { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
          { id: "fiche", type: "test.fiche", parametres: { parElement: true, champ: "page" } },
          { id: "lent", type: "test.lent", parametres: {} },
          { id: "sortie", type: "sortie", parametres: { auFilDeLEau: true } },
        ],
        liens: chaine("src", "nv", "fiche", "sortie"),
        ordre: ["src", "nv", "fiche", "lent", "sortie"],
      },
      memoire: {},
      maintenant: "2026-10-29T10:00:00.000Z",
      dossier: "/nulle-part",
      appeler: async () => null,
      tracer: (m: any) => traces.push(m),
      blocs: {
        "test.source": { parElement: "non", executer: async () => ({ sortie: [{ n: 0, url: "u0" }, { n: 1, url: "u1" }] }) },
        "liste.nouveaux": listeNouveaux,
        "test.fiche": etape("fiche", []),
        "test.lent": {
          parElement: "non",
          async executer() {
            horloge.t += 40_000;
            return { sortie: null };
          },
        },
        sortie: { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree }) },
      },
      horloge: () => horloge.t,
      progressif: true,
    });
    expect(traces.filter((l) => l.t === "publication").map((p) => p.donnees.map((e: any) => e.url))).toEqual([["u0"]]);
    const iLent = traces.findIndex((l) => l.t === "bloc" && l.id === "lent" && l.etape === "fin");
    const apresLent = traces[iLent + 1];
    expect(apresLent.t).toBe("memoire");
    expect(apresLent.memoire.nv.valeur.map((e: any) => e[0])).toEqual(["u0"]);
    expect(r.memoire.nv.valeur.map((e: any) => e[0])).toEqual(["u0", "u1"]);
  });

  it("keys: the key lost before the chain then a failing element in the chain: nothing more is retained (R31)", async () => {
    const r = await executer({
      progressif: true,
      entree: liste(3).map((e) => ({ ...e, url: `u${e.n}` })),
      blocs: [
        { id: "nv", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "remodeler", type: "test.remodeler" },
        ...BLOCS_CHAINE(),
      ],
      registre: {
        "liste.nouveaux": listeNouveaux,
        "test.remodeler": { parElement: "non", executer: async (ctx: any) => ({ sortie: ctx.entree.map((e: any) => ({ n: e.n, adresse: e.url })) }) },
        ...registreChaine([], {}, { avis: { echoueSur: 0 } }),
      },
    });
    expect(r.erreur).toBeNull();
    expect(r.resultat!.memoire.nv!.valeur).toEqual([]);
    expect(r.journal("nv").join("\n")).toContain("n'est plus dans les éléments");
  });

  it("in the container: progressive debut and auFilDeLEau output, the publication lines come before fin", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [
          bloc("src", "code", { source: "src.mjs" }),
          bloc("fiche", "source.page", { url: "https://x.fr/{url}", parElement: true, champ: "page" }),
          bloc("sortie", "sortie", { vers: "widget", auFilDeLEau: true }),
        ],
        liens: chaine("src", "fiche", "sortie"),
      },
      fichiers: { "src.mjs": `export default async () => [{ url: "a" }, { url: "b" }];` },
      repondre: (a) => ({ ok: { url: a.a.url, titre: "T", texte: "texte", liens: [] } }),
      debut: { progressif: true },
    });
    expect(r.code).toBe(0);
    const pub = r.lignes.find((l) => l.t === "publication");
    expect(pub).toMatchObject({ t: "publication", faits: 1, total: 2 });
    expect(r.lignes.indexOf(pub)).toBeLessThan(r.lignes.findIndex((l) => l.t === "fin"));
    expect(r.terminal.donnees).toHaveLength(2);
  });
});
