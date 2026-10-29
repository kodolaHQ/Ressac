import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dossierTemporaire } from "../aide/temporaire.js";
import type { MemoireBlocs } from "../../src/workflows/memoire.js";
import { workflowImplicite } from "../../src/workflows/valider.js";
import { MOTEUR, SCRIPT, bloc, chaine, lancer, sortie } from "../aide/moteur.js";

// Le moteur est du JavaScript du conteneur : importé tel quel, sans types.
const { executerWorkflow } = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);
const { default: listeNouveaux } = await import(pathToFileURL(join(MOTEUR, "blocs", "liste-nouveaux.mjs")).href);

describe("interpréteur (dans le conteneur)", () => {
  it("exécute les blocs dans l'ordre et envoie debut puis fin de chaque bloc avant fin", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        // Dans le désordre du tableau : l'ordre vient des liens.
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

  it("un bloc à plusieurs entrées reçoit { id: sortie }", async () => {
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

  it("code reçoit (entree, webaios) avec config, precedent, maintenant, journal ; ses lignes de journal sont rattachées au bloc et vont aussi sur stderr", async () => {
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

  it("code avec appel: recolte appelle default(webaios) comme aujourd'hui", async () => {
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

  it("une erreur levée par le code finit le bloc échoué et l'exécution en echec avec le même message", async () => {
    const r = await lancer({
      workflow: { version: 1, blocs: [bloc("recolte", "code", { source: "recolte.mjs", appel: "recolte" }), sortie], liens: chaine("recolte", "sortie") },
      fichiers: { "recolte.mjs": `export default async () => { throw new Error("boum"); };` },
    });
    expect(r.finBloc("recolte")).toEqual({ t: "bloc", id: "recolte", etape: "fin", statut: "echoue", erreur: "boum" });
    expect(r.terminal).toEqual({ t: "echec", erreur: "boum" });
    expect(r.lignes.some((l) => l.t === "memoire")).toBe(false);
  });

  it("un fichier code absent fait échouer le bloc, les suivants sont pas lancés, puis echec", async () => {
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

  it("liste.nouveaux ne garde que les clés jamais vues et retient au plus 5000 clés", async () => {
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
    // Les clés vues cette fois sont les plus récentes ; les plus anciennes jamais revues sont oubliées.
    expect(m.valeur.slice(-4)).toEqual(["k4999", "neuf", "k0", "autre"]);
    expect(m.valeur).not.toContain("k1");
    expect(m.valeur).not.toContain("k2");
    expect(m.valeur).toContain("k3");
  });

  it("liste.nouveaux : un doublon dans la même liste n'est pas nouveau ; une clé longue est gardée coupée à 500 caractères", async () => {
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
    expect(r.lignes.find((l) => l.t === "memoire").memoire.nv.valeur).toEqual(["a", "b", "u".repeat(500)]);
  });

  it("liste.dedoublonner : doublon sur l'une des clés normalisées (utm_, www., / final ; accents et casse du titre)", async () => {
    const elements = [
      { titre: "Été à Paris", url: "https://www.a.fr/x/?utm_source=rss&id=1" },
      { titre: "Autre", url: "https://a.fr/x?id=1" }, // même URL normalisée
      { titre: "ete a paris!", url: "https://b.fr/y" }, // même titre normalisé
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

  it("liste.garder garde les N premiers ; une entrée qui n'est pas une liste fait échouer le bloc", async () => {
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

  it("la mémoire envoyée avant fin ne contient que les blocs du workflow, avec leur type ; une mémoire d'un autre type est ignorée", async () => {
    const r = await lancer({
      workflow: {
        version: 1,
        blocs: [bloc("src", "code", { source: "src.mjs" }), bloc("nv", "liste.nouveaux", { cle: "id" }), sortie],
        liens: chaine("src", "nv", "sortie"),
      },
      memoire: {
        // Même id, autre type : ignorée (tout est nouveau).
        nv: { type: "liste.dedoublonner", valeur: ["1"] },
        // Bloc qui n'existe plus : oubliée.
        ancien: { type: "liste.nouveaux", valeur: ["z"] },
        // Bloc présent, même type, sans nouvelle valeur : gardée telle quelle.
        src: { type: "code", valeur: { garde: true } },
      },
      fichiers: { "src.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` },
    });
    expect(r.terminal.donnees).toEqual([{ id: 1 }, { id: 2 }]);
    const lignes = r.lignes.map((l) => l.t);
    expect(lignes.indexOf("memoire")).toBe(lignes.indexOf("fin") - 1);
    expect(r.lignes.find((l) => l.t === "memoire").memoire).toEqual({
      src: { type: "code", valeur: { garde: true } },
      nv: { type: "liste.nouveaux", valeur: ["1", "2"] },
    });
  });

  it("une sortie de bloc trop grosse pour une ligne est envoyée sans sortie, avec sortieTropGrosse", async () => {
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

  it("un debut sans workflow est refusé : recolte.mjs ne tourne plus hors workflow", async () => {
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

  it("le workflow implicite d'un recolte.mjs : default(webaios) avec la config de debut, journal sur stderr", async () => {
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

describe("interpréteur : rejeu depuis un bloc", () => {
  it("avec rejeu, seuls les blocs relancés sont tracés, dans l'ordre, et reçoivent les sorties reprises", async () => {
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
    // Aucune trace pour src, et aucune mémoire rendue : le noyau n'en garde pas pour un essai.
    expect(r.traces.map((l) => (l.t === "bloc" ? `${l.etape}:${l.id}` : l.t))).toEqual([
      "debut:b", "fin:b",
      "debut:sortie", "fin:sortie",
      "fin",
    ]);
    expect(r.terminal).toEqual({ t: "fin", donnees: { recu: [1, 2] } });
  });

  it("un bloc relancé à deux entrées reçoit { id: sortie } mêlant reprise et relance", async () => {
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

  it("sans le bloc sortie parmi les relancés, les données sont null", async () => {
    const r = await lancer({
      workflow: { version: 1, blocs: [bloc("a", "code", { source: "a.mjs" }), sortie], liens: chaine("a", "sortie") },
      fichiers: { "a.mjs": `export default async () => "a";` },
      rejeu: { relances: ["a"], sorties: {} },
    });
    expect(r.terminal).toEqual({ t: "fin", donnees: null });
    expect(r.finBloc("sortie")).toBeUndefined();
  });

  it("avec rejeu, l'interpréteur ignore la mémoire reçue : liste.nouveaux laisse tout passer, reutiliser ne reprend rien, aucun bloc ne rend de mémoire", async () => {
    // Le noyau envoie une mémoire vide pour un essai ; l'interpréteur ne s'y fie pas : même une mémoire reçue
    // (y compris celle d'un bloc non relancé) n'est ni lue ni rendue.
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

/** Exécution directe de l'interpréteur, avec un registre de blocs de test. */
async function executer(o: {
  blocs: { id: string; type: string; parametres?: Record<string, unknown> }[];
  registre: Record<string, unknown>;
  entree: unknown;
  memoire?: MemoireBlocs;
  echeance?: number;
  horloge?: () => number;
  rejeu?: { relances: string[]; sorties: Record<string, unknown> };
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
      tracer: (m: unknown) => traces.push(m),
      blocs: registre,
      ...(o.echeance !== undefined ? { echeance: o.echeance } : {}),
      ...(o.horloge ? { horloge: o.horloge } : {}),
      ...(o.rejeu ? { rejeu: o.rejeu } : {}),
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

describe("interpréteur : blocs par élément", () => {
  it("par élément : deux éléments à la fois, résultat sous champ, ordre gardé", async () => {
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
            // Les premiers finissent après les suivants : l'ordre de la sortie reste celui de l'entrée.
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

  it("par élément « option » : sans parElement, executer tourne une fois sur toute l'entrée", async () => {
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

  it("par élément : une entrée qui n'est pas une liste fait échouer le bloc", async () => {
    const r = await executer({
      entree: { pas: "liste" },
      blocs: [{ id: "b", type: "test.x", parametres: { champ: "x" } }, { id: "sortie", type: "sortie" }],
      registre: { "test.x": { parElement: "toujours", traiterElement: async () => 1 } },
    });
    expect(r.erreur?.message).toBe("liste attendue en entrée");
    expect(r.finBloc("b")).toMatchObject({ statut: "echoue", erreur: "liste attendue en entrée" });
  });

  it("par élément : un élément en échec est sauté, le bloc finit partiel ; siErreur echouer fait échouer le bloc", async () => {
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

  it("par élément : tous les éléments en échec font échouer un bloc qui le demande, même avec sauter ; les autres finissent partiel ; une liste vide n'est pas un échec", async () => {
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

  it("par élément : une valeur de gabarit absente laisse l'élément sans champ, sans erreur ; en mode simple la sortie est null", async () => {
    const registre = {
      "test.gabarit": {
        parElement: "option",
        executer: async (ctx: any) => ({ sortie: ctx.remplir("{config.ville}").texte }),
        traiterElement: async (ctx: any) => ctx.remplir("url={url}", { url: true }).texte,
      },
    };
    const parElement = await executer({
      // Une ancienne valeur sous `champ` ne survit pas à un élément sans valeur cette fois.
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

  it("budgetSecondes : passé le temps, plus aucun élément lancé, les suivants sans champ, bloc partiel", async () => {
    // Horloge simulée : chaque élément « dure » 300 ms, la fin de l'élément avance l'heure.
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
    // Les deux éléments en cours finissent avant la vérification suivante : paires lancées à 0 et 600 ; à 1200, plus rien.
    expect(lances).toEqual([0, 1, 2, 3]);
    const sortie = r.resultat!.donnees as { n: number; r?: string }[];
    expect(sortie.filter((e) => e.r === "fait").map((e) => e.n)).toEqual([0, 1, 2, 3]);
    expect(sortie.slice(4).every((e) => !("r" in e))).toBe(true);
    expect(r.finBloc("b")).toMatchObject({ statut: "partiel" });
    expect(r.journal("b")).toContain("temps écoulé : 8 élément(s) non lancé(s)");
  });

  it("le temps global (150 s depuis debut) arrête aussi de lancer des éléments", async () => {
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
    // Paires lancées à 0 et 200 ; à 400, plus rien.
    expect(lances).toBe(4);
    expect(r.finBloc("b")).toMatchObject({ statut: "partiel" });
  });

  it("parmi les éléments lancés, aucun réussi et au moins un en échec : le bloc échoue (non lancés et valeurs absentes ne comptent pas)", async () => {
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

  it("reutiliser reprend la valeur de la mémoire sans appel et range les nouvelles", async () => {
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
    // Les valeurs reprises ou calculées sont les plus récentes ; un élément sans clé n'est pas rangé.
    expect(r.resultat!.memoire.b).toEqual({
      type: "test.resume",
      valeur: { reutilises: [["https://vieux.fr/", "vieux"], ["https://a.fr/1", "déjà fait"], ["https://a.fr/2", "résumé de https://a.fr/2"]] },
    });
  });

  it("reutiliser garde au plus 2 Mo par bloc, en oubliant les plus anciennes", async () => {
    const gros = "x".repeat(600 * 1024);
    const r = await executer({
      entree: liste(5).map((e) => ({ ...e, cle: `k${e.n}` })),
      blocs: [{ id: "b", type: "test.gros", parametres: { champ: "g", reutiliser: "cle" } }, { id: "sortie", type: "sortie" }],
      registre: { "test.gros": { parElement: "toujours", traiterElement: async () => gros } },
    });
    const gardees = (r.resultat!.memoire.b!.valeur as { reutilises: [string, string][] }).reutilises.map(([k]) => k);
    expect(gardees).toEqual(["k2", "k3", "k4"]);
  });

  it("toute la mémoire envoyée tient en 2,5 Mo : les plus anciennes valeurs du plus gros bloc partent d'abord", async () => {
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
    // Chacun borné à 2 Mo (4 gardées), puis le plus gros perd sa plus ancienne, tour à tour.
    expect(cles("b1")).toEqual(["k3", "k4"]);
    expect(cles("b2")).toEqual(["k2", "k3", "k4"]);
  });

  it("finaliser reçoit la liste enrichie et rend la sortie du bloc", async () => {
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

  it("un bloc simple peut finir partiel ; un type sans module échoue « type inconnu dans le conteneur »", async () => {
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
