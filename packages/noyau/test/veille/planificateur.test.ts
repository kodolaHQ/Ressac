import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
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

async function preparer(reponseClaude: Reponse | (() => Reponse | Promise<Reponse>), docker = "true\n") {
  const c = cheminsEspace(await dossierTemporaire());
  await initialiserEspace(c);
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
  return { c, p, etat, lancements };
}

test("succès → statut ok et derniereMaj = maintenant, commande exacte", async () => {
  const { p, etat, lancements } = await preparer({ code: 0 });
  expect(await p.verifier({ auLancement: true })).toEqual(["veille-exemple"]);
  expect(await etat("veille-exemple")).toEqual({
    statut: "ok", derniereMaj: maintenant.toISOString(), derniereTentative: maintenant.toISOString(),
  });
  const [appel] = lancements();
  expect([appel!.commande, ...appel!.args]).toEqual([
    "docker", "exec", "-w", "/workspace", "webaios-atelier", "claude", "--dangerously-skip-permissions", "-p",
    consigneVeille("veille-exemple", { titre: "Veille — exemple", type: "agent", consigne: "Cherche." }),
  ]);
  expect(appel!.opts?.delaiMs).toBe(10 * 60_000);
});

test("les blocs d'app (daily-dev) ne sont jamais lancés", async () => {
  const { p } = await preparer({ code: 0 });
  expect(await p.verifier({ auLancement: true })).not.toContain("daily-dev");
});

test("la commande de veille ne contient jamais --mcp-config", async () => {
  const { p, lancements } = await preparer({ code: 0 });
  await p.verifier({ auLancement: true });
  expect(lancements()[0]!.args.join(" ")).not.toContain("mcp");
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

test("délai dépassé → erreur « Délai dépassé »", async () => {
  const { p, etat } = await preparer({ code: CODE_DELAI_DEPASSE, stderr: "Délai dépassé" });
  await p.verifier({ auLancement: true });
  expect((await etat("veille-exemple")).erreur).toBe("Délai dépassé");
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
    fin();
    return { code: 0 };
  });
  await p.demarrer();
  await termine;
  await new Promise((r) => setTimeout(r, 50));
  p.arreter();
  expect((await etat("veille-exemple")).statut).toBe("ok");
});
