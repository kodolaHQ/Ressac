import { execFile } from "node:child_process";
import { access, appendFile, constants, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parserDiff, type Block } from "./diff.js";

export const GIT_REQUIRED = "git est nécessaire";
export const ACCESS_DENIED = "accès refusé";
export const BINARY_FILE = "fichier binaire";
export const FILE_TOO_BIG = "fichier trop gros pour la relecture";
export const LINE_CHANGED = "la ligne a changé";
export const BYTES_LIMIT = 1024 * 1024;
export const DIFF_LINES_LIMIT = 5000;
export const DIFF_CONTEXT = 3;
export const EXCLUSIONS = [".git", "node_modules", ".DS_Store", "dist", "build", ".next"];

const REF = "refs/webaios/relu";
const PATHS_BATCH = 200;

export class ReviewError extends Error {
  constructor(readonly raison: typeof GIT_REQUIRED | typeof ACCESS_DENIED, detail?: string) {
    super(detail ? `${raison} : ${detail}` : raison);
    this.name = "ErreurRelecture";
  }
}

export interface ModifiedFile { chemin: string; statut: "ajoute" | "modifie" | "supprime"; ajouts: number; suppressions: number; affichable: true | "binaire" | "trop-gros" }
export interface Comparison { arbreRelu: string; arbreCourant: string; fichiers: ModifiedFile[] }
export interface DiffFile { chemin: string; statut: ModifiedFile["statut"]; affichable: ModifiedFile["affichable"]; blocs: Block[] }

const defaultGit = () => process.env.WEBAIOS_GIT ?? "/usr/bin/git";

function launch(git: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, warnings?: { texte: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(git, args, { env, cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        if (warnings) warnings.texte = stderr;
        return resolve(stdout);
      }
      const e = err as NodeJS.ErrnoException & { code?: string | number };
      if (e.code === "ENOENT") return reject(new ReviewError(GIT_REQUIRED, git));
      reject(Object.assign(new Error(`git ${args[0]} : ${stderr.trim() || e.message}`), { stderr, code: e.code }));
    });
  });
}

export async function gitAvailable(git: string = defaultGit()): Promise<boolean> {
  try {
    await launch(git, ["--version"], { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
    return true;
  } catch {
    return false;
  }
}

const files = new Map<string, Promise<unknown>>();

export class ReviewStore {
  private readonly depot: string;
  private readonly dossier: string;
  private readonly git: string;

  constructor(o: { depot: string; dossier: string; git?: string }) {
    this.depot = o.depot;
    this.dossier = o.dossier;
    this.git = o.git ?? defaultGit();
  }

  /** The operations on the same repository go one after the other. */
  private serie<T>(f: () => Promise<T>): Promise<T> {
    const queue = files.get(this.depot) ?? Promise.resolve();
    const next = queue.then(f, f);
    files.set(this.depot, next.catch(() => {}));
    return next;
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
    return launch(this.git, args, this.env(), this.dossier);
  }

  private gitVerifie: Promise<boolean> | null = null;

  private async preparer(): Promise<void> {
    this.gitVerifie ??= gitAvailable(this.git);
    if (!(await this.gitVerifie)) throw new ReviewError(GIT_REQUIRED, this.git);
    try {
      await access(this.dossier, constants.R_OK | constants.X_OK);
      await readdir(this.dossier);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw new ReviewError(ACCESS_DENIED, this.dossier);
      throw e;
    }
    if (!(await exists(join(this.depot, "HEAD")))) {
      await mkdir(dirname(this.depot), { recursive: true, mode: 0o700 });
      const env = { ...this.env() };
      delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
      await launch(this.git, ["init", "--bare", "-q", "--template=", this.depot], env, dirname(this.depot));
      await mkdir(join(this.depot, "info"), { recursive: true });
      await writeFile(join(this.depot, "info", "exclude"), EXCLUSIONS.join("\n") + "\n");
    }
  }

  private async photoInterne(): Promise<string> {
    await this.preparer();
    for (let attempt = 0; ; attempt++) {
      try {
        const av = { texte: "" };
        await launch(this.git, ["add", "-A"], this.env(), this.dossier, av);
        if (/could not open directory|Permission denied|Operation not permitted/i.test(av.texte)) throw new ReviewError(ACCESS_DENIED, av.texte.trim());
        break;
      } catch (e) {
        if (e instanceof ReviewError) throw e;
        const s = (e as { stderr?: string }).stderr ?? "";
        if (/Operation not permitted|Permission denied/i.test(s)) throw new ReviewError(ACCESS_DENIED, this.dossier);
        // A subfolder that is a repository without a commit cannot become a link: we exclude it.
        const nested = /'(.+)\/' does not have a commit checked out/.exec(s);
        if (!nested || attempt >= 50) throw e;
        const pattern = "/" + nested[1]!.replace(/[\\*?[\]!#]/g, "\\$&") + "/\n";
        await appendFile(join(this.depot, "info", "exclude"), pattern);
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

  private async retenirInterne(tree: string): Promise<void> {
    const parent = await this.refRelu();
    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `relu ${new Date().toISOString()}`];
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

  retenir(tree?: string): Promise<void> {
    return this.serie(async () => this.retenirInterne(tree ?? (await this.photoInterne())));
  }

  comparer(): Promise<Comparison> {
    return this.serie(async () => {
      await this.preparer();
      const current = await this.photoInterne();
      if (!(await this.refRelu())) await this.retenirInterne(current);
      const reviewed = (await this.g(["rev-parse", `${REF}^{tree}`])).trim();
      if (reviewed === current) return { arbreRelu: reviewed, arbreCourant: current, fichiers: [] };

      const raw = (await this.g(["diff-tree", "-r", "--no-renames", "-z", "--raw", reviewed, current])).split("\0");
      const statuses = new Map<string, ModifiedFile["statut"]>();
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const meta = raw[i]!.split(" "); // ":ancienMode nouveauMode ancienSha nouveauSha STATUT"
        const path = raw[i + 1]!;
        if (!meta[0]?.startsWith(":")) break;
        if (meta[0] === ":160000" || meta[1] === "160000") continue;
        const s = meta[4]![0];
        statuses.set(path, s === "A" ? "ajoute" : s === "D" ? "supprime" : "modifie");
      }
      if (statuses.size === 0) return { arbreRelu: reviewed, arbreCourant: current, fichiers: [] };

      const nums = new Map<string, { ajouts: number; suppressions: number; binaire: boolean }>();
      for (const recorder of (await this.g(["diff-tree", "-r", "--no-renames", "-z", "--numstat", reviewed, current])).split("\0")) {
        const [a, d, ...rest] = recorder.split("\t");
        if (rest.length === 0) continue;
        nums.set(rest.join("\t"), a === "-" ? { ajouts: 0, suppressions: 0, binaire: true } : { ajouts: Number(a), suppressions: Number(d), binaire: false });
      }

      const paths = [...statuses.keys()];
      const sizes = new Map<string, number>();
      for (const [tree, filter] of [[reviewed, (c: string) => statuses.get(c) === "supprime"], [current, (c: string) => statuses.get(c) !== "supprime"]] as const) {
        const wanted = paths.filter(filter);
        for (let i = 0; i < wanted.length; i += PATHS_BATCH) {
          const output = await this.g(["ls-tree", "-r", "-l", "-z", tree, "--", ...wanted.slice(i, i + PATHS_BATCH).map((c) => `:(literal)${c}`)]);
          for (const line of output.split("\0")) {
            const t = line.indexOf("\t");
            if (t < 0) continue;
            const size = Number(line.slice(0, t).trim().split(/\s+/)[3]);
            sizes.set(line.slice(t + 1), Number.isFinite(size) ? size : 0);
          }
        }
      }

      const files: ModifiedFile[] = paths.sort().map((path) => {
        const n = nums.get(path) ?? { ajouts: 0, suppressions: 0, binaire: false };
        const displayable: ModifiedFile["affichable"] = n.binaire
          ? "binaire"
          : (sizes.get(path) ?? 0) > BYTES_LIMIT || n.ajouts + n.suppressions > DIFF_LINES_LIMIT ? "trop-gros" : true;
        return { chemin: path, statut: statuses.get(path)!, ajouts: n.ajouts, suppressions: n.suppressions, affichable: displayable };
      });
      return { arbreRelu: reviewed, arbreCourant: current, fichiers: files };
    });
  }

  fichier(c: Comparison, path: string): Promise<DiffFile> {
    return this.serie(async () => {
      const f = c.fichiers.find((x) => x.chemin === path);
      if (!f) throw new Error(`fichier absent de la comparaison : ${path}`);
      if (f.affichable !== true) return { chemin: path, statut: f.statut, affichable: f.affichable, blocs: [] };
      const patch = await this.g(["diff-tree", "-p", `-U${DIFF_CONTEXT}`, "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", c.arbreRelu, c.arbreCourant, "--", `:(literal)${path}`]);
      return { chemin: path, statut: f.statut, affichable: true, blocs: parserDiff(patch) };
    });
  }

  lignes(tree: string, path: string, start: number, end: number): Promise<string[]> {
    return this.serie(async () => {
      const content = await this.g(["cat-file", "blob", `${tree}:${path}`]);
      return content.split("\n").slice(Math.max(0, start - 1), end);
    });
  }

  supprimer(): Promise<void> {
    return this.serie(() => rm(this.depot, { recursive: true, force: true }));
  }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
