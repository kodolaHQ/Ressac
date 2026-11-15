import { execFile } from "node:child_process";
import { access, appendFile, constants, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDiff, type Block } from "./diff.js";

export const GIT_REQUIRED = "git est nécessaire";
export const ACCESS_DENIED = "accès refusé";
export const BINARY_FILE = "fichier binaire";
export const FILE_TOO_BIG = "fichier trop gros pour la relecture";
export const LINE_CHANGED = "la ligne a changé";
export const BYTES_LIMIT = 1024 * 1024;
export const DIFF_LINES_LIMIT = 5000;
export const DIFF_CONTEXT = 3;
export const EXCLUSIONS = [".git", "node_modules", ".DS_Store", "dist", "build", ".next"];

const REF = "refs/ressac/relu";
/** Read (never written) for projects reviewed before the rename to Ressac. */
const LEGACY_REF = "refs/webaios/relu";
const PATHS_BATCH = 200;

export class ReviewError extends Error {
  constructor(readonly reason: typeof GIT_REQUIRED | typeof ACCESS_DENIED, detail?: string) {
    super(detail ? `${reason} : ${detail}` : reason);
    this.name = "ReviewError";
  }
}

export interface ModifiedFile { path: string; status: "added" | "modified" | "deleted"; additions: number; deletions: number; displayable: true | "binary" | "too-big" }
export interface Comparison { reviewedTree: string; currentTree: string; files: ModifiedFile[] }
export interface DiffFile { path: string; status: ModifiedFile["status"]; displayable: ModifiedFile["displayable"]; blocks: Block[] }

const defaultGit = () => process.env.RESSAC_GIT ?? "/usr/bin/git";

function launch(git: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, warnings?: { text: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(git, args, { env, cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        if (warnings) warnings.text = stderr;
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
  private readonly repo: string;
  private readonly folder: string;
  private readonly root: string | undefined;
  private readonly git: string;

  /** `root`: the folder `folder` must be a real direct child of (an agent-writable one, where links can be swapped in). */
  constructor(o: { repo: string; folder: string; root?: string; git?: string }) {
    this.repo = o.repo;
    this.folder = o.folder;
    this.root = o.root;
    this.git = o.git ?? defaultGit();
  }

  /**
   * The work tree's real path and the dev/ino of it and its parent, taken before and after `git add`: a folder swapped
   * for a link meanwhile (the agent's, to a folder of the Mac) changes them, and the snapshot is refused.
   */
  private async identity(): Promise<{ real: string; marks: string }> {
    const real = await realpath(this.folder);
    if (this.root !== undefined && ((await lstat(this.root)).isSymbolicLink() || (await lstat(this.folder)).isSymbolicLink() || dirname(real) !== (await realpath(this.root))))
      throw new ReviewError(ACCESS_DENIED, this.folder);
    const [f, p] = await Promise.all([lstat(real), lstat(dirname(real))]);
    return { real, marks: `${real}|${f.dev}:${f.ino}|${p.dev}:${p.ino}` };
  }

  /** The operations on the same repository go one after the other. */
  private series<T>(f: () => Promise<T>): Promise<T> {
    const queue = files.get(this.repo) ?? Promise.resolve();
    const next = queue.then(f, f);
    files.set(this.repo, next.catch(() => {}));
    return next;
  }

  private env(workTree = this.folder): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.repo,
      XDG_CONFIG_HOME: this.repo,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CEILING_DIRECTORIES: dirname(this.folder),
      GIT_DIR: this.repo,
      GIT_WORK_TREE: workTree,
      GIT_INDEX_FILE: join(this.repo, "index-ressac"),
      GIT_AUTHOR_NAME: "Ressac", GIT_AUTHOR_EMAIL: "ressac@localhost",
      GIT_COMMITTER_NAME: "Ressac", GIT_COMMITTER_EMAIL: "ressac@localhost",
    };
  }

  private async g(args: string[]): Promise<string> {
    return launch(this.git, args, this.env(), this.folder);
  }

  private gitVerified: Promise<boolean> | null = null;

  private async prepare(): Promise<void> {
    this.gitVerified ??= gitAvailable(this.git);
    if (!(await this.gitVerified)) throw new ReviewError(GIT_REQUIRED, this.git);
    try {
      await access(this.folder, constants.R_OK | constants.X_OK);
      await readdir(this.folder);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw new ReviewError(ACCESS_DENIED, this.folder);
      throw e;
    }
    if (!(await exists(join(this.repo, "HEAD")))) {
      await mkdir(dirname(this.repo), { recursive: true, mode: 0o700 });
      const env = { ...this.env() };
      delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
      await launch(this.git, ["init", "--bare", "-q", "--template=", this.repo], env, dirname(this.repo));
      await mkdir(join(this.repo, "info"), { recursive: true });
      await writeFile(join(this.repo, "info", "exclude"), EXCLUSIONS.join("\n") + "\n");
    }
  }

  private async internalSnapshot(): Promise<string> {
    await this.prepare();
    const before = await this.identity();
    for (let attempt = 0; ; attempt++) {
      try {
        const av = { text: "" };
        await launch(this.git, ["add", "-A"], this.env(before.real), before.real, av);
        if (/could not open directory|Permission denied|Operation not permitted/i.test(av.text)) throw new ReviewError(ACCESS_DENIED, av.text.trim());
        break;
      } catch (e) {
        if (e instanceof ReviewError) throw e;
        const s = (e as { stderr?: string }).stderr ?? "";
        if (/Operation not permitted|Permission denied/i.test(s)) throw new ReviewError(ACCESS_DENIED, this.folder);
        // A subfolder that is a repository without a commit cannot become a link: we exclude it.
        const nested = /'(.+)\/' does not have a commit checked out/.exec(s);
        if (!nested || attempt >= 50) throw e;
        const pattern = "/" + nested[1]!.replace(/[\\*?[\]!#]/g, "\\$&") + "/\n";
        await appendFile(join(this.repo, "info", "exclude"), pattern);
      }
    }
    if ((await this.identity().catch(() => null))?.marks !== before.marks) {
      // What the index took may be anything: dropped, never written as a tree.
      await rm(join(this.repo, "index-ressac"), { force: true });
      throw new ReviewError(ACCESS_DENIED, this.folder);
    }
    return (await this.g(["write-tree"])).trim();
  }

  /** The last reviewed commit: the new ref, else the old one. */
  private async reviewedRef(): Promise<string | null> {
    for (const ref of [REF, LEGACY_REF]) {
      const commit = await this.g(["rev-parse", "-q", "--verify", ref]).then((out) => out.trim(), () => "");
      if (commit) return commit;
    }
    return null;
  }

  private async keepInternal(tree: string): Promise<void> {
    const parent = await this.reviewedRef();
    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `relu ${new Date().toISOString()}`];
    const commit = (await this.g(args)).trim();
    await this.g(["update-ref", REF, commit]);
  }

  ensureReference(): Promise<boolean> {
    return this.series(async () => {
      await this.prepare();
      if (await this.reviewedRef()) return false;
      await this.keepInternal(await this.internalSnapshot());
      return true;
    });
  }

  snapshot(): Promise<string> {
    return this.series(() => this.internalSnapshot());
  }

  keep(tree?: string): Promise<void> {
    return this.series(async () => this.keepInternal(tree ?? (await this.internalSnapshot())));
  }

  compare(): Promise<Comparison> {
    return this.series(async () => {
      await this.prepare();
      const current = await this.internalSnapshot();
      if (!(await this.reviewedRef())) await this.keepInternal(current);
      const reviewed = (await this.g(["rev-parse", `${await this.reviewedRef()}^{tree}`])).trim();
      if (reviewed === current) return { reviewedTree: reviewed, currentTree: current, files: [] };

      const raw = (await this.g(["diff-tree", "-r", "--no-renames", "-z", "--raw", reviewed, current])).split("\0");
      const statuses = new Map<string, ModifiedFile["status"]>();
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const meta = raw[i]!.split(" "); // ":ancienMode nouveauMode ancienSha nouveauSha STATUT"
        const path = raw[i + 1]!;
        if (!meta[0]?.startsWith(":")) break;
        if (meta[0] === ":160000" || meta[1] === "160000") continue;
        const s = meta[4]![0];
        statuses.set(path, s === "A" ? "added" : s === "D" ? "deleted" : "modified");
      }
      if (statuses.size === 0) return { reviewedTree: reviewed, currentTree: current, files: [] };

      const nums = new Map<string, { additions: number; deletions: number; binary: boolean }>();
      for (const recorder of (await this.g(["diff-tree", "-r", "--no-renames", "-z", "--numstat", reviewed, current])).split("\0")) {
        const [a, d, ...rest] = recorder.split("\t");
        if (rest.length === 0) continue;
        nums.set(rest.join("\t"), a === "-" ? { additions: 0, deletions: 0, binary: true } : { additions: Number(a), deletions: Number(d), binary: false });
      }

      const paths = [...statuses.keys()];
      const sizes = new Map<string, number>();
      // Both versions: a 100 MB file replaced by one line still makes a 100 MB patch.
      for (const [tree, filter] of [[reviewed, (c: string) => statuses.get(c) !== "added"], [current, (c: string) => statuses.get(c) !== "deleted"]] as const) {
        const wanted = paths.filter(filter);
        for (let i = 0; i < wanted.length; i += PATHS_BATCH) {
          const output = await this.g(["ls-tree", "-r", "-l", "-z", tree, "--", ...wanted.slice(i, i + PATHS_BATCH).map((c) => `:(literal)${c}`)]);
          for (const line of output.split("\0")) {
            const t = line.indexOf("\t");
            if (t < 0) continue;
            const size = Number(line.slice(0, t).trim().split(/\s+/)[3]);
            sizes.set(line.slice(t + 1), Math.max(sizes.get(line.slice(t + 1)) ?? 0, Number.isFinite(size) ? size : 0));
          }
        }
      }

      const files: ModifiedFile[] = paths.sort().map((path) => {
        const n = nums.get(path) ?? { additions: 0, deletions: 0, binary: false };
        const displayable: ModifiedFile["displayable"] = n.binary
          ? "binary"
          : (sizes.get(path) ?? 0) > BYTES_LIMIT || n.additions + n.deletions > DIFF_LINES_LIMIT ? "too-big" : true;
        return { path: path, status: statuses.get(path)!, additions: n.additions, deletions: n.deletions, displayable: displayable };
      });
      return { reviewedTree: reviewed, currentTree: current, files: files };
    });
  }

  file(c: Comparison, path: string): Promise<DiffFile> {
    return this.series(async () => {
      const f = c.files.find((x) => x.path === path);
      if (!f) throw new Error(`fichier absent de la comparaison : ${path}`);
      if (f.displayable !== true) return { path: path, status: f.status, displayable: f.displayable, blocks: [] };
      const patch = await this.g(["diff-tree", "-p", `-U${DIFF_CONTEXT}`, "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", c.reviewedTree, c.currentTree, "--", `:(literal)${path}`]);
      return { path: path, status: f.status, displayable: true, blocks: parseDiff(patch) };
    });
  }

  lines(tree: string, path: string, start: number, end: number): Promise<string[]> {
    return this.series(async () => {
      const content = await this.g(["cat-file", "blob", `${tree}:${path}`]);
      return content.split("\n").slice(Math.max(0, start - 1), end);
    });
  }

  delete(): Promise<void> {
    return this.series(() => rm(this.repo, { recursive: true, force: true }));
  }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
