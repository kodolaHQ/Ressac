import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { CHANGED_ROOTS, type Workshop } from "../container/workshop.js";
import { say } from "../i18n.js";
import type { DiffFile } from "../review/repo.js";
import type { StoreId } from "./inventory.js";
import type { WorkspaceLock } from "./lock.js";

/**
 * An entry of the space's stores changed since the reveal: it may hold the value in a form the masker does not know, in its
 * content or its name. `dir`: a directory new since the reveal (or renamed), moved with all it holds.
 */
export type ChangedFile = { store: StoreId; path: string; size: number; kind: "file" | "link" | "dir" | "other" };
/** « Mettre en quarantaine et déverrouiller » (default), « Garder les fichiers et déverrouiller », « Supprimer les fichiers et déverrouiller ». */
export type LiftChoice = "quarantine" | "keep" | "delete";
/** A file or link the lift moved out: `id` is its path under the quarantine folder (`<stamp>/<store>/<container path>`, or a `~n` variant). */
export type QuarantinedFile = { id: string; store: StoreId; path: string; size: number; kind: "file" | "link" };

type LiftWorkshop = Pick<Workshop, "changedSince" | "listUnder" | "stopAgentProcesses" | "copyOut" | "remove" | "removeEmptyFolders" | "clearRevealStamp">;
type Entry = { type: string; size: number; path: string };

const ROOTS = new Set(CHANGED_ROOTS.map(([root]) => root));
/** Quarantine paths a lift had to rename (APFS ignores case and normalization), by stamp folder: `<store>/…` → container path. */
const RENAMED = ".renamed.json";

/** The store of a container path, or null: not normalized (`..`, `//`) or outside every scanned root. */
function storeOf(path: string): StoreId | null {
  if (posix.normalize(path) !== path) return null;
  return CHANGED_ROOTS.find(([root]) => path.startsWith(`${root}/`))?.[1] ?? null;
}
const kindOf = (type: string): ChangedFile["kind"] => (type === "f" ? "file" : type === "l" ? "link" : type === "D" || type === "d" || type === "e" ? "dir" : "other");
function checked(e: Entry, kind = kindOf(e.type)): ChangedFile {
  const store = storeOf(e.path);
  if (store === null || !Number.isFinite(e.size)) throw new Error("changed files: unexpected scan output");
  return { store, path: e.path, size: e.size, kind };
}
const isDir = (e: Entry) => e.type === "D" || e.type === "d";

/**
 * Every changed entry, mapped to its store; [] without an engine. A path the scan should not give throws (fail closed).
 * New directories: those missing from the list taken at the reveal; without that list, every directory (fail closed). A
 * late list (written after the stamp) vouches for none of its directories changed since the stamp: one made between the
 * stamp and the list would pass for old.
 */
export async function changedFiles(workshop: Pick<Workshop, "changedSince">): Promise<ChangedFile[]> {
  const scan = await workshop.changedSince();
  if (!scan) return [];
  const dirs = scan.entries.filter((e) => isDir(e) && !ROOTS.has(e.path));
  for (const d of dirs) checked(d);
  const known = new Set(scan.snapshot?.dirs ?? []);
  if (scan.snapshot?.late) for (const d of dirs) if (d.type === "D") known.delete(d.path);
  const fresh = new Set(dirs.filter((d) => !known.has(d.path)).map((d) => d.path));
  const inFresh = (path: string) => {
    for (let p = posix.dirname(path); p !== "/"; p = posix.dirname(p)) if (fresh.has(p)) return true;
    return false;
  };
  return [
    ...dirs.filter((d) => fresh.has(d.path) && !inFresh(d.path)).map((d) => checked(d)),
    ...scan.entries.filter((e) => !isDir(e) && !inFresh(e.path)).map((e) => checked(e)),
  ];
}

/** What the card shows of a changed file: its start, as an added file (there is no copy from before the reveal). */
const SHOWN_BYTES = 200_000;
const SHOWN_LINES = 5000;
export async function changedFileDiff(workshop: Pick<Workshop, "readStart">, path: string): Promise<DiffFile> {
  if (storeOf(path) === null) throw new Error("changed files: not a scanned path");
  const text = await workshop.readStart(path, SHOWN_BYTES);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const file = { path, status: "added" as const, blocks: [] };
  // U+FFFD: bytes that are not UTF-8, as the runner decoded them.
  if (/[\0\uFFFD]/.test(text)) return { ...file, displayable: "binary" };
  if (Buffer.byteLength(text) > SHOWN_BYTES || lines.length > SHOWN_LINES) return { ...file, displayable: "too-big" };
  if (text === "") return { ...file, displayable: true };
  const shown = lines.map((l, i) => ({ mark: "+" as const, text: l, old: null, new: i + 1 }));
  return { ...file, displayable: true, blocks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: shown.length, lines: shown }] };
}

/** The quarantine folder's name: the lock's date in safe characters (`since` may be anything, or ""), else now. */
export function quarantineStamp(since: string, now = new Date()): string {
  const safe = (s: string) => s.replace(/[^0-9A-Za-z-]/g, "");
  return safe(since) || safe(now.toISOString());
}

/** `name~n`, before the extension. */
function suffixed(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}~${n}${name.slice(dot)}` : `${name}~${n}`;
}

/**
 * Where each entry lands in the quarantine folder, on a Mac disk that ignores case and Unicode normalization: two paths
 * that fold to the same one, or a file where another needs a folder, get `~n` on the clashing part. Nothing is lost and the
 * lift never stops on a clash. `dir`: the entry is an (empty) folder, which merges with a folder of the same folded name.
 */
export function quarantinePlaces(items: { rel: string; dir: boolean }[]): string[] {
  const fold = (s: string) => s.normalize("NFC").toLowerCase();
  const taken = new Map<string, { dir: boolean; name: string }>();
  return items.map(({ rel, dir }) => {
    const parts = rel.split("/");
    let at = "";
    parts.forEach((part, i) => {
      const folder = dir || i < parts.length - 1;
      for (let n = 0; ; n++) {
        const name = n === 0 ? part : suffixed(part, n);
        const candidate = at ? `${at}/${name}` : name;
        const t = taken.get(fold(candidate));
        if (!t) {
          taken.set(fold(candidate), { dir: folder, name: candidate });
          at = candidate;
          return;
        }
        if (t.dir && folder) {
          at = t.name;
          return;
        }
      }
    });
    return at;
  });
}

/** The folders a removal may have left empty, deepest first, never a root nor above one. */
function emptied(paths: string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const root = CHANGED_ROOTS.find(([r]) => path.startsWith(`${r}/`))![0];
    for (let p = posix.dirname(path); p !== root && p.startsWith(`${root}/`); p = posix.dirname(p)) out.add(p);
  }
  return [...out].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
}

/**
 * Lifts the workspace lock (spec § 3), the user's informed consent (Touch ID in the UI, before the call). Refused while a
 * conversation is open. The agent's processes stop first, then the changed entries are read again and moved (quarantine),
 * removed (delete) or kept but `remove` (keep); the folders left empty go, the reveal stamp is cleared, and only then the
 * lock file goes (its listeners apply the network again). Any failure throws and leaves the lock.
 * `around`: wraps the container work (the host stops its apps cleanly around it, like the sweep before a first session).
 */
export async function liftWorkspace(o: {
  lock: WorkspaceLock;
  workshop: LiftWorkshop;
  /** The masking folder (outside the workspace, never mounted): the quarantine goes under it. */
  folder: string;
  choice: LiftChoice;
  remove?: string[];
  sessionOpen: () => boolean;
  locale: () => string;
  around?: (work: () => Promise<void>) => Promise<void>;
}): Promise<void> {
  if (o.sessionOpen()) throw new Error(say(o.locale(), "kernel-mask-lift-session"));
  const info = o.lock.info();
  if (info === null) return;
  const step = async (path: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      throw new Error(say(o.locale(), "kernel-mask-lift-move-failed", { path, error: (e as Error).message }));
    }
  };
  // No engine at all: no container can hold anything the agent wrote, nor a stamp.
  if ((await o.workshop.changedSince()) !== null) {
    const work = async () => {
      await o.workshop.stopAgentProcesses();
      const items = await changedFiles(o.workshop);
      const wanted = new Set(o.remove ?? []);
      const gone = o.choice === "keep" ? items.filter((f) => wanted.has(f.path)) : items;
      if (o.choice === "quarantine") {
        const quarantine = join(o.folder, "quarantine", quarantineStamp(info.since));
        const dirs = gone.filter((f) => f.kind === "dir").map((f) => f.path);
        const inner = (await o.workshop.listUnder(dirs)).map((e) => {
          if (!dirs.some((d) => e.path === d || e.path.startsWith(`${d}/`))) throw new Error("changed files: unexpected scan output");
          return checked(e);
        });
        // A socket or a pipe holds nothing a copy keeps: removed only.
        const moves = [...gone.filter((f) => f.kind === "file" || f.kind === "link"), ...inner.filter((f) => f.kind !== "other")].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const rel = (f: ChangedFile) => `${f.store}/${f.path.slice(1)}`;
        const places = quarantinePlaces(moves.map((f) => ({ rel: rel(f), dir: f.kind === "dir" })));
        const renamed = Object.fromEntries(moves.flatMap((f, i) => (places[i] !== rel(f) ? [[places[i]!, f.path]] : [])));
        await mkdir(quarantine, { recursive: true, mode: 0o700 });
        if (Object.keys(renamed).length) {
          const before = await readRenamed(quarantine);
          await writeFile(join(quarantine, RENAMED), JSON.stringify({ ...before, ...renamed }), { mode: 0o600 });
        }
        for (const [i, f] of moves.entries()) {
          const dest = join(quarantine, places[i]!);
          await step(f.path, async () => {
            if (f.kind === "dir") return mkdir(dest, { recursive: true, mode: 0o700 });
            await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
            await o.workshop.copyOut(f.path, dest);
          });
        }
      }
      // shortcut: one container call per entry; batch them if a lift over thousands of files shows.
      for (const f of gone) await step(f.path, () => o.workshop.remove(f.path));
      await o.workshop.removeEmptyFolders(emptied(gone.map((f) => f.path)));
      await o.workshop.clearRevealStamp();
    };
    await (o.around ? o.around(work) : work());
  }
  await o.lock.lift();
}

async function readRenamed(stampFolder: string): Promise<Record<string, string>> {
  try {
    const v: unknown = JSON.parse(await readFile(join(stampFolder, RENAMED), "utf8"));
    return v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  } catch {
    return {};
  }
}

/** The files and links in quarantine, oldest lift first. */
export async function listQuarantine(folder: string): Promise<QuarantinedFile[]> {
  const root = join(folder, "quarantine");
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const files: QuarantinedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const id = posix.relative(root, join(entry.parentPath, entry.name));
    const place = await placeOf(folder, id);
    if (place) files.push({ id, ...place, size: (await lstat(join(root, id))).size, kind: entry.isSymbolicLink() ? "link" : "file" });
  }
  return files.sort((a, b) => a.id.localeCompare(b.id));
}

/** Where a quarantine id goes back in the container, or null for anything a lift did not write. */
async function placeOf(folder: string, id: string): Promise<{ store: StoreId; path: string } | null> {
  if (posix.normalize(id) !== id || id.startsWith("/")) return null;
  const [stamp = "", store, ...rest] = id.split("/");
  if (rest.length === 0) return null;
  const path = (await readRenamed(join(folder, "quarantine", stamp)))[id.slice(stamp.length + 1)] ?? `/${rest.join("/")}`;
  return storeOf(path) === store ? { store: store as StoreId, path } : null;
}

/**
 * « Rendre à l'atelier »: the file (or link) goes back to its place in the container, written as the agent's user, then
 * leaves the quarantine. Refused while a conversation or an agent app runs (`busy`).
 */
export async function restoreQuarantined(o: { folder: string; workshop: Pick<Workshop, "writeAsAgent">; id: string; busy: () => Promise<boolean>; locale: () => string }): Promise<void> {
  if (await o.busy()) throw new Error(say(o.locale(), "kernel-mask-restore-busy"));
  const place = await placeOf(o.folder, o.id);
  if (!place) throw new Error(`not in quarantine: ${o.id}`);
  const src = join(o.folder, "quarantine", o.id);
  const st = await lstat(src);
  if (st.isSymbolicLink()) await o.workshop.writeAsAgent(place.path, { link: await readlink(src) });
  else if (st.isFile()) await o.workshop.writeAsAgent(place.path, { content: await readFile(src) });
  else throw new Error(`not in quarantine: ${o.id}`);
  await rm(src);
}
