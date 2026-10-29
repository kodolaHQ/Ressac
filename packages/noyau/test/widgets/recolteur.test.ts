import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dossierTemporaire } from "../aide/temporaire.js";
import { workflowImplicite } from "../../src/workflows/valider.js";
import { pathToFileURL } from "node:url";
import { MOTEUR, bloc, chaine, lancer as lancerWorkflow, sortie, workflowEnvoye } from "../aide/moteur.js";

const { LIMITE_GLOBALE_MS, echeanceDe } = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);

const SCRIPT = join(import.meta.dirname, "..", "..", "docker", "moteur", "recolteur.mjs");

type Appel = { t: "appel"; n: number; f: string; a: any };
type Repondeur = (appel: Appel) => Promise<{ ok: unknown } | { erreur: string }> | { ok: unknown } | { erreur: string };

/** Un widget qui n'a que `recolte.mjs` (comme le Gmail de l'utilisateur), lancé comme le noyau le fait. */
async function lancer(code: string, repondre: Repondeur = () => ({ ok: null }), config: unknown = {}) {
  const dossier = await dossierTemporaire();
  await writeFile(join(dossier, "recolte.mjs"), code);
  const enfant = spawn("node", [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  enfant.stderr.on("data", (d) => (stderr += d));
  const lignes: any[] = [];
  const appels: Appel[] = [];
  let tampon = "";
  const fini = new Promise<void>((ok) => enfant.on("close", () => ok()));
  enfant.stdout.on("data", (d) => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const ligne = tampon.slice(0, i);
      tampon = tampon.slice(i + 1);
      const m = JSON.parse(ligne);
      lignes.push(m);
      if (m.t === "appel") {
        appels.push(m);
        void Promise.resolve(repondre(m)).then((r) => enfant.stdin.write(JSON.stringify({ t: "reponse", n: m.n, ...r }) + "\n"));
      }
    }
  });
  enfant.stdin.write(
    JSON.stringify({ t: "debut", precedent: { v: 1 }, maintenant: "2026-10-28T10:00:00.000Z", config, workflow: workflowEnvoye(workflowImplicite()) }) + "\n",
  );
  enfant.stdin.write(JSON.stringify({ t: "memoire", memoire: {} }) + "\n");
  await fini;
  return { lignes, appels, stderr, terminal: lignes.find((l) => l.t === "fin" || l.t === "echec") };
}

describe("recolteur (workflow implicite d'un recolte.mjs seul)", () => {
  it("un recolte.mjs qui rend des données produit { t: fin }", async () => {
    const r = await lancer(
      `export default async (w) => ({ cfg: w.config, prec: w.precedent, quand: w.maintenant });`,
      undefined,
      { a: 1 },
    );
    expect(r.terminal).toEqual({
      t: "fin",
      donnees: { cfg: { a: 1 }, prec: { v: 1 }, quand: "2026-10-28T10:00:00.000Z" },
    });
  });

  it("lirePage et kev passent par des appels numérotés et reçoivent la réponse", async () => {
    const r = await lancer(
      `export default async (w) => {
        const p = await w.lirePage("https://a.fr/", { compte: true });
        const k = await w.kev("etat", { q: { type: "noul" } });
        return { p, k };
      };`,
      (a) =>
        a.f === "lirePage"
          ? { ok: { url: a.a.url, titre: "T", texte: "x", liens: [] } }
          : { ok: { q: { type: "noul", noul: 0.9 } } },
    );
    expect(r.appels.map((a) => [a.n, a.f])).toEqual([[1, "lirePage"], [2, "kev"]]);
    expect(r.appels[0]!.a).toEqual({ url: "https://a.fr/", compte: true });
    expect(r.appels[1]!.a).toEqual({ state: "etat", questions: { q: { type: "noul" } } });
    expect(r.terminal.donnees.k).toEqual({ q: { type: "noul", noul: 0.9 } });
    expect(r.terminal.donnees.p.titre).toBe("T");
  });

  it("une exception du widget donne { t: echec } avec le message", async () => {
    const r = await lancer(`export default async () => { throw new Error("boum"); };`);
    expect(r.terminal).toEqual({ t: "echec", erreur: expect.stringContaining("boum") });
  });

  it("un résultat qui n'est pas du JSON donne echec", async () => {
    const r = await lancer(`export default async () => () => 1;`);
    expect(r.terminal.t).toBe("echec");
  });

  it("une réponse { erreur } du noyau devient une exception dans le widget", async () => {
    const r = await lancer(
      `export default async (w) => { try { await w.recuperer("https://x.fr/"); } catch (e) { return { attrape: e.message }; } };`,
      () => ({ erreur: "domaine refusé" }),
    );
    expect(r.terminal).toEqual({ t: "fin", donnees: { attrape: "domaine refusé" } });
  });

  it("lireFlux lit un RSS 2.0 et un Atom (CDATA, entités)", async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Mon &amp; flux</title>
      <item><title><![CDATA[Salut <b>toi</b>]]></title><link>https://a.fr/1</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate><description>R&eacute;sum&#233; &lt;ok&gt; &quot;q&quot; it&apos;s</description></item>
      <item><title>Deux</title><link>https://a.fr/2</link></item></channel></rss>`;
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atome</title>
      <entry><title>Un</title><link rel="alternate" href="https://b.fr/1"/><updated>2026-10-27T08:00:00Z</updated><summary><![CDATA[Le <i>résumé</i>]]></summary></entry></feed>`;
    const r = await lancer(
      `export default async (w) => ({ rss: await w.lireFlux("https://a.fr/rss"), atom: await w.lireFlux("https://b.fr/atom") });`,
      (a) => {
        expect(a.f).toBe("recuperer");
        expect(a.a).toEqual({ url: expect.any(String), format: "texte" });
        return { ok: a.a.url.includes("a.fr") ? rss : atom };
      },
    );
    const d = r.terminal.donnees;
    expect(d.rss).toHaveLength(2);
    expect(d.rss[0]).toMatchObject({ titre: "Salut <b>toi</b>", url: "https://a.fr/1", date: "Mon, 26 Oct 2026 10:00:00 GMT" });
    expect(d.rss[0].resume).toContain('<ok> "q" it\'s');
    expect(d.rss[1].titre).toBe("Deux");
    expect(d.atom).toEqual([
      { titre: "Un", url: "https://b.fr/1", date: "2026-10-27T08:00:00Z", resume: "Le <i>résumé</i>" },
    ]);
  });

  it("trier pose une question noul par élément avec l'élément dans state, au plus 8 à la fois, et filtre par seuil", async () => {
    let enCours = 0;
    let max = 0;
    const r = await lancer(
      `export default async (w) => {
        const els = Array.from({ length: 20 }, (_, i) => ({ id: i, t: "el" + i }));
        return await w.trier(els, { question: "intéressant ?", texte: (e) => e.t, seuil: 0.5 });
      };`,
      async (a) => {
        enCours++;
        max = Math.max(max, enCours);
        await new Promise((ok) => setTimeout(ok, 15));
        enCours--;
        const i = Number(a.a.state.slice(2));
        return { ok: { q: { type: "noul", noul: i / 20 } } };
      },
    );
    expect(r.appels).toHaveLength(20);
    expect(r.appels.every((a) => a.f === "kev" && /^el\d+$/.test(a.a.state))).toBe(true);
    expect(Object.values(r.appels[0]!.a.questions)[0]).toEqual({ type: "noul", instructions: "intéressant ?" });
    expect(JSON.stringify(r.appels[0]!.a.questions)).not.toContain("el0");
    expect(max).toBeLessThanOrEqual(8);
    expect(max).toBeGreaterThan(1);
    const res = r.terminal.donnees as { element: { id: number }; p: number }[];
    expect(res.map((x) => x.element.id)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10]);
    expect(res[0]!.p).toBeCloseTo(0.95);
  });

  it("une réponse de plus de 4 Mo rejette l'appel concerné avec une erreur claire", async () => {
    const r = await lancer(
      `export default async (w) => { try { await w.recuperer("https://x.fr/"); } catch (e) { return { attrape: e.message }; } };`,
      () => ({ ok: "x".repeat(4 * 1024 * 1024 + 10) }),
    );
    expect(r.terminal.donnees.attrape).toContain("Réponse trop grande");
  });

  it("journal écrit sur stderr, jamais sur stdout", async () => {
    const r = await lancer(`export default async (w) => { w.journal("bonjour", { a: 1 }); console.log("direct"); return 1; };`);
    expect(r.stderr).toContain("bonjour");
    expect(r.stderr).toContain("direct");
    // stdout ne porte que le protocole : les traces du bloc implicite, la mémoire, la fin.
    expect(r.lignes.map((l) => l.t)).toEqual(["bloc", "journal", "bloc", "bloc", "bloc", "memoire", "fin"]);
    expect(r.lignes.find((l) => l.t === "journal")).toEqual({ t: "journal", bloc: "recolte", texte: expect.stringContaining("bonjour") });
    expect(r.terminal).toEqual({ t: "fin", donnees: 1 });
  });
});

describe("recolteur : limite de durée (limiteMs)", () => {
  it("limiteMs 1000 : plus aucun élément lancé après 1 s", async () => {
    const annonces = Array.from({ length: 20 }, (_, i) => ({ modele: `m${i}` }));
    const debutA = Date.now();
    const lances: number[] = [];
    const r = await lancerWorkflow({
      workflow: {
        version: 1,
        blocs: [bloc("liste", "code", { source: "liste.mjs" }), bloc("cherche", "web.chercher", { requete: "{modele}", parElement: true }), sortie],
        liens: chaine("liste", "cherche", "sortie"),
      },
      contexte: { web: true, dureeMaxMinutes: 1 },
      fichiers: { "liste.mjs": `export default async () => (${JSON.stringify(annonces)});` },
      debut: { limiteMs: 1000 },
      repondre: async () => {
        lances.push(Date.now() - debutA);
        await new Promise((ok) => setTimeout(ok, 300));
        return { ok: [] };
      },
    });
    expect(r.terminal.t).toBe("fin");
    expect(r.finBloc("cherche")).toMatchObject({ statut: "partiel" });
    // Deux à la fois, 300 ms chacun : quelques paires, puis plus rien passé 1 s (marge pour le démarrage de Node).
    expect(lances.length).toBeGreaterThanOrEqual(2);
    expect(lances.length).toBeLessThan(12);
    expect(r.lignes.some((l) => l.t === "journal" && /^temps écoulé : \d+ élément\(s\) non lancé\(s\)$/.test(l.texte))).toBe(true);
  });

  it("sans limiteMs : 150 s comme avant", () => {
    expect(LIMITE_GLOBALE_MS).toBe(150_000);
    expect(echeanceDe({ t: "debut" }, 1_000)).toBe(151_000);
    expect(echeanceDe({ t: "debut", limiteMs: 1_000 }, 1_000)).toBe(2_000);
  });
});
