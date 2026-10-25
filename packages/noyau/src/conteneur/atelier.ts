import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHEMIN_CONTENEUR, type CheminsEspace } from "../chemins.js";
import { executeurParDefaut, type Executeur } from "./executeur.js";

export const NOM_CONTENEUR = "webaios-atelier";
export const IMAGE = "webaios-atelier:1";
export const VOLUME_HOME = "webaios-home";
/** Hors de la plage de Vite (5173, 5174…) pour ne pas entrer en conflit avec un serveur lancé sur le Mac. */
export const PORTS = "5280-5299";
/** Les sondes docker ne doivent pas bloquer si Docker Desktop est coincé au démarrage. */
const DELAI_SONDE_MS = 30_000;

const DOSSIER_DOCKER = join(import.meta.dirname, "..", "..", "docker");

export type EtatAtelier = "docker-absent" | "absent" | "arrete" | "demarre";

/** Cherche la CLI docker dans le PATH puis aux emplacements connus (Finder n'a pas le PATH du shell). */
export function trouverDocker(
  env: NodeJS.ProcessEnv = process.env,
  existe: (chemin: string) => boolean = existsSync,
): string | null {
  const candidats = [
    ...(env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "docker")),
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    ...(env.HOME ? [join(env.HOME, ".orbstack", "bin", "docker")] : []),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  return candidats.find((c) => existe(c)) ?? null;
}

export class Atelier {
  private readonly chemins: CheminsEspace;
  private readonly executer: Executeur;
  private readonly docker: string | null;

  constructor(o: { chemins: CheminsEspace; executer?: Executeur; docker?: string | null }) {
    this.chemins = o.chemins;
    this.executer = o.executer ?? executeurParDefaut;
    this.docker = o.docker === undefined ? trouverDocker() : o.docker;
  }

  private lancer(args: string[], delaiMs?: number) {
    return this.executer(this.docker!, args, delaiMs ? { delaiMs } : undefined);
  }

  async etat(): Promise<EtatAtelier> {
    if (!this.docker || (await this.lancer(["info"], DELAI_SONDE_MS)).code !== 0) return "docker-absent";
    const r = await this.lancer(["inspect", "-f", "{{.State.Running}}", NOM_CONTENEUR], DELAI_SONDE_MS);
    if (r.code !== 0) return "absent";
    return r.stdout.trim() === "true" ? "demarre" : "arrete";
  }

  async assurerDemarre(): Promise<EtatAtelier> {
    const etat = await this.etat();
    if (etat === "docker-absent" || etat === "demarre") return etat;
    if (etat === "arrete") {
      await this.lancer(["start", NOM_CONTENEUR], DELAI_SONDE_MS);
      return this.etat();
    }
    if ((await this.lancer(["image", "inspect", IMAGE], DELAI_SONDE_MS)).code !== 0) {
      const build = await this.lancer(["build", "-t", IMAGE, "-f", join(DOSSIER_DOCKER, "atelier.Dockerfile"), DOSSIER_DOCKER]);
      if (build.code !== 0) throw new Error(`Construction de l'image ${IMAGE} impossible : ${build.stderr}`);
    }
    const run = await this.lancer([
      "run", "-d",
      "--name", NOM_CONTENEUR,
      "--add-host", "host.docker.internal:host-gateway",
      "-v", `${this.chemins.racine}:${CHEMIN_CONTENEUR}`,
      "-v", `${VOLUME_HOME}:/home/node`,
      "-p", `127.0.0.1:${PORTS}:${PORTS}`,
      "-w", CHEMIN_CONTENEUR,
      IMAGE,
      "sleep", "infinity",
    ]);
    if (run.code !== 0) throw new Error(`Démarrage du conteneur ${NOM_CONTENEUR} impossible : ${run.stderr}`);
    return this.etat();
  }

  commandeExec(argv: string[], o: { interactif: boolean }): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    return [this.docker, "exec", ...(o.interactif ? ["-it"] : []), "-w", CHEMIN_CONTENEUR, NOM_CONTENEUR, ...argv];
  }
}
