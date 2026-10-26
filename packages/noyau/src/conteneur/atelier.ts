import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

/** Dossier du Dockerfile dans le paquet ; un navigateur qui embarque le noyau peut en fournir un autre. */
export const DOSSIER_DOCKER_PAR_DEFAUT = join(import.meta.dirname, "..", "..", "docker");
const dockerfile = (dossier: string) => join(dossier, "atelier.Dockerfile");
const LABEL_EMPREINTE = "webaios.dockerfile";

/** Empreinte du Dockerfile : l'image et le conteneur la portent en label, pour savoir s'ils sont à jour. */
export function empreinteDockerfile(dossierDocker = DOSSIER_DOCKER_PAR_DEFAUT): string {
  return createHash("sha256").update(readFileSync(dockerfile(dossierDocker))).digest("hex").slice(0, 12);
}

function normaliser(chemin: string): string {
  try {
    return realpathSync(chemin);
  } catch {
    return chemin;
  }
}

const nomVeille = (id: string) => `webaios-veille-${id}`;

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
    ...(env.HOME ? [join(env.HOME, ".orbstack", "bin", "docker"), join(env.HOME, ".docker", "bin", "docker")] : []),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  return candidats.find((c) => existe(c)) ?? null;
}

export class Atelier {
  private readonly chemins: CheminsEspace;
  private readonly executer: Executeur;
  private readonly docker: string | null;
  private readonly dossierDocker: string;

  constructor(o: { chemins: CheminsEspace; executer?: Executeur; docker?: string | null; dossierDocker?: string }) {
    this.dossierDocker = o.dossierDocker ?? DOSSIER_DOCKER_PAR_DEFAUT;
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

  /** Le conteneur existant est-il monté sur la bonne racine et construit depuis le Dockerfile actuel ? */
  private async conteneurAJour(empreinte: string): Promise<boolean> {
    const format = `{{range .Mounts}}{{if eq .Destination "${CHEMIN_CONTENEUR}"}}{{.Source}}{{end}}{{end}}|{{index .Config.Labels "${LABEL_EMPREINTE}"}}`;
    const r = await this.lancer(["inspect", "-f", format, NOM_CONTENEUR], DELAI_SONDE_MS);
    const [source = "", label = ""] = r.stdout.trim().split("|");
    return r.code === 0 && normaliser(source) === normaliser(this.chemins.racine) && label === empreinte;
  }

  async assurerDemarre(): Promise<EtatAtelier> {
    let etat = await this.etat();
    if (etat === "docker-absent") return etat;
    const empreinte = empreinteDockerfile(this.dossierDocker);
    // Un conteneur créé sur un autre dossier ou avec un ancien Dockerfile est recréé ; /workspace et
    // le volume des identifiants sont conservés, seule la couche du conteneur est perdue.
    if (etat !== "absent" && !(await this.conteneurAJour(empreinte))) {
      await this.lancer(["rm", "-f", NOM_CONTENEUR], DELAI_SONDE_MS);
      etat = "absent";
    }
    if (etat === "demarre") return etat;
    if (etat === "arrete") {
      await this.lancer(["start", NOM_CONTENEUR], DELAI_SONDE_MS);
      return this.etat();
    }
    const image = await this.lancer(["image", "inspect", "-f", `{{index .Config.Labels "${LABEL_EMPREINTE}"}}`, IMAGE], DELAI_SONDE_MS);
    if (image.code !== 0 || image.stdout.trim() !== empreinte) {
      const build = await this.lancer(["build", "-t", IMAGE, "--label", `${LABEL_EMPREINTE}=${empreinte}`, "-f", dockerfile(this.dossierDocker), this.dossierDocker]);
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

  /**
   * Veille dans un conteneur jetable : seul le dossier du bloc est monté (et AGENTS.md en lecture),
   * donc ni le jeton MCP ni le reste de l'espace. `timeout` arrête l'agent *dans* le conteneur :
   * tuer le client docker local ne suffirait pas.
   */
  commandeVeille(id: string, argv: string[], delaiS: number): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    return [
      this.docker, "run", "--rm",
      "--name", nomVeille(id),
      "-v", `${join(this.chemins.blocs, id)}:${CHEMIN_CONTENEUR}/accueil/blocs/${id}`,
      "-v", `${join(this.chemins.racine, "AGENTS.md")}:${CHEMIN_CONTENEUR}/AGENTS.md:ro`,
      "-v", `${VOLUME_HOME}:/home/node`,
      "-w", CHEMIN_CONTENEUR,
      IMAGE,
      "timeout", "-k", "10", String(delaiS),
      ...argv,
    ];
  }

  async supprimerVeille(id: string): Promise<void> {
    if (this.docker) await this.lancer(["rm", "-f", nomVeille(id)], DELAI_SONDE_MS);
  }

  commandeExec(argv: string[], o: { interactif: boolean }): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    return [this.docker, "exec", ...(o.interactif ? ["-it"] : []), "-w", CHEMIN_CONTENEUR, NOM_CONTENEUR, ...argv];
  }
}
