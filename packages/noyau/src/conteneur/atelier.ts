import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { dossierValide } from "../applications/manifeste.js";
import { CHEMIN_CONTENEUR, type CheminsEspace } from "../chemins.js";
import type { Proprietaire } from "../workflows/schema.js";
import { executeurParDefaut, type Executeur } from "./executeur.js";

export const NOM_CONTENEUR = "webaios-atelier";
// Read on every call so a second app (Firefox build) can run its own container.
export const nomConteneur = (): string => process.env.WEBAIOS_CONTENEUR || NOM_CONTENEUR;
export const IMAGE = "webaios-atelier:1";
export const VOLUME_HOME = "webaios-home";
/** Hors de la plage de Vite (5173, 5174…) pour ne pas entrer en conflit avec un serveur lancé sur le Mac. */
export const PORTS = "5280-5299";
/** Les sondes docker ne doivent pas bloquer si Docker Desktop est coincé au démarrage. */
const DELAI_SONDE_MS = 30_000;
/** Première construction : téléchargement de l'image de base et installation de l'agent. Au-delà, c'est bloqué. */
export const DELAI_CONSTRUCTION_MS = 20 * 60_000;

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

/**
 * Nom du conteneur d'une exécution : `webaios-recolte-<id>` pour un widget (un id seul est celui d'un widget),
 * `webaios-action-<id>` pour une action. L'id entre dans un nom docker, on refuse tout id douteux.
 */
export function nomRecolte(p: string | Proprietaire): string {
  const { type, id } = typeof p === "string" ? { type: "widget" as const, id: p } : p;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id ${type === "widget" ? "de widget" : "d'action"} invalide : ${id}`);
  return type === "widget" ? `webaios-recolte-${id}` : `webaios-action-${id}`;
}

/** Durée maximale d'une récolte dans son conteneur (secondes), avant SIGTERM puis SIGKILL 5 s après. */
export const DELAI_RECOLTE_S = 180;

/** Le dossier d'une appli entre dans une expression grep entre apostrophes : on refuse tout nom douteux. */
function dossierApplication(dossier: string): string {
  if (!dossierValide(dossier)) throw new Error(`dossier d'application invalide : ${dossier}`);
  return dossier;
}

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

function fichierSession(id: string): string {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`id de session invalide : ${id}`);
  return `/tmp/webaios-session-${id}.pid`;
}

/** Variable posée sur chaque session : tout ce que l'agent lance en hérite, même détaché de son groupe (nohup, setsid). */
export const VARIABLE_SESSION = "WEBAIOS_SESSION";

/**
 * Envoie HUP, puis TERM, puis KILL aux processus que liste la fonction shell `cibles` (pid, ou -pgid pour un groupe).
 * claude intercepte HUP et TERM sans forcément quitter : chaque signal a 2 s pour agir.
 */
function escalade(cibles: string): string[] {
  return [
    `cibles() { ${cibles}; }`,
    // Pas de « -- » : le kill de dash (sh du conteneur) le refuse, et le groupe ne serait jamais visé.
    `signaler() { for c in $(cibles); do kill -$1 "$c" 2>/dev/null; done; }`,
    `vivant() { for c in $(cibles); do kill -0 "$c" 2>/dev/null && return 0; done; return 1; }`,
    `for s in HUP TERM; do signaler $s; i=0; while [ $i -lt 20 ] && vivant; do sleep 0.1; i=$((i + 1)); done; vivant || exit 0; done`,
    `signaler KILL`,
  ];
}

/** Processus qui portent la marque `motif` (expression grep sur une variable d'environnement entière). */
const marques = (motif: string) =>
  `for d in /proc/[0-9]*; do grep -qzx '${motif}' "$d/environ" 2>/dev/null && echo "\${d#/proc/}"; done`;

/** Un texte lu tel quel par grep (expression de base) : « my.app » ne vise pas « myxapp ». */
const litteral = (texte: string) => texte.replace(/[\\.*[\]^$]/g, "\\$&");

/**
 * Arrête la session `id` dont le PID est noté dans `f` : son groupe (l'agent et ce qu'il a lancé), et tout processus
 * qui porte sa marque (un serveur de démo détaché par l'agent).
 */
export function scriptArretSession(f: string, id: string): string {
  return [
    `p=$(cat ${f} 2>/dev/null) || p=`,
    `rm -f ${f}`,
    ...escalade(`[ -n "$p" ] && echo "-$p $p"; ${marques(`${VARIABLE_SESSION}=${id}`)}`),
  ].join("\n");
}

/** Arrête toutes les sessions marquées, quelle que soit leur fenêtre (voir arreterSessionsOrphelines). */
export function scriptArretOrphelins(): string {
  return ["rm -f /tmp/webaios-session-*.pid", ...escalade(marques(`${VARIABLE_SESSION}=.*`))].join("\n");
}

/** Marque des processus d'une appli lancée : jamais confondue avec celle des sessions (`WEBAIOS_SESSION`). */
export const VARIABLE_APPLICATION = "WEBAIOS_APP";

export class Atelier {
  private readonly chemins: CheminsEspace;
  private readonly executer: Executeur;
  private readonly docker: string | null;
  private readonly dossierDocker: string;
  /** Démarrage en cours, partagé : deux fenêtres qui ouvrent un agent ne construisent pas deux fois l'image. */
  private demarrage: Promise<EtatAtelier> | null = null;

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
    const r = await this.lancer(["inspect", "-f", "{{.State.Running}}", nomConteneur()], DELAI_SONDE_MS);
    if (r.code !== 0) return "absent";
    return r.stdout.trim() === "true" ? "demarre" : "arrete";
  }

  /** Le conteneur existant est-il monté sur la bonne racine et construit depuis le Dockerfile actuel ? */
  private async conteneurAJour(empreinte: string): Promise<boolean> {
    const format = `{{range .Mounts}}{{if eq .Destination "${CHEMIN_CONTENEUR}"}}{{.Source}}{{end}}{{end}}|{{index .Config.Labels "${LABEL_EMPREINTE}"}}`;
    const r = await this.lancer(["inspect", "-f", format, nomConteneur()], DELAI_SONDE_MS);
    const [source = "", label = ""] = r.stdout.trim().split("|");
    return r.code === 0 && normaliser(source) === normaliser(this.chemins.racine) && label === empreinte;
  }

  assurerDemarre(): Promise<EtatAtelier> {
    this.demarrage ??= this.demarrer().finally(() => (this.demarrage = null));
    return this.demarrage;
  }

  private async demarrer(): Promise<EtatAtelier> {
    let etat = await this.etat();
    if (etat === "docker-absent") return etat;
    const empreinte = empreinteDockerfile(this.dossierDocker);
    // Un conteneur créé sur un autre dossier ou avec un ancien Dockerfile est recréé ; /workspace et
    // le volume des identifiants sont conservés, seule la couche du conteneur est perdue.
    if (etat !== "absent" && !(await this.conteneurAJour(empreinte))) {
      await this.lancer(["rm", "-f", nomConteneur()], DELAI_SONDE_MS);
      etat = "absent";
    }
    if (etat === "demarre") return etat;
    if (etat === "arrete") {
      await this.lancer(["start", nomConteneur()], DELAI_SONDE_MS);
      return this.etat();
    }
    const image = await this.lancer(["image", "inspect", "-f", `{{index .Config.Labels "${LABEL_EMPREINTE}"}}`, IMAGE], DELAI_SONDE_MS);
    if (image.code !== 0 || image.stdout.trim() !== empreinte) {
      const build = await this.lancer(["build", "-t", IMAGE, "--label", `${LABEL_EMPREINTE}=${empreinte}`, "-f", dockerfile(this.dossierDocker), this.dossierDocker], DELAI_CONSTRUCTION_MS);
      if (build.code !== 0) throw new Error(`Construction de l'image ${IMAGE} impossible : ${build.stderr}`);
    }
    const run = await this.lancer([
      "run", "-d",
      "--name", nomConteneur(),
      "--add-host", "host.docker.internal:host-gateway",
      "-v", `${this.chemins.racine}:${CHEMIN_CONTENEUR}`,
      "-v", `${VOLUME_HOME}:/home/node`,
      "-p", `127.0.0.1:${PORTS}:${PORTS}`,
      "-w", CHEMIN_CONTENEUR,
      IMAGE,
      "sleep", "infinity",
    ], DELAI_SONDE_MS);
    if (run.code !== 0) throw new Error(`Démarrage du conteneur ${nomConteneur()} impossible : ${run.stderr}`);
    return this.etat();
  }

  /**
   * Exécution d'un workflow, dans un conteneur jetable sans réseau : il ne voit que le dossier des fichiers et le dossier du
   * moteur (celui du récolteur et de ses modules), en lecture seule, et ne parle au noyau que par son entrée et sa
   * sortie standard (`-i`). `delaiS` : le conteneur est arrêté après ce délai (+5 s pour finir).
   */
  commandeRecolte(proprietaire: string | Proprietaire, dossierFichiers: string, moteur: string, delaiS: number = DELAI_RECOLTE_S): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    // « : » changerait le sens de -v (cible, options) : un tel chemin ne peut pas être monté sans risque.
    for (const c of [dossierFichiers, moteur]) if (c.includes(":")) throw new Error(`chemin non montable : ${c}`);
    return [
      this.docker, "run", "-i", "--rm",
      "--name", nomRecolte(proprietaire),
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "-v", `${dossierFichiers}:/widget:ro`,
      "-v", `${moteur}:/opt/webaios/moteur:ro`,
      "--memory", "512m",
      "--pids-limit", "128",
      IMAGE,
      "timeout", "-k", "5", String(delaiS),
      "node", "/opt/webaios/moteur/recolteur.mjs", "/widget",
    ];
  }

  /** Tuer le client `docker run` ne suffit pas : le conteneur est supprimé de force. */
  async supprimerRecolte(proprietaire: string | Proprietaire): Promise<void> {
    if (this.docker) await this.lancer(["rm", "-f", nomRecolte(proprietaire)], DELAI_SONDE_MS);
  }

  /**
   * Session interactive de l'agent : le shell note son PID dans le conteneur avant de devenir l'agent (exec), pour
   * que `arreterSession` puisse l'y tuer. Tuer le client `docker exec` local laisserait l'agent tourner.
   */
  commandeSession(id: string, argv: string[]): string[] {
    const f = fichierSession(id);
    return this.commandeExec(["sh", "-c", `echo $$ > ${f}; exec "$@"`, "webaios-session", ...argv], { interactif: true, env: { [VARIABLE_SESSION]: id } });
  }

  async arreterSession(id: string): Promise<void> {
    if (!this.docker) return;
    await this.lancer(["exec", nomConteneur(), "sh", "-c", scriptArretSession(fichierSession(id), id)], DELAI_SONDE_MS);
  }

  /**
   * Au lancement de l'app : les agents (et leurs serveurs) d'une app précédente qui n'a pas pu les arrêter (tuée net,
   * plantée) n'ont plus de fenêtre. Une seule app tourne à la fois sur l'atelier.
   */
  async arreterSessionsOrphelines(): Promise<void> {
    if (this.docker) await this.lancer(["exec", nomConteneur(), "sh", "-c", scriptArretOrphelins()], DELAI_SONDE_MS);
  }

  /**
   * Application d'un projet, lancée dans son dossier avec sa marque et son port. Le shell redirige tout vers le
   * journal (réécrit à chaque lancement) puis évalue la commande du manifeste : le dossier et la commande passent en
   * arguments ($1, $2), jamais collés dans le script.
   */
  commandeApplication(dossier: string, commande: string, port: number): string[] {
    dossierApplication(dossier);
    const journaux = `${CHEMIN_CONTENEUR}/.webaios/journaux`;
    return this.commandeExec(
      ["sh", "-c", `mkdir -p ${journaux}; exec >"${journaux}/$1.log" 2>&1; eval "$2"`, "webaios-app", dossier, commande.replaceAll("{port}", String(port))],
      { interactif: false, env: { [VARIABLE_APPLICATION]: dossier, PORT: String(port) }, dossier: `${CHEMIN_CONTENEUR}/projets/${dossier}` },
    );
  }

  /** Arrête l'appli `dossier` : tout processus qui porte sa marque, même détaché du shell qui l'a lancée. */
  async arreterApplication(dossier: string): Promise<void> {
    if (this.docker) await this.lancer(["exec", nomConteneur(), "sh", "-c", escalade(marques(`${VARIABLE_APPLICATION}=${litteral(dossierApplication(dossier))}`)).join("\n")], DELAI_SONDE_MS);
  }

  /** Au lancement du navigateur : les applis d'une vie précédente n'ont plus personne pour les suivre. */
  async arreterApplicationsOrphelines(): Promise<void> {
    if (this.docker) await this.lancer(["exec", nomConteneur(), "sh", "-c", escalade(marques(`${VARIABLE_APPLICATION}=.*`)).join("\n")], DELAI_SONDE_MS);
  }

  commandeExec(argv: string[], o: { interactif: boolean; env?: Record<string, string>; dossier?: string }): string[] {
    if (!this.docker) throw new Error("Docker introuvable");
    const env = Object.entries(o.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return [this.docker, "exec", ...(o.interactif ? ["-it"] : []), ...env, "-w", o.dossier ?? CHEMIN_CONTENEUR, nomConteneur(), ...argv];
  }
}
