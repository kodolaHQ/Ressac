import { afterEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { readdir, writeFile, mkdir, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PolitiqueAcces, type DroitDev } from "../../src/acces/politique.js";
import type { OngletInfo } from "../../src/mcp/pont.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { demarrerServeurMcp, genererJeton } from "../../src/mcp/serveur.js";
import { SuiviOutilsDev } from "../../src/outils-dev/suivi.js";
import { cheminsEspace } from "../../src/chemins.js";
import { fichiersProfils } from "../../src/noyau.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const github: OngletInfo = { id: "github", titre: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: OngletInfo = { id: "gmail", titre: "Gmail", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const appTodo: OngletInfo = { id: "app:todo", titre: "Todo", url: "http://localhost:5280/", espace: "perso", application: "todo" };

const REFUS = "Accès refusé par l'utilisateur à cet outil sur cet onglet.";
const COUPE = "Accès coupé par l'utilisateur.";

let serveur: Awaited<ReturnType<typeof demarrerServeurMcp>> | undefined;
let client: Client | undefined;
let suivi: SuiviOutilsDev | undefined;
let pont: PontFactice;
let politique: PolitiqueAcces;
let racine: string;
const jeton = genererJeton();

async function demarrer(o: {
  outilsDev?: boolean;
  accorderDev?: DroitDev[];
  bloquer?: boolean;
  profils?: Partial<ReturnType<typeof fichiersProfils>>;
} = {}) {
  pont = new PontFactice([github, gmail, appTodo], {
    actif: "github",
    autoriser: false,
    outilsDev: o.outilsDev ?? true,
    ...(o.accorderDev ? { accorderDev: o.accorderDev } : {}),
    ...(o.bloquer ? { bloquer: true } : {}),
  });
  politique = new PolitiqueAcces();
  racine = await dossierTemporaire();
  const profils = { ...fichiersProfils(cheminsEspace(racine)), ...o.profils };
  serveur = await demarrerServeurMcp({ pont, politique, jeton, agent: "Claude", profils });
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serveur.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${jeton}` } },
    }),
  );
}

afterEach(async () => {
  suivi?.arreter();
  suivi = undefined;
  await client?.close();
  await serveur?.arreter();
  client = undefined;
  serveur = undefined;
});

const appeler = async (name: string, args: Record<string, unknown>) => {
  const r = await client!.callTool({ name, arguments: args });
  return (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
};
const demandesDev = () => pont.appels.filter((a) => a.methode === "demanderOutilsDev");

test("sans pont.outilsDev, aucun outil de développement n'est listé", async () => {
  await demarrer({ outilsDev: false });
  const noms = (await client!.listTools()).tools.map((t) => t.name);
  expect(noms).not.toContain("lire_console");
  expect(noms).not.toContain("demander_outils_dev");
  expect(noms).toHaveLength(6);
});

test("avec pont.outilsDev, les neuf outils de développement sont listés", async () => {
  await demarrer();
  const noms = (await client!.listTools()).tools.map((t) => t.name);
  expect(noms).toEqual(
    expect.arrayContaining([
      "demander_outils_dev", "lire_console", "lire_reseau", "lire_requete", "profiler_performances",
      "instantane_memoire", "comparer_memoire", "executer_js", "recharger",
    ]),
  );
});

test('lire_console sur un onglet tiers sans droit : une demande avec droits ["console"] ; accordé → messages renvoyés (horodatage, niveau, texte)', async () => {
  await demarrer({ accorderDev: ["console"] });
  const h = Date.parse("2026-10-27T10:00:00.000Z");
  pont.fixerConsole("github", [
    { horodatage: h, niveau: "error", texte: "TypeError: x is undefined", pile: "at f (app.js:1:2)" },
    { horodatage: h + 1000, niveau: "log", texte: "bonjour" },
  ]);
  const r = await appeler("lire_console", { id: "github" });
  expect(demandesDev()).toHaveLength(1);
  const [o, d] = demandesDev()[0]!.args as [OngletInfo, { droits: DroitDev[]; raison: string; agent: string }];
  expect(o.id).toBe("github");
  expect(d).toEqual({ droits: ["console"], raison: "L'agent veut utiliser lire_console.", agent: "Claude" });
  expect(r).toContain("2026-10-27T10:00:00.000Z");
  expect(r).toContain("[error] TypeError: x is undefined");
  expect(r).toContain("at f (app.js:1:2)");
  expect(r).toContain("[log] bonjour");
  // filtres
  expect(await appeler("lire_console", { id: "github", niveau: "log" })).not.toContain("TypeError");
  expect(await appeler("lire_console", { id: "github", depuis: h + 500 })).not.toContain("TypeError");
  expect(demandesDev()).toHaveLength(1);
});

test("demander_outils_dev : seuls les droits accordés sont renvoyés ; les décochés sont bloqués (deuxième appel : aucune demande, réponse refusée)", async () => {
  await demarrer({ accorderDev: ["console"] });
  const r = await appeler("demander_outils_dev", { id: "github", droits: ["console", "reseau"], raison: "Déboguer l'erreur" });
  expect(r).toContain("Droits accordés : console");
  expect(r).not.toMatch(/accordés : .*reseau/);
  expect(politique.droitsDev(github)).toEqual(["console"]);
  expect(politique.peutDemander("github", "reseau")).toBe(false);
  expect((demandesDev()[0]!.args[1] as { raison: string }).raison).toBe("Déboguer l'erreur");
  expect(await appeler("demander_outils_dev", { id: "github", droits: ["reseau"], raison: "encore" })).toBe(REFUS);
  expect(await appeler("lire_reseau", { id: "github" })).toBe(REFUS);
  expect(demandesDev()).toHaveLength(1);
});

test("après politique.interactionUtilisateur, le droit refusé peut être redemandé", async () => {
  await demarrer({ accorderDev: [] });
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(demandesDev()).toHaveLength(1);
  politique.interactionUtilisateur(github);
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(demandesDev()).toHaveLength(2);
});

test("sans demanderOutilsDev sur le pont : refus immédiat", async () => {
  await demarrer();
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(pont.demanderOutilsDev).toBeUndefined();
});

test("construite (app:todo) : lire_console et executer_js sans demande", async () => {
  await demarrer({ accorderDev: [] });
  politique.ongletOuvertParAgent(appTodo);
  pont.fixerConsole("app:todo", [{ horodatage: 0, niveau: "warn", texte: "attention" }]);
  expect(await appeler("lire_console", { id: "app:todo" })).toContain("[warn] attention");
  expect(await appeler("executer_js", { id: "app:todo", code: "1 + 1" })).toBe(JSON.stringify({ code: "1 + 1" }));
  expect(await appeler("executer_js", { id: "app:todo", code: "throw boom" })).toContain("Exception : boom");
  expect(await appeler("recharger", { id: "app:todo", sans_cache: true })).toContain("rechargé");
  expect(pont.appels.some((a) => a.methode === "recharger" && a.args[1] === true)).toBe(true);
  expect(demandesDev()).toHaveLength(0);
});

test("executer_js tronque une valeur trop longue", async () => {
  await demarrer();
  politique.ongletOuvertParAgent(appTodo);
  const r = await appeler("executer_js", { id: "app:todo", code: "x".repeat(3000) });
  expect(r.endsWith("… [tronqué]")).toBe(true);
  expect(r.length).toBeLessThan(2100);
});

test("lire_reseau sur un onglet tiers masque Cookie et access_token ; sur une construite, rien n'est masqué", async () => {
  await demarrer({ accorderDev: ["reseau"] });
  const requete = {
    id: "r1", horodatage: 0, methode: "GET", url: "https://github.com/api?access_token=abc123&page=2", statut: 200,
    dureeMs: 12, taille: 345, type: "Fetch", enTetesRequete: { Cookie: "session=xyz" }, enTetesReponse: { "Content-Type": "application/json" },
  };
  pont.fixerReseau("github", [requete]);
  pont.fixerReseau("app:todo", [requete]);
  const liste = await appeler("lire_reseau", { id: "github" });
  expect(liste).toContain("r1");
  expect(liste).toContain("access_token=«masqué»&page=2");
  expect(liste).not.toContain("abc123");
  // le filtre porte sur l'URL affichée : il ne permet pas de deviner un secret
  expect(await appeler("lire_reseau", { id: "github", filtre: "abc123" })).not.toContain("r1");
  const detail = await appeler("lire_requete", { id: "github", requete: "r1" });
  expect(detail).toContain("Cookie: «masqué»");
  expect(detail).not.toContain("session=xyz");
  expect(detail).toContain("Content-Type: application/json");
  expect(detail).toContain("Corps de r1");
  expect(await appeler("lire_requete", { id: "github", requete: "inconnue" })).toContain("introuvable");

  politique.ongletOuvertParAgent(appTodo);
  expect(await appeler("lire_reseau", { id: "app:todo" })).toContain("access_token=abc123");
  expect(await appeler("lire_requete", { id: "app:todo", requete: "r1" })).toContain("Cookie: session=xyz");
});

test("profiler_performances écrit un .cpuprofile sous .webaios/profils et renvoie le résumé et le chemin /workspace/...", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const r = await appeler("profiler_performances", { id: "github", duree_s: 2 });
  expect(pont.appels.find((a) => a.methode === "profiler")!.args[1]).toEqual({ dureeMs: 2000 });
  expect(r).toContain("calculer");
  expect(r).toContain("Nodes : 42");
  const chemin = /Profil : (\/workspace\/\.webaios\/profilage\/\S+\.cpuprofile)/.exec(r)?.[1];
  expect(chemin).toMatch(/^\/workspace\/\.webaios\/profilage\/[^:]+-profiler_performances\.cpuprofile$/);
  expect(existsSync(join(racine, chemin!.slice("/workspace/".length)))).toBe(true);

  // une construite écrit dans son projet
  politique.ongletOuvertParAgent(appTodo);
  const app = await appeler("profiler_performances", { id: "app:todo", recharger: true });
  expect(app).toMatch(/Profil : \/workspace\/projets\/todo\/\.webaios\/profilage\/\S+\.cpuprofile/);
});

test("instantane_memoire puis comparer_memoire", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const a = await appeler("instantane_memoire", { id: "github" });
  expect(a).toContain("Total :");
  expect(a).toContain("Fuite : 2 objets");
  const cheminA = /Instantané : (\S+\.heapsnapshot)/.exec(a)![1]!;
  expect(cheminA.startsWith("/workspace/.webaios/profilage/")).toBe(true);
  pont.agrandirTas();
  const b = await appeler("instantane_memoire", { id: "github" });
  const cheminB = /Instantané : (\S+\.heapsnapshot)/.exec(b)![1]!;
  expect(cheminB).not.toBe(cheminA);
  const c = await appeler("comparer_memoire", { id: "github", a: cheminA, b: cheminB });
  expect(c).toContain("Fuite +1");
  // hors des dossiers de profils : refusé
  expect(await appeler("comparer_memoire", { id: "github", a: "/workspace/AGENTS.md", b: cheminB })).toBe(
    "Instantané illisible : /workspace/AGENTS.md.",
  );
  expect(await appeler("comparer_memoire", { id: "github", a: "/workspace/.webaios/profilage/../mcp.json", b: cheminB })).toBe(
    "Instantané illisible : /workspace/.webaios/profilage/../mcp.json.",
  );
  // un fichier du dossier qui n'est pas un instantané : jamais son contenu dans la réponse
  await writeFile(join(racine, ".webaios", "profilage", "faux.heapsnapshot"), "secret de l'utilisateur");
  const faux = await appeler("comparer_memoire", { id: "github", a: "/workspace/.webaios/profilage/faux.heapsnapshot", b: cheminB });
  expect(faux).toBe("Instantané illisible : /workspace/.webaios/profilage/faux.heapsnapshot.");
});

test("couper pendant instantane_memoire (bloquer: true) : réponse « Accès coupé par l'utilisateur. », aucun fichier laissé", async () => {
  await demarrer({ accorderDev: ["performances"], bloquer: true });
  const appel = appeler("instantane_memoire", { id: "github" });
  await vi.waitFor(() => expect(pont.appels.some((a) => a.methode === "instantaneMemoire")).toBe(true));
  expect(politique.etat().github?.enCours).toBe(true);
  politique.couper("github", "performances");
  expect(await appel).toBe(COUPE);
  expect(politique.etat().github?.enCours ?? false).toBe(false);
  const dossier = join(racine, ".webaios", "profilage");
  expect(existsSync(dossier) ? await readdir(dossier) : []).toEqual([]);
});

test("couper pendant l'écriture du profil : le fichier partiel est effacé", async () => {
  let ecrit = "";
  await demarrer({
    accorderDev: ["performances"],
    profils: {
      ecrireProfil: async (_o, nom, contenu) => {
        const dossier = join(racine, ".webaios", "profilage");
        await mkdir(dossier, { recursive: true });
        await writeFile(join(dossier, nom), contenu);
        ecrit = join(dossier, nom);
        politique.couper("github");
        return `/workspace/.webaios/profilage/${nom}`;
      },
    },
  });
  expect(await appeler("profiler_performances", { id: "github" })).toBe(COUPE);
  expect(ecrit).not.toBe("");
  await vi.waitFor(() => expect(existsSync(ecrit)).toBe(false));
});

test("l'onglet change de site pendant la demande : rien n'est accordé", async () => {
  await demarrer({ accorderDev: ["console"] });
  const demander = pont.demanderOutilsDev!.bind(pont);
  pont.demanderOutilsDev = async (o, d) => {
    await pont.naviguer(o.id, "https://autre.example/");
    return demander(o, d);
  };
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(politique.droitsDev({ ...github, url: "https://autre.example/" })).toEqual([]);
  expect(politique.droitsDev(github)).toEqual([]);
});

test("deux demandes simultanées pour le même onglet : une seule carte", async () => {
  await demarrer({ accorderDev: ["console"] });
  const demander = pont.demanderOutilsDev!.bind(pont);
  let liberer!: () => void;
  const verrou = new Promise<void>((ok) => (liberer = ok));
  pont.demanderOutilsDev = async (o, d) => {
    const r = demander(o, d);
    await verrou;
    return r;
  };
  pont.fixerConsole("github", [{ horodatage: 0, niveau: "log", texte: "salut" }]);
  const a = appeler("lire_console", { id: "github" });
  await vi.waitFor(() => expect(demandesDev()).toHaveLength(1));
  const b = appeler("lire_console", { id: "github" });
  await new Promise((r) => setTimeout(r, 50));
  liberer();
  expect(await a).toContain("salut");
  expect(await b).toContain("salut");
  expect(demandesDev()).toHaveLength(1);
});

test("SuiviOutilsDev : attache au premier droit, détache quand tout est coupé ; OutilsDevOccupes → l'outil renvoie le message", async () => {
  await demarrer({ accorderDev: ["console"] });
  suivi = new SuiviOutilsDev(politique, pont.outilsDev!, () => pont.listerOnglets());
  const appelsDe = (m: string, id: string) => pont.appels.filter((a) => a.methode === m && a.args[0] === id).length;

  politique.accorderDev(github, ["console"], []);
  await vi.waitFor(() => expect(suivi!.attaches.has("github")).toBe(true));
  politique.accorderDev(github, ["reseau"], []);
  await new Promise((r) => setTimeout(r, 20));
  expect(appelsDe("attacher", "github")).toBe(1);

  politique.couper("github", "console");
  await new Promise((r) => setTimeout(r, 20));
  expect(suivi.attaches.has("github")).toBe(true);
  politique.couper("github");
  await vi.waitFor(() => expect(suivi!.attaches.has("github")).toBe(false));
  expect(appelsDe("detacher", "github")).toBe(1);

  // L'utilisateur a ouvert ses outils sur Gmail
  pont.occuper("gmail");
  politique.accorderDev(gmail, ["console"], []);
  await vi.waitFor(() => expect(suivi!.occupes.has("gmail")).toBe(true));
  expect(suivi.attaches.has("gmail")).toBe(false);
  expect(await appeler("lire_console", { id: "gmail" })).toBe("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
});

test("fichiersProfils : refuse un chemin hors des dossiers de profils", async () => {
  const r = await dossierTemporaire();
  const p = fichiersProfils(cheminsEspace(r));
  const chemin = await p.ecrireProfil(appTodo, "x.heapsnapshot", "{}");
  expect(chemin).toBe("/workspace/projets/todo/.webaios/profilage/x.heapsnapshot");
  expect(await p.lireProfil(chemin)).toBe("{}");
  await p.supprimerProfil(chemin);
  expect(existsSync(join(r, "projets", "todo", ".webaios", "profilage", "x.heapsnapshot"))).toBe(false);
  for (const faux of ["/workspace/AGENTS.md", "/workspace/.webaios/mcp.json", "/workspace/projets/todo/../../.webaios/mcp.json", "/etc/passwd", "relatif.cpuprofile"]) {
    await expect(p.lireProfil(faux)).rejects.toThrow();
    await expect(p.supprimerProfil(faux)).rejects.toThrow();
  }
  await expect(p.ecrireProfil({ ...appTodo, application: "../x" }, "y.cpuprofile", "{}")).rejects.toThrow();
  await expect(p.ecrireProfil(github, "../y.cpuprofile", "{}")).rejects.toThrow();
});

test("fichiersProfils : un dossier de profilage en lien symbolique est refusé, à l'écriture comme à la lecture", async () => {
  const r = await dossierTemporaire();
  const dehors = await dossierTemporaire();
  await writeFile(join(dehors, "x.heapsnapshot"), "secret");
  await mkdir(join(r, ".webaios"), { recursive: true });
  await symlink(dehors, join(r, ".webaios", "profilage"));
  const p = fichiersProfils(cheminsEspace(r));
  await expect(p.ecrireProfil(github, "y.cpuprofile", "{}")).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(dehors, "y.cpuprofile"))).toBe(false);
  await expect(p.lireProfil("/workspace/.webaios/profilage/x.heapsnapshot")).rejects.toThrow(/hors des profils/);
  await expect(p.supprimerProfil("/workspace/.webaios/profilage/x.heapsnapshot")).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(dehors, "x.heapsnapshot"))).toBe(true);
  // un lien plus haut (le dossier du projet) aussi
  await mkdir(join(r, "projets"), { recursive: true });
  await symlink(dehors, join(r, "projets", "todo"));
  await expect(p.ecrireProfil(appTodo, "z.cpuprofile", "{}")).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(dehors, ".webaios"))).toBe(false);
});

test("fichiersProfils : un fichier en lien symbolique n'est ni lu, ni effacé, ni écrasé", async () => {
  const r = await dossierTemporaire();
  const dehors = await dossierTemporaire();
  const cible = join(dehors, "cible.txt");
  await writeFile(cible, "secret");
  const dossier = join(r, ".webaios", "profilage");
  await mkdir(dossier, { recursive: true });
  await symlink(cible, join(dossier, "lien.heapsnapshot"));
  const p = fichiersProfils(cheminsEspace(r));
  await expect(p.lireProfil("/workspace/.webaios/profilage/lien.heapsnapshot")).rejects.toThrow(/hors des profils/);
  await expect(p.supprimerProfil("/workspace/.webaios/profilage/lien.heapsnapshot")).rejects.toThrow(/hors des profils/);
  await expect(p.ecrireProfil(github, "lien.heapsnapshot", "écrasé")).rejects.toThrow();
  expect(await readFile(cible, "utf8")).toBe("secret");
  expect(existsSync(join(dossier, "lien.heapsnapshot"))).toBe(true);
});

test("lire_console et lire_reseau : au plus 100 000 caractères, les entrées les plus récentes gardées", async () => {
  await demarrer();
  politique.ongletOuvertParAgent(appTodo);
  pont.fixerConsole(
    "app:todo",
    Array.from({ length: 100 }, (_, i) => ({ horodatage: i, niveau: "log" as const, texte: `m${i}-`.padEnd(1500, "x") })),
  );
  const r = await appeler("lire_console", { id: "app:todo" });
  expect(r.length).toBeLessThanOrEqual(100_000);
  const premiere = r.split("\n")[0]!;
  expect(premiere).toMatch(/^\d+ entrées plus anciennes omises\.$/);
  const omises = Number(premiere.split(" ")[0]);
  expect(omises).toBeGreaterThan(0);
  expect(r).toContain("m99-");
  expect(r).not.toContain(`m${omises - 1}-`);
  expect(r).toContain(`m${omises}-`);

  pont.fixerReseau(
    "app:todo",
    Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`, horodatage: i, methode: "GET", url: `http://localhost:5280/${i}-${"y".repeat(1000)}`,
      enTetesRequete: {}, enTetesReponse: {},
    })),
  );
  const reseau = await appeler("lire_reseau", { id: "app:todo" });
  expect(reseau.length).toBeLessThanOrEqual(100_000);
  expect(reseau).toMatch(/^\d+ entrées plus anciennes omises\.\n/);
  expect(reseau).toContain("r199 ·");
  // sous la limite : rien d'omis
  pont.fixerConsole("app:todo", [{ horodatage: 0, niveau: "log", texte: "court" }]);
  expect(await appeler("lire_console", { id: "app:todo" })).not.toContain("omises");
});

test("changement de site pendant instantane_memoire : « L'onglet a changé de site : accès retiré. »", async () => {
  await demarrer({ accorderDev: ["performances"], bloquer: true });
  const appel = appeler("instantane_memoire", { id: "github" });
  await vi.waitFor(() => expect(pont.appels.some((a) => a.methode === "instantaneMemoire")).toBe(true));
  await pont.naviguer("github", "https://autre.example/");
  politique.ongletNavigue("github", "https://autre.example/");
  expect(await appel).toBe("L'onglet a changé de site : accès retiré.");
});

test("le site change entre l'accord et l'appel : le pont n'est pas appelé", async () => {
  await demarrer();
  politique.ongletOuvertParAgent(appTodo);
  const lister = pont.listerOnglets.bind(pont);
  let n = 0;
  pont.listerOnglets = async () => {
    // 1 : obtenir ; 2 : relecture avant l'appel
    if (++n === 2) {
      await pont.naviguer("app:todo", "https://autre.example/");
      politique.ongletNavigue("app:todo", "https://autre.example/");
    }
    return lister();
  };
  expect(await appeler("executer_js", { id: "app:todo", code: "1" })).toBe("L'onglet a changé de site : accès retiré.");
  expect(pont.appels.some((a) => a.methode === "executer")).toBe(false);
});

test("une erreur après l'écriture du profil efface aussi le fichier", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const dossier = join(racine, ".webaios", "profilage");
  pont.outilsDev!.instantaneMemoire = async () => "pas du json";
  const r = await appeler("instantane_memoire", { id: "github" });
  expect(r).toMatch(/^Erreur/);
  expect(existsSync(dossier) ? await readdir(dossier) : []).toEqual([]);
});

test("couper répond tout de suite même si le pont ignore le signal ; son résultat tardif n'écrit aucun fichier", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const dossier = join(racine, ".webaios", "profilage");
  let finir!: (s: string) => void;
  pont.outilsDev!.instantaneMemoire = () => new Promise<string>((ok) => (finir = ok));
  const appel = appeler("instantane_memoire", { id: "github" });
  await vi.waitFor(() => expect(finir).toBeDefined());
  politique.couper("github", "performances");
  expect(await appel).toBe(COUPE);
  finir(JSON.stringify({ snapshot: { meta: { node_fields: [], node_types: [] } }, nodes: [], strings: [] }));
  await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(dossier) ? await readdir(dossier) : []).toEqual([]);
});
