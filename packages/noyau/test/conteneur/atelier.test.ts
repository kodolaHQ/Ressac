import { expect, test } from "vitest";
import { cheminsEspace } from "../../src/chemins.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { Atelier, DELAI_CONSTRUCTION_MS, IMAGE, empreinteDockerfile, scriptArretSession, trouverDocker } from "../../src/conteneur/atelier.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
    "/opt/homebrew/bin/docker", "exec", "-it", "-e", "WEBAIOS_SESSION=ab12", "-w", "/workspace", "webaios-atelier",
    "sh", "-c", `echo $$ > ${pid}; exec "$@"`, "webaios-session", "claude", "--x",
  ]);
  await a.arreterSession("ab12");
  const appel = appels.find((x) => x.args[0] === "exec")!;
  expect(appel.args.slice(0, 4)).toEqual(["exec", "webaios-atelier", "sh", "-c"]);
  expect(appel.args[4]).toContain(`cat ${pid}`);
  expect(appel.args[4]).toBe(scriptArretSession(pid, "ab12"));
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

const vivant = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("le script d'arrêt tue un agent qui ignore HUP et TERM (claude les intercepte), et tout son groupe", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "webaios-arret-")), "session.pid");
  // Comme commandeSession : le shell note son PID puis devient l'agent ; ici un agent sourd à HUP et TERM, avec un enfant.
  const agent = spawn("sh", ["-c", `echo $$ > ${f}; exec "$@"`, "webaios-session", "sh", "-c", "trap '' HUP TERM; sleep 60 & wait"], {
    detached: true,
    stdio: "ignore",
  });
  const fini = new Promise((ok) => agent.on("exit", ok));
  await expect.poll(() => existsSync(f)).toBe(true);
  const debut = Date.now();
  await new Promise<void>((ok, ko) => execFile("sh", ["-c", scriptArretSession(f, "local")], (e) => (e ? ko(e) : ok())));
  await fini;
  expect(Date.now() - debut).toBeLessThan(8000);
  expect(vivant(agent.pid!)).toBe(false);
  expect(existsSync(f)).toBe(false);
  // Plus aucun processus du groupe (le sleep lancé par l'agent).
  expect(() => process.kill(-agent.pid!, 0)).toThrow();
}, 15_000);

test("commandeApplication", () => {
  const a = new Atelier({ chemins, docker: "/opt/homebrew/bin/docker" });
  expect(a.commandeApplication("todo", "npx vite --port {port}", 5281)).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-e", "WEBAIOS_APP=todo", "-e", "PORT=5281", "-w", "/workspace/projets/todo", "webaios-atelier",
    "sh", "-c", `mkdir -p /workspace/.webaios/journaux; exec >"/workspace/.webaios/journaux/$1.log" 2>&1; eval "$2"`,
    "webaios-app", "todo", "npx vite --port 5281",
  ]);
});

test("arreterApplication ne vise que sa marque", async () => {
  const { executer, appels } = executeurFactice([]);
  await new Atelier({ chemins, docker: "docker", executer }).arreterApplication("todo");
  const appel = appels.find((x) => x.args[0] === "exec")!;
  expect(appel.args.slice(0, 4)).toEqual(["exec", "webaios-atelier", "sh", "-c"]);
  expect(appel.args[4]).toContain("WEBAIOS_APP=todo");
  expect(appel.args[4]).not.toContain("WEBAIOS_SESSION");
  expect(appel.args[4]).toContain("signaler KILL");
  await expect(new Atelier({ chemins, docker: "docker", executer }).arreterApplication("x'y")).rejects.toThrow();
});

test("arreterApplicationsOrphelines vise WEBAIOS_APP=.*", async () => {
  const { executer, appels } = executeurFactice([]);
  await new Atelier({ chemins, docker: "docker", executer }).arreterApplicationsOrphelines();
  const script = appels.find((x) => x.args[0] === "exec")!.args[4]!;
  expect(script).toContain("WEBAIOS_APP=.*");
  expect(script).not.toContain("WEBAIOS_SESSION");
});

test("arreterApplication : le point d'un nom de dossier n'est pas un joker de grep", async () => {
  const { executer, appels } = executeurFactice([]);
  await new Atelier({ chemins, docker: "docker", executer }).arreterApplication("my.app");
  const script = appels.find((x) => x.args[0] === "exec")!.args[4]!;
  const motif = /grep -qzx '([^']*)'/.exec(script)![1]!;
  expect(motif).toBe("WEBAIOS_APP=my\\.app");
  // Le motif tel que grep le lit : « my.app » est visé, « myxapp » ne l'est pas.
  const vise = (valeur: string) =>
    new Promise<boolean>((ok) => execFile("sh", ["-c", `printf '%s' "$1" | grep -qx "$2"`, "sh", valeur, motif], (e) => ok(!e)));
  expect(await vise("WEBAIOS_APP=my.app")).toBe(true);
  expect(await vise("WEBAIOS_APP=myxapp")).toBe(false);
});

test("commandeRecolte monte le moteur en lecture seule et lance /opt/webaios/moteur/recolteur.mjs", () => {
  const atelier = new Atelier({ chemins, docker: "/usr/local/bin/docker" });
  const c = atelier.commandeRecolte("meteo", "/Users/t/WebAiOs/accueil/widgets/meteo", "/app/docker/moteur");
  expect(c).toEqual([
    "/usr/local/bin/docker", "run", "-i", "--rm",
    "--name", "webaios-recolte-meteo",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp",
    "-v", "/Users/t/WebAiOs/accueil/widgets/meteo:/widget:ro",
    "-v", "/app/docker/moteur:/opt/webaios/moteur:ro",
    "--memory", "512m",
    "--pids-limit", "128",
    IMAGE,
    "timeout", "-k", "5", "180",
    "node", "/opt/webaios/moteur/recolteur.mjs", "/widget",
  ]);
  // Le dossier du moteur est monté tel quel, pas son parent : rien d'autre du paquet n'entre dans le conteneur.
  expect(() => atelier.commandeRecolte("meteo", "/d", "/app/x:y")).toThrow();
});
