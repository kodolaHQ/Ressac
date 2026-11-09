import { afterEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { readdir, writeFile, mkdir, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PolitiqueAcces, type DroitDev } from "../../src/acces/politique.js";
import { TEXTE_PRIVE, type OngletInfo } from "../../src/mcp/pont.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { demarrerServeurMcp, genererJeton } from "../../src/mcp/serveur.js";
import { SuiviOutilsDev } from "../../src/outils-dev/suivi.js";
import { cheminsEspace } from "../../src/chemins.js";
import { fichiersProfils } from "../../src/noyau.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const github: OngletInfo = { id: "github", titre: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", espace: "perso" };
const gmail: OngletInfo = { id: "gmail", titre: "Gmail", url: "https://mail.google.com/mail/u/0/", espace: "perso" };
const vidola: OngletInfo = { id: "site:vidola", titre: "Vidola", url: "https://vidola-a.example/film/1", espace: "", site: "vidola" };
const appTodo: OngletInfo = { id: "app:todo", titre: "Todo", url: "http://localhost:5280/", espace: "perso", application: "todo" };

const REFUS = "Accès refusé par l'utilisateur à cet outil sur cet onglet.";
const COUPE = "Accès coupé par l'utilisateur.";

let serveur: Awaited<ReturnType<typeof demarrerServeurMcp>> | undefined;
let client: Client | undefined;
let suivi: SuiviOutilsDev | undefined;
let pont: PontFactice;
let politique: PolitiqueAcces;
let racine: string;
/** Folder outside the space (browser profile) for the profiles of sites the agent did not build. */
let prive: string;
const jeton = genererJeton();

async function demarrer(o: {
  outilsDev?: boolean;
  accorderDev?: DroitDev[];
  bloquer?: boolean;
  profils?: Partial<ReturnType<typeof fichiersProfils>>;
  /** Answer of the site app's card (absent: no card, refusal). */
  site?: boolean;
} = {}) {
  pont = new PontFactice([github, gmail, appTodo, vidola], {
    actif: "github",
    autoriser: false,
    outilsDev: o.outilsDev ?? true,
    ...(o.accorderDev ? { accorderDev: o.accorderDev } : {}),
    ...(o.bloquer ? { bloquer: true } : {}),
    ...(o.site !== undefined ? { donneesWidget: o.site } : {}),
  });
  politique = new PolitiqueAcces();
  racine = await dossierTemporaire();
  prive = join(await dossierTemporaire(), "profilage");
  const profils = { ...fichiersProfils(cheminsEspace(racine), prive), ...o.profils };
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

test("without pont.outilsDev, no dev tool is listed", async () => {
  await demarrer({ outilsDev: false });
  const noms = (await client!.listTools()).tools.map((t) => t.name);
  expect(noms).not.toContain("lire_console");
  expect(noms).not.toContain("demander_outils_dev");
  expect(noms).toHaveLength(6);
});

test("with pont.outilsDev, the nine dev tools are listed", async () => {
  await demarrer();
  const noms = (await client!.listTools()).tools.map((t) => t.name);
  expect(noms).toEqual(
    expect.arrayContaining([
      "demander_outils_dev", "lire_console", "lire_reseau", "lire_requete", "profiler_performances",
      "instantane_memoire", "comparer_memoire", "executer_js", "recharger",
    ]),
  );
});

test('lire_console on a third-party tab without the right: a request with rights ["console"]; granted → messages returned (timestamp, level, text)', async () => {
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

test("demander_outils_dev: only the granted rights are returned; the unchecked ones are blocked (second call: no request, answer refused)", async () => {
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

test("after politique.interactionUtilisateur, the refused right can be asked again", async () => {
  await demarrer({ accorderDev: [] });
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(demandesDev()).toHaveLength(1);
  politique.interactionUtilisateur(github);
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(demandesDev()).toHaveLength(2);
});

test("without demanderOutilsDev on the bridge: immediate refusal", async () => {
  await demarrer();
  expect(await appeler("lire_console", { id: "github" })).toBe(REFUS);
  expect(pont.demanderOutilsDev).toBeUndefined();
});

test("built (app:todo): lire_console and executer_js without a request", async () => {
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

test("executer_js truncates a value that is too long", async () => {
  await demarrer();
  politique.ongletOuvertParAgent(appTodo);
  const r = await appeler("executer_js", { id: "app:todo", code: "x".repeat(3000) });
  expect(r.endsWith("… [tronqué]")).toBe(true);
  expect(r.length).toBeLessThan(2100);
});

test("lire_reseau on a third-party tab masks Cookie and access_token; on a built one, nothing is masked", async () => {
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
  // the filter applies to the displayed URL: it does not allow guessing a secret
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

test("profiler_performances: on a third-party site, the .cpuprofile stays outside the space (reference profil:…); a built one writes under /workspace", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const r = await appeler("profiler_performances", { id: "github", duree_s: 2 });
  expect(pont.appels.find((a) => a.methode === "profiler")!.args[1]).toEqual({ dureeMs: 2000 });
  expect(r).toContain("calculer");
  expect(r).toContain("Nodes : 42");
  const reference = /Profil : (profil:\S+\.cpuprofile)$/.exec(r)?.[1];
  expect(reference).toMatch(/^profil:[^:/]+-profiler_performances\.cpuprofile$/);
  expect(existsSync(join(prive, reference!.slice("profil:".length)))).toBe(true);
  expect(existsSync(join(racine, ".webaios", "profilage"))).toBe(false);

  // a built app writes in its project
  politique.ongletOuvertParAgent(appTodo);
  const app = await appeler("profiler_performances", { id: "app:todo", recharger: true });
  expect(app).toMatch(/Profil : \/workspace\/projets\/todo\/\.webaios\/profilage\/\S+\.cpuprofile/);
  // a built demo, in .webaios/profilage
  const demo = await pont.ouvrirOnglet("http://localhost:5281/");
  politique.ongletOuvertParAgent(demo);
  const d = await appeler("profiler_performances", { id: demo.id, duree_s: 1 });
  expect(d).toMatch(/Profil : \/workspace\/\.webaios\/profilage\/\S+\.cpuprofile$/);
});

test("instantane_memoire then comparer_memoire", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const a = await appeler("instantane_memoire", { id: "github" });
  expect(a).toContain("Total :");
  expect(a).toContain("Fuite : 2 objets");
  const cheminA = /Instantané : (\S+\.heapsnapshot)/.exec(a)![1]!;
  expect(cheminA).toMatch(/^profil:[^/]+\.heapsnapshot$/);
  pont.agrandirTas();
  const b = await appeler("instantane_memoire", { id: "github" });
  const cheminB = /Instantané : (\S+\.heapsnapshot)/.exec(b)![1]!;
  expect(cheminB).not.toBe(cheminA);
  const c = await appeler("comparer_memoire", { id: "github", a: cheminA, b: cheminB });
  expect(c).toContain("Fuite +1");
  // outside the profile folders: refused
  expect(await appeler("comparer_memoire", { id: "github", a: "/workspace/AGENTS.md", b: cheminB })).toBe(
    "Instantané illisible : /workspace/AGENTS.md.",
  );
  expect(await appeler("comparer_memoire", { id: "github", a: "/workspace/.webaios/profilage/../mcp.json", b: cheminB })).toBe(
    "Instantané illisible : /workspace/.webaios/profilage/../mcp.json.",
  );
  // a file in the folder that is not a snapshot: never its content in the answer
  await mkdir(join(racine, ".webaios", "profilage"), { recursive: true });
  await writeFile(join(racine, ".webaios", "profilage", "faux.heapsnapshot"), "secret de l'utilisateur");
  const faux = await appeler("comparer_memoire", { id: "github", a: "/workspace/.webaios/profilage/faux.heapsnapshot", b: cheminB });
  expect(faux).toBe("Instantané illisible : /workspace/.webaios/profilage/faux.heapsnapshot.");
  // a reference never leaves the private folder
  for (const ref of ["profil:../x.heapsnapshot", "profil:", "profil:inconnu.heapsnapshot"]) {
    expect(await appeler("comparer_memoire", { id: "github", a: ref, b: cheminB })).toBe(`Instantané illisible : ${ref}.`);
  }
  await symlink(join(racine, "AGENTS.md"), join(prive, "lien.heapsnapshot"));
  expect(await appeler("comparer_memoire", { id: "github", a: "profil:lien.heapsnapshot", b: cheminB })).toBe(
    "Instantané illisible : profil:lien.heapsnapshot.",
  );
});

test("cut during instantane_memoire (bloquer: true): answer « Accès coupé par l'utilisateur. », no file left", async () => {
  await demarrer({ accorderDev: ["performances"], bloquer: true });
  const appel = appeler("instantane_memoire", { id: "github" });
  await vi.waitFor(() => expect(pont.appels.some((a) => a.methode === "instantaneMemoire")).toBe(true));
  expect(politique.etat().github?.enCours).toBe(true);
  politique.couper("github", "performances");
  expect(await appel).toBe(COUPE);
  expect(politique.etat().github?.enCours ?? false).toBe(false);
  const dossier = prive;
  expect(existsSync(dossier) ? await readdir(dossier) : []).toEqual([]);
});

test("cut while the profile is being written: the partial file is erased", async () => {
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

test("the tab changes site during the request: nothing is granted", async () => {
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

test("two simultaneous requests for the same tab: a single card", async () => {
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

test("SuiviOutilsDev: attaches at the first right, detaches when everything is cut; OutilsDevOccupes → the tool returns the message", async () => {
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

  // The user opened their tools on Gmail
  pont.occuper("gmail");
  politique.accorderDev(gmail, ["console"], []);
  await vi.waitFor(() => expect(suivi!.occupes.has("gmail")).toBe(true));
  expect(suivi.attaches.has("gmail")).toBe(false);
  expect(await appeler("lire_console", { id: "gmail" })).toBe("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
});

test("fichiersProfils: refuses a path outside the profile folders", async () => {
  const r = await dossierTemporaire();
  const p = fichiersProfils(cheminsEspace(r));
  const chemin = await p.ecrireProfil(appTodo, "x.heapsnapshot", "{}", true);
  expect(chemin).toBe("/workspace/projets/todo/.webaios/profilage/x.heapsnapshot");
  expect(await p.lireProfil(chemin)).toBe("{}");
  await p.supprimerProfil(chemin);
  expect(existsSync(join(r, "projets", "todo", ".webaios", "profilage", "x.heapsnapshot"))).toBe(false);
  for (const faux of ["/workspace/AGENTS.md", "/workspace/.webaios/mcp.json", "/workspace/projets/todo/../../.webaios/mcp.json", "/etc/passwd", "relatif.cpuprofile"]) {
    await expect(p.lireProfil(faux)).rejects.toThrow();
    await expect(p.supprimerProfil(faux)).rejects.toThrow();
  }
  await expect(p.ecrireProfil({ ...appTodo, application: "../x" }, "y.cpuprofile", "{}", true)).rejects.toThrow();
  await expect(p.ecrireProfil(github, "../y.cpuprofile", "{}", true)).rejects.toThrow();
  // without a private folder, a third-party site's profile is not saved (never in the space)
  await expect(p.ecrireProfil(github, "z.cpuprofile", "{}", false)).rejects.toThrow(/indisponible/);
  expect(existsSync(join(r, ".webaios", "profilage", "z.cpuprofile"))).toBe(false);
});

test("fichiersProfils: a profiling folder as a symbolic link is refused, on write as on read", async () => {
  const r = await dossierTemporaire();
  const dehors = await dossierTemporaire();
  await writeFile(join(dehors, "x.heapsnapshot"), "secret");
  await mkdir(join(r, ".webaios"), { recursive: true });
  await symlink(dehors, join(r, ".webaios", "profilage"));
  const p = fichiersProfils(cheminsEspace(r));
  await expect(p.ecrireProfil(github, "y.cpuprofile", "{}", true)).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(dehors, "y.cpuprofile"))).toBe(false);
  await expect(p.lireProfil("/workspace/.webaios/profilage/x.heapsnapshot")).rejects.toThrow(/hors des profils/);
  await expect(p.supprimerProfil("/workspace/.webaios/profilage/x.heapsnapshot")).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(dehors, "x.heapsnapshot"))).toBe(true);
  // a link higher up (the project folder) too
  await mkdir(join(r, "projets"), { recursive: true });
  await symlink(dehors, join(r, "projets", "todo"));
  await expect(p.ecrireProfil(appTodo, "z.cpuprofile", "{}", true)).rejects.toThrow(/hors des profils/);
  expect(existsSync(join(dehors, ".webaios"))).toBe(false);
});

test("fichiersProfils: a file as a symbolic link is neither read, nor erased, nor overwritten", async () => {
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
  await expect(p.ecrireProfil(github, "lien.heapsnapshot", "écrasé", true)).rejects.toThrow();
  expect(await readFile(cible, "utf8")).toBe("secret");
  expect(existsSync(join(dossier, "lien.heapsnapshot"))).toBe(true);
});

test("lire_console and lire_reseau: at most 100,000 characters, the most recent entries kept", async () => {
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
  // under the limit: nothing omitted
  pont.fixerConsole("app:todo", [{ horodatage: 0, niveau: "log", texte: "court" }]);
  expect(await appeler("lire_console", { id: "app:todo" })).not.toContain("omises");
});

test("site change during instantane_memoire: « L'onglet a changé de site : accès retiré. »", async () => {
  await demarrer({ accorderDev: ["performances"], bloquer: true });
  const appel = appeler("instantane_memoire", { id: "github" });
  await vi.waitFor(() => expect(pont.appels.some((a) => a.methode === "instantaneMemoire")).toBe(true));
  await pont.naviguer("github", "https://autre.example/");
  politique.ongletNavigue("github", "https://autre.example/");
  expect(await appel).toBe("L'onglet a changé de site : accès retiré.");
});

test("the site changes between the grant and the call: the bridge is not called", async () => {
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

test("an error after the profile is written also erases the file", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const dossier = prive;
  pont.outilsDev!.instantaneMemoire = async () => "pas du json";
  const r = await appeler("instantane_memoire", { id: "github" });
  expect(r).toMatch(/^Erreur/);
  expect(existsSync(dossier) ? await readdir(dossier) : []).toEqual([]);
});

test("cut answers right away even if the bridge ignores the signal; its late result writes no file", async () => {
  await demarrer({ accorderDev: ["performances"] });
  const dossier = prive;
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

test("fichiersProfils: a third-party site writes in the private folder and receives a reference profil:<name>", async () => {
  const r = await dossierTemporaire();
  const dossier = join(await dossierTemporaire(), "profilage");
  const p = fichiersProfils(cheminsEspace(r), dossier);
  const ref = await p.ecrireProfil(github, "x.heapsnapshot", "{}", false);
  expect(ref).toBe("profil:x.heapsnapshot");
  expect(existsSync(join(dossier, "x.heapsnapshot"))).toBe(true);
  expect(existsSync(join(r, ".webaios"))).toBe(false);
  expect(await p.lireProfil(ref)).toBe("{}");
  await expect(p.ecrireProfil(github, "x.heapsnapshot", "écrasé", false)).rejects.toThrow();
  for (const faux of ["profil:../x.heapsnapshot", "profil:a/b", "profil:", "profil:.."]) {
    await expect(p.lireProfil(faux)).rejects.toThrow();
    await expect(p.supprimerProfil(faux)).rejects.toThrow();
  }
  await p.supprimerProfil(ref);
  expect(existsSync(join(dossier, "x.heapsnapshot"))).toBe(false);
  await p.supprimerProfil(ref); // already erased: without error
});

test("page without an origin (about:blank, data:, file:): immediate refusal, no card", async () => {
  await demarrer({ accorderDev: ["console"] });
  for (const url of ["about:blank", "data:text/html,<p>x</p>", "file:///Users/someone/a.html"]) {
    const o = await pont.ouvrirOnglet(url);
    expect(await appeler("lire_console", { id: o.id })).toBe(REFUS);
    expect(await appeler("demander_outils_dev", { id: o.id, droits: ["console"], raison: "voir" })).toBe(REFUS);
  }
  expect(demandesDev()).toHaveLength(0);
});

test("the reason shown on the card is bounded to 300 characters (…)", async () => {
  await demarrer({ accorderDev: ["console"] });
  await appeler("demander_outils_dev", { id: "github", droits: ["console"], raison: "a".repeat(1000) });
  const raison = (demandesDev()[0]!.args[1] as { raison: string }).raison;
  expect(raison).toHaveLength(300);
  expect(raison.endsWith("…")).toBe(true);
  await appeler("demander_outils_dev", { id: "gmail", droits: ["console"], raison: "b".repeat(300) });
  expect((demandesDev()[1]!.args[1] as { raison: string }).raison).toBe("b".repeat(300));
});

test("new conversation during the card: the card is withdrawn (signal) and a late answer grants nothing", async () => {
  await demarrer({ accorderDev: ["console"] });
  let signal: AbortSignal | undefined;
  let repondre!: (d: DroitDev[]) => void;
  pont.demanderOutilsDev = (_o, _d, s) => {
    signal = s;
    return new Promise<DroitDev[]>((ok) => (repondre = ok));
  };
  const appel = appeler("lire_console", { id: "github" });
  await vi.waitFor(() => expect(signal).toBeDefined());
  expect(signal!.aborted).toBe(false);
  politique.reinitialiser();
  expect(signal!.aborted).toBe(true);
  repondre(["console"]); // The user clicks anyway (or the browser ignores the signal)
  expect(await appel).toBe(REFUS);
  expect(politique.droitsDev(github)).toEqual([]);
  expect(politique.peutDemander("github", "console")).toBe(true);
});

test("lire_console masks the tokens in URLs in the messages and stacks of a third-party site; not on a built one", async () => {
  await demarrer({ accorderDev: ["console"] });
  const messages = [
    {
      horodatage: 0,
      niveau: "error" as const,
      texte: "GET https://api.github.com/user?access_token=abc123&page=2 401",
      pile: "at f (https://github.com/app.js?sig=zzz999:1:2)",
    },
  ];
  pont.fixerConsole("github", messages);
  pont.fixerConsole("app:todo", messages);
  const r = await appeler("lire_console", { id: "github" });
  expect(r).toContain("https://api.github.com/user?access_token=«masqué»&page=2 401");
  expect(r).toContain("at f (https://github.com/app.js?sig=«masqué»)");
  expect(r).not.toContain("abc123");
  expect(r).not.toContain("zzz999");
  politique.ongletOuvertParAgent(appTodo);
  const brut = await appeler("lire_console", { id: "app:todo" });
  expect(brut).toContain("access_token=abc123");
  expect(brut).toContain("sig=zzz999");
});

test("SuiviOutilsDev: a tab that keeps its rights on another origin (relaunched app) is detached then reattached", async () => {
  await demarrer();
  suivi = new SuiviOutilsDev(politique, pont.outilsDev!, () => pont.listerOnglets());
  const appels = () => pont.appels.filter((a) => ["attacher", "detacher"].includes(a.methode) && a.args[0] === "app:todo").map((a) => a.methode);
  politique.construite(appTodo);
  await vi.waitFor(() => expect(appels()).toEqual(["attacher"]));
  // relaunched on another port: the window navigates, it is built again on its new origin
  await pont.naviguer("app:todo", "http://localhost:5290/");
  politique.ongletNavigue("app:todo", "http://localhost:5290/");
  politique.construite({ ...appTodo, url: "http://localhost:5290/" });
  await vi.waitFor(() => expect(appels()).toEqual(["attacher", "detacher", "attacher"]));
  expect(suivi.attaches.has("app:todo")).toBe(true);
  // same origin, other page: nothing moves
  await pont.naviguer("app:todo", "http://localhost:5290/autre");
  politique.ongletNavigue("app:todo", "http://localhost:5290/autre");
  await new Promise((r) => setTimeout(r, 20));
  expect(appels()).toEqual(["attacher", "detacher", "attacher"]);
});

test("private space: each dev tool answers TEXTE_PRIVE, without a card or a debugger call", async () => {
  await demarrer({ accorderDev: ["console", "reseau", "performances", "agir"] });
  pont.rendrePrive("github");
  const appels: [string, Record<string, unknown>][] = [
    ["demander_outils_dev", { id: "github", droits: ["console"], raison: "déboguer" }],
    ["lire_console", { id: "github" }],
    ["lire_reseau", { id: "github" }],
    ["lire_requete", { id: "github", requete: "1" }],
    ["profiler_performances", { id: "github", duree_s: 1 }],
    ["instantane_memoire", { id: "github" }],
    ["comparer_memoire", { id: "github", a: "x", b: "y" }],
    ["executer_js", { id: "github", code: "1" }],
    ["recharger", { id: "github" }],
  ];
  for (const [name, args] of appels) {
    const r = await client!.callTool({ name, arguments: args });
    expect((r.content as { text: string }[])[0]!.text, name).toBe(TEXTE_PRIVE);
    expect(r.isError, name).toBeFalsy();
  }
  expect(demandesDev()).toHaveLength(0);
  expect(pont.appels.filter((a) => !["listerOnglets"].includes(a.methode))).toEqual([]);
});

test("private space during a call: it is cut and answers TEXTE_PRIVE", async () => {
  await demarrer({ accorderDev: ["performances"], bloquer: true });
  const r = appeler("profiler_performances", { id: "github", duree_s: 30 });
  await vi.waitFor(() => expect(pont.appels.some((a) => a.methode === "profiler")).toBe(true));
  pont.rendrePrive("github");
  politique.ongletFerme("github"); // what the browser does when the tab becomes private
  expect(await r).toBe(TEXTE_PRIVE);
});

// ——— Site app windows: the app's grant AND the dev tools' ———

const cartesSite = () => pont.appels.filter((a) => a.methode === "demanderDonneesWidget");

test("lire_console with the site's grant but without a dev right: refused", async () => {
  await demarrer({ accorderDev: [], site: true });
  politique.accorderLectureSite("vidola");
  pont.fixerConsole("site:vidola", [{ horodatage: 0, niveau: "error", texte: "secret de la page" }]);
  expect(await appeler("lire_console", { id: "site:vidola" })).toBe(REFUS);
  expect(demandesDev()).toHaveLength(1);
  expect(cartesSite()).toHaveLength(0);
  expect(pont.appels.some((a) => a.methode === "console")).toBe(false);
  expect(await appeler("lire_reseau", { id: "site:vidola" })).toBe(REFUS);
  expect(pont.appels.some((a) => a.methode === "reseau")).toBe(false);
});

test("lire_console with the dev right but without the site's grant: the app's card, refused → refused, without a tools card", async () => {
  await demarrer({ accorderDev: ["console", "reseau"], site: false });
  pont.fixerConsole("site:vidola", [{ horodatage: 0, niveau: "error", texte: "secret de la page" }]);
  // A dev right already held is not enough.
  politique.accorderDev(vidola, ["console"], []);
  expect(await appeler("lire_console", { id: "site:vidola" })).toBe(REFUS);
  expect(cartesSite().map((c) => c.args[0])).toEqual([{ id: "vidola", nom: "Vidola", agent: "Claude", genre: "site" }]);
  expect(demandesDev()).toHaveLength(0);
  expect(pont.appels.some((a) => a.methode === "console")).toBe(false);
  expect(await appeler("demander_outils_dev", { id: "site:vidola", droits: ["reseau"], raison: "voir" })).toBe(REFUS);
  expect(demandesDev()).toHaveLength(0);
});

test("lire_console on a site app whose site.json was rewritten (other hash): the app's card comes back first", async () => {
  await demarrer({ accorderDev: ["console"], site: true });
  pont.modifierOnglet("site:vidola", { empreinte: "e1" });
  pont.fixerConsole("site:vidola", [{ horodatage: 0, niveau: "error", texte: "message" }]);
  expect(await appeler("lire_console", { id: "site:vidola" })).toContain("message");
  expect(cartesSite()).toHaveLength(1);
  pont.modifierOnglet("site:vidola", { empreinte: "e2" });
  expect(politique.droitsDev({ ...vidola, empreinte: "e2" })).toEqual([]);
  await appeler("lire_console", { id: "site:vidola" });
  expect(cartesSite()).toHaveLength(2);
});

test("lire_console: site.json rewritten during the app's card (other hash): nothing is read", async () => {
  await demarrer({ accorderDev: ["console"] });
  pont.modifierOnglet("site:vidola", { empreinte: "e1" });
  pont.fixerConsole("site:vidola", [{ horodatage: 0, niveau: "error", texte: "secret de la page" }]);
  let repondre: ((oui: boolean) => void) | undefined;
  pont.demanderDonneesWidget = () => new Promise<boolean>((ok) => (repondre = ok));
  const r = appeler("lire_console", { id: "site:vidola" });
  await vi.waitFor(() => expect(repondre).toBeDefined());
  pont.modifierOnglet("site:vidola", { empreinte: "autre" });
  repondre!(true);
  expect(await r).toBe(REFUS);
  expect(pont.appels.some((a) => a.methode === "console")).toBe(false);
});

test("lire_console on a site app: both grants → the messages, URLs masked (the site is not built by the agent)", async () => {
  await demarrer({ accorderDev: ["console"], site: true });
  pont.fixerConsole("site:vidola", [{ horodatage: 0, niveau: "error", texte: "échec https://vidola-a.example/api?token=abc" }]);
  const r = await appeler("lire_console", { id: "site:vidola" });
  expect(r).toContain("[error] échec");
  expect(r).not.toContain("token=abc");
  expect(r).toContain("token=«masqué»");
  expect(cartesSite()).toHaveLength(1);
  expect(demandesDev()).toHaveLength(1);
  // New conversation: both grants drop.
  politique.reinitialiser();
  pont.appels.length = 0;
  await appeler("lire_console", { id: "site:vidola" });
  expect(cartesSite()).toHaveLength(1);
});
