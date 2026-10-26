import { expect, test } from "vitest";
import { cheminsEspace } from "../../src/chemins.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { Atelier, DELAI_CONSTRUCTION_MS, empreinteDockerfile, trouverDocker } from "../../src/conteneur/atelier.js";
import { DOSSIERS_OUTILS } from "../../src/conteneur/executeur.js";
import { executeurFactice } from "../aide/executeur-factice.js";

const chemins = cheminsEspace("/Users/t/WebAiOs");

test("docker introuvable → docker-absent, sans exception", async () => {
  expect(await new Atelier({ chemins, docker: null }).etat()).toBe("docker-absent");
  expect(await new Atelier({ chemins, docker: null }).assurerDemarre()).toBe("docker-absent");
});

test("docker info en échec → docker-absent", async () => {
  const { executer } = executeurFactice([[/ info/, { code: 1, stderr: "Cannot connect" }]]);
  expect(await new Atelier({ chemins, docker: "docker", executer }).etat()).toBe("docker-absent");
});

test("trouverDocker trouve OrbStack hors du PATH", () => {
  expect(trouverDocker({ PATH: "/usr/bin", HOME: "/Users/t" }, (p) => p === "/Users/t/.orbstack/bin/docker")).toBe(
    "/Users/t/.orbstack/bin/docker",
  );
});

test("trouverDocker préfère le PATH, et renvoie null si rien", () => {
  expect(trouverDocker({ PATH: "/a:/b", HOME: "/h" }, (p) => p === "/b/docker" || p === "/usr/local/bin/docker")).toBe(
    "/b/docker",
  );
  expect(trouverDocker({ PATH: "/a", HOME: "/h" }, () => false)).toBeNull();
});

test("etat selon docker inspect", async () => {
  const cas: [ReturnType<typeof executeurFactice>, string][] = [
    [executeurFactice([[/ inspect /, { code: 0, stdout: "true\n" }]]), "demarre"],
    [executeurFactice([[/ inspect /, { code: 0, stdout: "false\n" }]]), "arrete"],
    [executeurFactice([[/ inspect /, { code: 1, stderr: "No such object" }]]), "absent"],
  ];
  for (const [{ executer }, attendu] of cas) {
    expect(await new Atelier({ chemins, docker: "docker", executer }).etat()).toBe(attendu);
  }
});

test("assurerDemarre sur absent : build si image manquante puis run avec les bons arguments", async () => {
  let lance = false;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: lance ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((lance = true), { code: 0 })],
  ]);
  expect(await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre()).toBe("demarre");
  const build = appels.find((a) => a.args[0] === "build")!;
  expect(build.args.slice(0, 3)).toEqual(["build", "-t", "webaios-atelier:1"]);
  expect(build.args).toContain("-f");
  const run = appels.find((a) => a.args[0] === "run")!;
  expect(run.args).toEqual(expect.arrayContaining([
    "--name", "webaios-atelier",
    "127.0.0.1:5280-5299:5280-5299",
    "webaios-home:/home/node",
    "/Users/t/WebAiOs:/workspace",
    "host.docker.internal:host-gateway",
    "webaios-atelier:1",
  ]));
  expect(run.args.slice(-2)).toEqual(["sleep", "infinity"]);
});

test("assurerDemarre sur arrete → docker start", async () => {
  let demarre = false;
  const { executer, appels } = executeurFactice([
    [/ inspect -f .*Mounts/, { code: 0, stdout: `${chemins.racine}|${empreinteDockerfile()}\n` }],
    [/ inspect -f/, () => ({ code: 0, stdout: demarre ? "true\n" : "false\n" })],
    [/ start /, () => ((demarre = true), { code: 0 })],
  ]);
  expect(await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre()).toBe("demarre");
  expect(appels.some((a) => a.args.join(" ") === "start webaios-atelier")).toBe(true);
  expect(appels.some((a) => a.args[0] === "run")).toBe(false);
});

test("commandeExec interactif et non interactif", () => {
  const a = new Atelier({ chemins, docker: "/opt/homebrew/bin/docker" });
  expect(a.commandeExec(["claude"], { interactif: true })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-w", "/workspace", "webaios-atelier", "claude",
  ]);
  expect(a.commandeExec(["claude", "-p", "x"], { interactif: false })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-w", "/workspace", "webaios-atelier", "claude", "-p", "x",
  ]);
});

test("les sondes docker ont un délai (Docker Desktop bloqué au démarrage)", async () => {
  const { executer, appels } = executeurFactice([[/ inspect /, { code: 0, stdout: "true\n" }]]);
  await new Atelier({ chemins, docker: "docker", executer }).etat();
  for (const a of appels) expect(a.opts?.delaiMs, a.args.join(" ")).toBeGreaterThan(0);
});

test("les ports publiés évitent ceux de Vite (5173…) : 5280-5299", async () => {
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
  ]);
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  expect(appels.find((a) => a.args[0] === "run")!.args).toContain("127.0.0.1:5280-5299:5280-5299");
});

test("trouverDocker trouve Docker Desktop installé par utilisateur (~/.docker/bin)", () => {
  expect(trouverDocker({ PATH: "/usr/bin", HOME: "/Users/t" }, (p) => p === "/Users/t/.docker/bin/docker")).toBe(
    "/Users/t/.docker/bin/docker",
  );
});

test("executeurParDefaut ajoute ~/.docker/bin au PATH (assistants d'identifiants)", () => {
  expect(DOSSIERS_OUTILS).toContain(join(homedir(), ".docker", "bin"));
});

// Conteneur existant créé sur un autre dossier ou avec un ancien Dockerfile → recréé.
function fauxDocker(o: { source: string; empreinteConteneur: string; empreinteImage: string; running?: string }) {
  let recree = false;
  const f = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 0, stdout: `${o.empreinteImage}\n` }],
    [/ inspect -f \{\{\.State\.Running\}\}/, () => ({ code: 0, stdout: recree ? "true\n" : (o.running ?? "true\n") })],
    [/ inspect -f .*Mounts/, () => ({ code: 0, stdout: recree ? "" : `${o.source}|${o.empreinteConteneur}\n` })],
    [/ rm -f webaios-atelier/, () => ((recree = true), { code: 0 })],
  ]);
  return f;
}

test("conteneur existant sur le bon dossier et la bonne image → gardé", async () => {
  const e = empreinteDockerfile();
  const { executer, appels } = fauxDocker({ source: chemins.racine, empreinteConteneur: e, empreinteImage: e });
  expect(await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre()).toBe("demarre");
  expect(appels.some((a) => a.args[0] === "rm")).toBe(false);
});

test("conteneur existant monté sur un autre dossier → supprimé puis recréé", async () => {
  const e = empreinteDockerfile();
  const { executer, appels } = fauxDocker({ source: "/tmp/ailleurs", empreinteConteneur: e, empreinteImage: e });
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  expect(appels.some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
  expect(appels.some((a) => a.args[0] === "run")).toBe(true);
});

test("Dockerfile modifié → image reconstruite et conteneur recréé", async () => {
  const { executer, appels } = fauxDocker({ source: chemins.racine, empreinteConteneur: "ancienne", empreinteImage: "ancienne" });
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  const build = appels.find((a) => a.args[0] === "build")!;
  expect(build.args).toContain(`webaios.dockerfile=${empreinteDockerfile()}`);
  expect(appels.some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
});

test("session interactive : son PID est noté dans le conteneur, et l'arrêter l'y tue (tuer le client docker ne suffit pas)", async () => {
  const { executer, appels } = executeurFactice([]);
  const a = new Atelier({ chemins, docker: "/opt/homebrew/bin/docker", executer });
  const pid = "/tmp/webaios-session-ab12.pid";
  expect(a.commandeSession("ab12", ["claude", "--x"])).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-w", "/workspace", "webaios-atelier",
    "sh", "-c", `echo $$ > ${pid}; exec "$@"`, "webaios-session", "claude", "--x",
  ]);
  await a.arreterSession("ab12");
  const appel = appels.find((x) => x.args[0] === "exec")!;
  expect(appel.args.slice(0, 4)).toEqual(["exec", "webaios-atelier", "sh", "-c"]);
  expect(appel.args[4]).toContain(`cat ${pid}`);
  expect(appel.args[4]).toContain("kill -HUP");
  expect(() => a.commandeSession("../x", ["claude"])).toThrow();
});

test("deux démarrages en même temps : une seule construction d'image et un seul conteneur", async () => {
  let finirBuild!: () => void;
  let lance = false;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: lance ? 0 : 1, stdout: "true\n" })],
    [/ build /, () => new Promise((ok) => (finirBuild = () => ok({ code: 0 })))],
    [/ run /, () => ((lance = true), { code: 0 })],
  ]);
  const atelier = new Atelier({ chemins, docker: "docker", executer });
  const a = atelier.assurerDemarre();
  const b = atelier.assurerDemarre();
  await new Promise((r) => setTimeout(r, 10));
  finirBuild();
  expect(await Promise.all([a, b])).toEqual(["demarre", "demarre"]);
  expect(appels.filter((x) => x.args[0] === "build")).toHaveLength(1);
  expect(appels.filter((x) => x.args[0] === "run")).toHaveLength(1);
});

test("après un échec, un nouveau démarrage réessaie", async () => {
  let echecs = 0;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, { code: 1 }],
    [/ build /, () => (echecs++, { code: 1, stderr: "réseau" })],
  ]);
  const atelier = new Atelier({ chemins, docker: "docker", executer });
  await expect(atelier.assurerDemarre()).rejects.toThrow("réseau");
  await expect(atelier.assurerDemarre()).rejects.toThrow("réseau");
  expect(appels.filter((x) => x.args[0] === "build")).toHaveLength(2);
});

test("construction et lancement du conteneur ont un délai maximal", async () => {
  let lance = false;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: lance ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((lance = true), { code: 0 })],
  ]);
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  for (const a of appels) expect(a.opts?.delaiMs, a.args.join(" ")).toBeGreaterThan(0);
  expect(appels.find((a) => a.args[0] === "build")!.opts?.delaiMs).toBe(DELAI_CONSTRUCTION_MS);
});
