#!/usr/bin/env node
// Fake docker for the end-to-end tests: no real container, no network. See plan 3.
const { createHash } = require("node:crypto");
const { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const env = process.env;
const echec = env.FAUX_DOCKER_ECHEC === "1";
const sortir = (code, out = "", err = "") => {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
};

// FAUX_DOCKER_LENT: Docker that is starting up, `docker info` only answers after 8 s.
if (args[0] === "info" && env.FAUX_DOCKER_LENT === "1") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000);
if (args[0] === "info") sortir(env.FAUX_DOCKER_ABSENT === "1" ? 1 : 0);
if (args[0] === "inspect") {
  if (echec) sortir(1, "", "No such object");
  const format = args[2] ?? "";
  if (format.includes("State.Running")) sortir(0, "true\n");
  const dockerfile = join(__dirname, "..", "..", "..", "..", "packages", "kernel", "docker", "atelier.Dockerfile");
  const empreinte = createHash("sha256").update(readFileSync(dockerfile)).digest("hex").slice(0, 12);
  sortir(0, `${env.WEBAIOS_RACINE}|${empreinte}\n`);
}
/** PID of the `run` client of a harvest in progress, by container name. */
const fichierRecolte = (nom) => join(env.WEBAIOS_RACINE, `faux-docker-${nom}.pid`);

/** A run's container: a widget's harvest or an action's run. */
const estExecution = (nom) => (nom ?? "").startsWith("webaios-recolte-") || (nom ?? "").startsWith("webaios-action-");

// A widget's harvest or an action's run (Workshop.commandeRecolte):
// `run -i --rm … --name webaios-recolte-<id> (or webaios-action-<id>) … node <harvester> /widget`.
// The harvester runs on the Mac (node), with the host paths recovered from the `-v host:container`. The kernel
// must cut the container's network: without `--network none`, the harvest fails.
if (args[0] === "run" && args.includes("-i") && estExecution(args[args.indexOf("--name") + 1])) {
  const reseau = args.indexOf("--network");
  if (reseau < 0 || args[reseau + 1] !== "none") sortir(1, "", "faux docker : --network none manquant\n");
  const montages = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-v") continue;
    const [hote, conteneur] = args[++i].split(":");
    montages.set(conteneur, hote);
  }
  // A path under a mounted folder (the engine: /opt/webaios/moteur/recolteur.mjs) is recovered by its prefix.
  const versHote = (c) => {
    if (montages.has(c)) return montages.get(c);
    for (const [conteneur, hote] of montages) if (c.startsWith(conteneur + "/")) return hote + c.slice(conteneur.length);
    return c;
  };
  const node = args.indexOf("node", args.indexOf("--name"));
  const [recolteur, widget] = args.slice(node + 1).map(versHote);
  const enfant = spawn(process.execPath, [recolteur, widget], { stdio: "inherit" });
  // Noted for `rm -f <name>`, which kills the container like the real docker (the `run` client then returns 137).
  const fichier = fichierRecolte(args[args.indexOf("--name") + 1]);
  writeFileSync(fichier, String(process.pid));
  let tue = false;
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"])
    process.on(signal, () => {
      tue = true;
      enfant.kill("SIGKILL");
    });
  enfant.on("exit", (code) => {
    rmSync(fichier, { force: true });
    process.exit(tue ? 137 : (code ?? 1));
  });
  return;
}
// Forced removal of a run container (Workshop.supprimerRecolte): the running harvester is killed.
if (args[0] === "rm" && args[1] === "-f" && estExecution(args[2])) {
  const fichier = fichierRecolte(args[2]);
  if (existsSync(fichier)) {
    try {
      process.kill(Number(readFileSync(fichier, "utf8")), "SIGTERM");
    } catch {
      // already finished
    }
  }
  sortir(0);
}
if (args[0] === "run" && args[1] === "--rm") sortir(1);
if (["image", "build", "run"].includes(args[0])) sortir(echec ? 1 : 0, "", echec ? "échec simulé" : "");
/** PID of a launched app's group (its shell, group leader). */
const fichierApp = (dossier) => join(env.WEBAIOS_RACINE, `faux-docker-app-${dossier}.pid`);

/** Kills the group of each app targeted by a stop script (`WEBAIOS_APP=<folder>` or `WEBAIOS_APP=.*`). */
function arreterApplications(script) {
  // The dot of a folder name is escaped for grep (`my\.app`).
  const motif = /WEBAIOS_APP=(\.\*|(?:[A-Za-z0-9_-]|\\\.)+)/.exec(script)?.[1]?.replaceAll("\\.", ".");
  if (!motif) return;
  const fichiers =
    motif === ".*"
      ? readdirSync(env.WEBAIOS_RACINE).filter((f) => /^faux-docker-app-.*\.pid$/.test(f)).map((f) => join(env.WEBAIOS_RACINE, f))
      : [fichierApp(motif)];
  for (const f of fichiers) {
    if (!existsSync(f)) continue;
    try {
      process.kill(-Number(readFileSync(f, "utf8")), "SIGTERM");
    } catch {
      // already stopped
    }
    rmSync(f, { force: true });
  }
}

/**
 * Launch of an app (Workshop.commandeApplication): the shell runs on the Mac, /workspace becoming WEBAIOS_RACINE,
 * in its own group (like the container's processes, which the stop targets by their mark).
 */
function lancerApplication(options, commande) {
  const local = (s) => s.replaceAll("/workspace", env.WEBAIOS_RACINE);
  const variables = {};
  let dossier = "/workspace";
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "-e") {
      const [cle, ...valeur] = local(options[++i]).split("=");
      variables[cle] = valeur.join("=");
    } else if (options[i] === "-w") dossier = options[++i];
  }
  const [programme, ...reste] = commande.map(local);
  const enfant = spawn(programme, reste, { cwd: local(dossier), env: { ...env, ...variables }, stdio: "inherit", detached: true });
  writeFileSync(fichierApp(variables.WEBAIOS_APP), String(enfant.pid));
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"])
    process.on(signal, () => {
      try {
        process.kill(-enfant.pid, signal);
      } catch {
        // already stopped
      }
    });
  enfant.on("exit", (code) => process.exit(code ?? 1));
}

if (args[0] === "exec") {
  const options = args.slice(1, args.indexOf("webaios-atelier"));
  let commande = args.slice(args.indexOf("webaios-atelier") + 1);
  if (options.some((o) => o.startsWith("WEBAIOS_APP="))) {
    lancerApplication(options, commande);
    return;
  }
  // Stop of a session or an app in the container (Workshop.arreterSession, arreterApplication…): noted for the
  // tests; the targeted apps are killed beforehand, the log is the proof of the stop.
  if (commande[0] === "sh" && !commande[2].includes('exec "$@"')) {
    arreterApplications(commande[2]);
    appendFileSync(join(env.WEBAIOS_RACINE, "faux-docker-arrets.log"), `${commande[2]}\n`);
    sortir(0);
  }
  // Interactive session (Workshop.commandeSession): sh -c '<notes the PID>; exec "$@"' webaios-session <agent…>
  if (commande[0] === "sh") commande = commande.slice(4);
  const r = spawnSync(process.execPath, [join(__dirname, "fake-agent.mjs"), ...commande], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
sortir(0);
