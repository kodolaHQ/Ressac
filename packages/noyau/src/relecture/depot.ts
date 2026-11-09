import { execFile } from "node:child_process";
import { access, appendFile, constants, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parserDiff, type Bloc } from "./diff.js";

export const GIT_NECESSAIRE = "git est nécessaire";
export const ACCES_REFUSE = "accès refusé";
export const FICHIER_BINAIRE = "fichier binaire";
export const FICHIER_TROP_GROS = "fichier trop gros pour la relecture";
export const LIGNE_CHANGEE = "la ligne a changé";
export const LIMITE_OCTETS = 1024 * 1024;
export const LIMITE_LIGNES_DIFF = 5000;
export const CONTEXTE_DIFF = 3;
export const EXCLUSIONS = [".git", "node_modules", ".DS_Store", "dist", "build", ".next"];

const REF = "refs/webaios/relu";
const LOT_CHEMINS = 200;

export class ErreurRelecture extends Error {
  constructor(readonly raison: typeof GIT_NECESSAIRE | typeof ACCES_REFUSE, detail?: string) {
    super(detail ? `${raison} : ${detail}` : raison);
    this.name = "ErreurRelecture";
  }
}

export interface FichierModifie { chemin: string; statut: "ajoute" | "modifie" | "supprime"; ajouts: number; suppressions: number; affichable: true | "binaire" | "trop-gros" }
export interface Comparaison { arbreRelu: string; arbreCourant: string; fichiers: FichierModifie[] }
export interface DiffFichier { chemin: string; statut: FichierModifie["statut"]; affichable: FichierModifie["affichable"]; blocs: Bloc[] }

const gitParDefaut = () => process.env.WEBAIOS_GIT ?? "/usr/bin/git";

function lancer(git: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, avertissements?: { texte: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(git, args, { env, cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        if (avertissements) avertissements.texte = stderr;
        return resolve(stdout);
      }
      const e = err as NodeJS.ErrnoException & { code?: string | number };
      if (e.code === "ENOENT") return reject(new ErreurRelecture(GIT_NECESSAIRE, git));
      reject(Object.assign(new Error(`git ${args[0]} : ${stderr.trim() || e.message}`), { stderr, code: e.code }));
    });
  });
}

export async function gitDisponible(git: string = gitParDefaut()): Promise<boolean> {
  try {
    await lancer(git, ["--version"], { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
    return true;
  } catch {
    return false;
  }
}

const files = new Map<string, Promise<unknown>>();

export class DepotRelecture {
  private readonly depot: string;
  private readonly dossier: string;
  private readonly git: string;

  constructor(o: { depot: string; dossier: string; git?: string }) {
    this.depot = o.depot;
    this.dossier = o.dossier;
    this.git = o.git ?? gitParDefaut();
  }

  /** The operations on the same repository go one after the other. */
  private serie<T>(f: () => Promise<T>): Promise<T> {
    const queue = files.get(this.depot) ?? Promise.resolve();
    const suite = queue.then(f, f);
    files.set(this.depot, suite.catch(() => {}));
    return suite;
  }

  private env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.depot,
      XDG_CONFIG_HOME: this.depot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CEILING_DIRECTORIES: dirname(this.dossier),
      GIT_DIR: this.depot,
      GIT_WORK_TREE: this.dossier,
      GIT_INDEX_FILE: join(this.depot, "index-webaios"),
      GIT_AUTHOR_NAME: "WebAiOs", GIT_AUTHOR_EMAIL: "webaios@localhost",
      GIT_COMMITTER_NAME: "WebAiOs", GIT_COMMITTER_EMAIL: "webaios@localhost",
    };
  }

  private async g(args: string[]): Promise<string> {
    return lancer(this.git, args, this.env(), this.dossier);
  }

  private gitVerifie: Promise<boolean> | null = null;

  private async preparer(): Promise<void> {
    this.gitVerifie ??= gitDisponible(this.git);
    if (!(await this.gitVerifie)) throw new ErreurRelecture(GIT_NECESSAIRE, this.git);
    try {
      await access(this.dossier, constants.R_OK | constants.X_OK);
      await readdir(this.dossier);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw new ErreurRelecture(ACCES_REFUSE, this.dossier);
      throw e;
    }
    if (!(await existe(join(this.depot, "HEAD")))) {
      await mkdir(dirname(this.depot), { recursive: true, mode: 0o700 });
      const env = { ...this.env() };
      delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
      await lancer(this.git, ["init", "--bare", "-q", "--template=", this.depot], env, dirname(this.depot));
      await mkdir(join(this.depot, "info"), { recursive: true });
      await writeFile(join(this.depot, "info", "exclude"), EXCLUSIONS.join("\n") + "\n");
    }
  }

  private async photoInterne(): Promise<string> {
    await this.preparer();
    for (let essai = 0; ; essai++) {
      try {
        const av = { texte: "" };
        await lancer(this.git, ["add", "-A"], this.env(), this.dossier, av);
        if (/could not open directory|Permission denied|Operation not permitted/i.test(av.texte)) throw new ErreurRelecture(ACCES_REFUSE, av.texte.trim());
        break;
      } catch (e) {
        if (e instanceof ErreurRelecture) throw e;
        const s = (e as { stderr?: string }).stderr ?? "";
        if (/Operation not permitted|Permission denied/i.test(s)) throw new ErreurRelecture(ACCES_REFUSE, this.dossier);
        // A subfolder that is a repository without a commit cannot become a link: we exclude it.
        const nid = /'(.+)\/' does not have a commit checked out/.exec(s);
        if (!nid || essai >= 50) throw e;
        const motif = "/" + nid[1]!.replace(/[\\*?[\]!#]/g, "\\$&") + "/\n";
        await appendFile(join(this.depot, "info", "exclude"), motif);
      }
    }
    return (await this.g(["write-tree"])).trim();
  }

  private async refRelu(): Promise<string | null> {
    try {
      return (await this.g(["rev-parse", "-q", "--verify", REF])).trim() || null;
    } catch {
      return null;
    }
  }

  private async retenirInterne(arbre: string): Promise<void> {
    const parent = await this.refRelu();
    const args = ["commit-tree", arbre, ...(parent ? ["-p", parent] : []), "-m", `relu ${new Date().toISOString()}`];
    const commit = (await this.g(args)).trim();
    await this.g(["update-ref", REF, commit]);
  }

  assurerReference(): Promise<boolean> {
    return this.serie(async () => {
      await this.preparer();
      if (await this.refRelu()) return false;
      await this.retenirInterne(await this.photoInterne());
      return true;
    });
  }

  photo(): Promise<string> {
    return this.serie(() => this.photoInterne());
  }

  retenir(arbre?: string): Promise<void> {
    return this.serie(async () => this.retenirInterne(arbre ?? (await this.photoInterne())));
  }

  comparer(): Promise<Comparaison> {
    return this.serie(async () => {
      await this.preparer();
      const courant = await this.photoInterne();
      if (!(await this.refRelu())) await this.retenirInterne(courant);
      const relu = (await this.g(["rev-parse", `${REF}^{tree}`])).trim();
      if (relu === courant) return { arbreRelu: relu, arbreCourant: courant, fichiers: [] };

      const brut = (await this.g(["diff-tree", "-r", "--no-renames", "-z", "--raw", relu, courant])).split("\0");
      const statuts = new Map<string, FichierModifie["statut"]>();
      for (let i = 0; i + 1 < brut.length; i += 2) {
        const meta = brut[i]!.split(" "); // ":ancienMode nouveauMode ancienSha nouveauSha STATUT"
        const chemin = brut[i + 1]!;
        if (!meta[0]?.startsWith(":")) break;
        if (meta[0] === ":160000" || meta[1] === "160000") continue;
        const s = meta[4]![0];
        statuts.set(chemin, s === "A" ? "ajoute" : s === "D" ? "supprime" : "modifie");
      }
      if (statuts.size === 0) return { arbreRelu: relu, arbreCourant: courant, fichiers: [] };

      const nums = new Map<string, { ajouts: number; suppressions: number; binaire: boolean }>();
      for (const enr of (await this.g(["diff-tree", "-r", "--no-renames", "-z", "--numstat", relu, courant])).split("\0")) {
        const [a, d, ...reste] = enr.split("\t");
        if (reste.length === 0) continue;
        nums.set(reste.join("\t"), a === "-" ? { ajouts: 0, suppressions: 0, binaire: true } : { ajouts: Number(a), suppressions: Number(d), binaire: false });
      }

      const chemins = [...statuts.keys()];
      const tailles = new Map<string, number>();
      for (const [arbre, filtre] of [[relu, (c: string) => statuts.get(c) === "supprime"], [courant, (c: string) => statuts.get(c) !== "supprime"]] as const) {
        const voulus = chemins.filter(filtre);
        for (let i = 0; i < voulus.length; i += LOT_CHEMINS) {
          const sortie = await this.g(["ls-tree", "-r", "-l", "-z", arbre, "--", ...voulus.slice(i, i + LOT_CHEMINS).map((c) => `:(literal)${c}`)]);
          for (const ligne of sortie.split("\0")) {
            const t = ligne.indexOf("\t");
            if (t < 0) continue;
            const taille = Number(ligne.slice(0, t).trim().split(/\s+/)[3]);
            tailles.set(ligne.slice(t + 1), Number.isFinite(taille) ? taille : 0);
          }
        }
      }

      const fichiers: FichierModifie[] = chemins.sort().map((chemin) => {
        const n = nums.get(chemin) ?? { ajouts: 0, suppressions: 0, binaire: false };
        const affichable: FichierModifie["affichable"] = n.binaire
          ? "binaire"
          : (tailles.get(chemin) ?? 0) > LIMITE_OCTETS || n.ajouts + n.suppressions > LIMITE_LIGNES_DIFF ? "trop-gros" : true;
        return { chemin, statut: statuts.get(chemin)!, ajouts: n.ajouts, suppressions: n.suppressions, affichable };
      });
      return { arbreRelu: relu, arbreCourant: courant, fichiers };
    });
  }

  fichier(c: Comparaison, chemin: string): Promise<DiffFichier> {
    return this.serie(async () => {
      const f = c.fichiers.find((x) => x.chemin === chemin);
      if (!f) throw new Error(`fichier absent de la comparaison : ${chemin}`);
      if (f.affichable !== true) return { chemin, statut: f.statut, affichable: f.affichable, blocs: [] };
      const patch = await this.g(["diff-tree", "-p", `-U${CONTEXTE_DIFF}`, "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", c.arbreRelu, c.arbreCourant, "--", `:(literal)${chemin}`]);
      return { chemin, statut: f.statut, affichable: true, blocs: parserDiff(patch) };
    });
  }

  lignes(arbre: string, chemin: string, debut: number, fin: number): Promise<string[]> {
    return this.serie(async () => {
      const contenu = await this.g(["cat-file", "blob", `${arbre}:${chemin}`]);
      return contenu.split("\n").slice(Math.max(0, debut - 1), fin);
    });
  }

  supprimer(): Promise<void> {
    return this.serie(() => rm(this.depot, { recursive: true, force: true }));
  }
}

async function existe(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
