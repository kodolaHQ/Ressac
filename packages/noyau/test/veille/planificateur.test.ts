import { expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { Atelier } from "../../src/conteneur/atelier.js";
import { CODE_DELAI_DEPASSE } from "../../src/conteneur/executeur.js";
import { initialiserEspace } from "../../src/espace/initialiser.js";
import { chargerProfils } from "../../src/profils/profil.js";
import { consigneVeille } from "../../src/veille/echeances.js";
import { PlanificateurVeille } from "../../src/veille/planificateur.js";
import { dossierTemporaire } from "../aide/temporaire.js";
import { blocAgent, ecrireBloc } from "../aide/accueil.js";
import { executeurFactice, type Reponse } from "../aide/executeur-factice.js";

const maintenant = new Date("2026-10-26T08:00:00.000Z");

let blocsCourants = "";
/** Simule l'agent : il écrit son résultat dans le brouillon puis sort avec `code`. */
const agentEcrit = (html: string, code = 0) => async () => {
  await writeFile(join(blocsCourants, "veille-exemple", "index.html.nouveau"), html);
  return { code };
};

async function preparer(reponseClaude: Reponse | (() => Reponse | Promise<Reponse>), docker = "true\n") {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
  blocsCourants = c.blocs;
  await ecrireBloc(c, "veille-exemple", blocAgent("Veille — exemple"), { "index.html": "<p>ancien</p>" });
  const { executer, appels } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: docker }],
    [/ claude /, reponseClaude],
  ]);
  const atelier = new Atelier({ chemins: c, docker: "docker", executer });
  const profil = (await chargerProfils(c)).profils[0]!;
  const p = new PlanificateurVeille({ chemins: c, atelier, profil, executer, horloge: () => maintenant });
  const etat = async (id: string) => JSON.parse(await readFile(join(c.blocs, id, "etat.json"), "utf8"));
  const lancements = () => appels.filter((a) => a.args.includes("claude"));
  return { c, p, etat, lancements, appels };
}

test("succès → statut ok et derniereMaj = maintenant, commande exacte", async () => {
  const { c, p, etat, lancements } = await preparer(agentEcrit("<p>neuf</p>"));
  expect(await p.verifier({ auLancement: true })).toEqual(["veille-exemple"]);
  expect(await etat("veille-exemple")).toEqual({
    statut: "ok", derniereMaj: maintenant.toISOString(), derniereTentative: maintenant.toISOString(),
  });
  const [appel] = lancements();
  expect([appel!.commande, ...appel!.args]).toEqual([
    "docker", "run", "--rm", "--name", "webaios-veille-veille-exemple",
    "-v", `${join(c.blocs, "veille-exemple")}:/workspace/accueil/blocs/veille-exemple`,
    "-v", `${join(c.racine, "AGENTS.md")}:/workspace/AGENTS.md:ro`,
    "-v", "webaios-home:/home/node",
    "-w", "/workspace", "webaios-atelier:1",
    "timeout", "-k", "10", "600",
    "claude", "--dangerously-skip-permissions", "-p",
    consigneVeille("veille-exemple", { titre: "Veille — exemple", type: "agent", consigne: "Cherche." }),
  ]);
  expect(appel!.opts?.delaiMs).toBe(10 * 60_000 + 30_000);
  expect(await readFile(join(c.blocs, "veille-exemple", "index.html"), "utf8")).toBe("<p>neuf</p>");
  expect(existsSync(join(c.blocs, "veille-exemple", "index.html.nouveau"))).toBe(false);
});

test("les blocs d'app (daily-dev) ne sont jamais lancés", async () => {
  const { p } = await preparer({ code: 0 });
  expect(await p.verifier({ auLancement: true })).not.toContain("daily-dev");
});

test("la veille n'a accès ni au jeton MCP ni au reste de l'espace", async () => {
  const { c, p, lancements } = await preparer(agentEcrit("<p>x</p>"));
  await p.verifier({ auLancement: true });
  expect(lancements()[0]!.args.slice(0, 2)).toEqual(["run", "--rm"]); // jamais dans l'atelier, qui monte tout l'espace
  const args = lancements()[0]!.args.join(" ");
  expect(args).not.toContain("mcp");
  expect(args).not.toContain(c.interne);
  expect(args).not.toContain(`${c.racine}:`);
  expect(args).not.toContain(" -p 127.0.0.1");
});

test("code 0 sans résultat écrit → erreur, ancien contenu gardé", async () => {
  const { c, p, etat } = await preparer({ code: 0 });
  await p.verifier({ auLancement: true });
  expect(await etat("veille-exemple")).toMatchObject({ statut: "erreur", erreur: "Aucun résultat écrit par l'agent" });
  expect(await readFile(join(c.blocs, "veille-exemple", "index.html"), "utf8")).toBe("<p>ancien</p>");
});

test("échec après une écriture partielle → le brouillon est jeté, ancien contenu gardé", async () => {
  const { c, p } = await preparer(agentEcrit("<p>moiti", 1));
  await p.verifier({ auLancement: true });
  expect(existsSync(join(c.blocs, "veille-exemple", "index.html.nouveau"))).toBe(false);
  expect(await readFile(join(c.blocs, "veille-exemple", "index.html"), "utf8")).toBe("<p>ancien</p>");
});

test("pendant l'exécution, le bloc est en-cours", async () => {
  let vu: unknown;
  const { p, etat } = await preparer(async () => {
    vu = await etat("veille-exemple");
    return { code: 0 };
  });
  await p.verifier({ auLancement: true });
  expect(vu).toMatchObject({ statut: "en-cours", derniereMaj: null });
});

test("échec → erreur avec stderr, index.html et derniereMaj intacts", async () => {
  const { c, p, etat } = await preparer({ code: 1, stderr: "x".repeat(800) });
  await ecrireBloc(c, "veille-exemple", blocAgent("Veille — exemple"), {
    "etat.json": JSON.stringify({ statut: "ok", derniereMaj: "2026-10-24T08:00:00.000Z", derniereTentative: null }),
  });
  await p.verifier({ auLancement: true });
  const e = await etat("veille-exemple");
  expect(e.statut).toBe("erreur");
  expect(e.erreur).toBe("x".repeat(500));
  expect(e.derniereMaj).toBe("2026-10-24T08:00:00.000Z");
  expect(await readFile(join(c.blocs, "veille-exemple", "index.html"), "utf8")).toBe("<p>ancien</p>");
});

test("délai dépassé → erreur « Délai dépassé » et le conteneur de veille est supprimé", async () => {
  const { p, etat, appels } = await preparer({ code: CODE_DELAI_DEPASSE, stderr: "Délai dépassé" });
  await p.verifier({ auLancement: true });
  expect((await etat("veille-exemple")).erreur).toBe("Délai dépassé");
  expect(appels.some((a) => a.args.join(" ") === "rm -f webaios-veille-veille-exemple")).toBe(true);
});

test("conteneur non démarré → rien n'est lancé", async () => {
  const { p, lancements } = await preparer({ code: 0 }, "false\n");
  expect(await p.verifier({ auLancement: true })).toEqual([]);
  expect(lancements()).toHaveLength(0);
});

test("demarrer lance la vérification de lancement sans bloquer, arreter coupe la minuterie", async () => {
  let fin!: () => void;
  const termine = new Promise<void>((ok) => (fin = ok));
  const { p, etat } = await preparer(async () => {
    const r = await agentEcrit("<p>x</p>")();
    fin();
    return r;
  });
  await p.demarrer();
  await termine;
  await new Promise((r) => setTimeout(r, 50));
  p.arreter();
  expect((await etat("veille-exemple")).statut).toBe("ok");
});

test("options explicitement undefined → valeurs par défaut (horloge, délais)", async () => {
  const { c } = await preparer({ code: 0 });
  const { executer, appels } = executeurFactice([[/ info$/, { code: 0 }], [/ inspect -f/, { code: 0, stdout: "true\n" }]]);
  const atelier = new Atelier({ chemins: c, docker: "docker", executer });
  const profil = (await chargerProfils(c)).profils[0]!;
  const p = new PlanificateurVeille({ chemins: c, atelier, profil, executer, horloge: undefined, delaiMs: undefined });
  expect(await p.verifier({ auLancement: true })).toEqual(["veille-exemple"]);
  expect(appels.find((a) => a.args.includes("claude"))!.opts?.delaiMs).toBe(10 * 60_000 + 30_000);
});

test("une erreur pendant la vérification de fond ne devient pas un rejet non géré", async () => {
  const { c } = await preparer({ code: 0 });
  const executer = async () => {
    throw new Error("boum");
  };
  const atelier = new Atelier({ chemins: c, docker: "docker", executer });
  const profil = (await chargerProfils(c)).profils[0]!;
  const rejets: unknown[] = [];
  const surRejet = (e: unknown) => rejets.push(e);
  process.on("unhandledRejection", surRejet);
  const p = new PlanificateurVeille({ chemins: c, atelier, profil, executer, horloge: () => maintenant });
  await p.demarrer();
  await new Promise((r) => setTimeout(r, 100));
  p.arreter();
  process.off("unhandledRejection", surRejet);
  expect(rejets).toEqual([]);
});

test("échec sans stderr → le message de stdout est gardé (ex. agent non connecté)", async () => {
  const { p, etat } = await preparer({ code: 1, stdout: "Not logged in · Please run /login\n" });
  await p.verifier({ auLancement: true });
  expect((await etat("veille-exemple")).erreur).toBe("Not logged in · Please run /login");
});

test("arreter pendant une veille : son conteneur est supprimé, on l'attend, et le bloc retrouve son état d'avant", async () => {
  let lance!: () => void;
  const enRoute = new Promise<void>((ok) => (lance = ok));
  let tuer!: () => void;
  const tue = new Promise<Reponse>((ok) => (tuer = () => ok({ code: 137 })));
  const { c, p, etat, appels } = await preparer(async () => {
    await writeFile(join(blocsCourants, "veille-exemple", "index.html.nouveau"), "<p>à moitié</p>");
    lance();
    return tue;
  });
  const avant = { statut: "ok", derniereMaj: "2026-10-24T08:00:00.000Z", derniereTentative: null };
  await ecrireBloc(c, "veille-exemple", blocAgent("Veille — exemple"), { "etat.json": JSON.stringify(avant) });
  const verification = p.verifier({ auLancement: true });
  await enRoute;
  // Le faux « docker rm -f » tue la veille, comme le vrai.
  const rm = appels.length;
  const arret = p.arreter();
  await expect.poll(() => appels.slice(rm).some((a) => a.args.join(" ") === "rm -f webaios-veille-veille-exemple")).toBe(true);
  tuer();
  await arret;
  await verification;
  expect(await etat("veille-exemple")).toEqual(avant);
  expect(existsSync(join(c.blocs, "veille-exemple", "index.html.nouveau"))).toBe(false);
  expect(await readFile(join(c.blocs, "veille-exemple", "index.html"), "utf8")).toBe("<p>ancien</p>");
});
