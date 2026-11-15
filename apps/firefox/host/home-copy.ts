// A site app's home screen and an agent component's page copied out of the workspace, which the agent writes and can
// swap links into at any time.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ID_SITE } from "../../../packages/kernel/src/sites/schemas.ts";
import { HOME_ENTRIES_MAX, HOME_FILE_MAX, HOME_TYPES } from "../shared/sites.ts";
import { COMPONENT_HTML_MAX, inChild, inFolder, readFiles, type ReadFiles } from "../../../packages/kernel/src/index.ts";

/**
 * Run in a child process (see packages/kernel/src/workspace/confined.ts): each folder entered must be the very inode lstat saw in the folder before
 * it (a link swapped in between lands elsewhere and is refused), each file is opened by its bare name with O_NOFOLLOW:
 * no path is ever resolved again from the top, so no link reaches a file of the Mac. Copies `<sites>/<id>/home/` (names exact, hidden
 * segments, other types and files over `max` skipped) into `target`; returns the copied files, or null.
 * Self-contained: serialized with toString().
 */
export function walkHome(sites: string, id: string, target: string, max: number, entriesMax: number, types: string[]): string[] | null {
  const fs = process.getBuiltinModule("node:fs");
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  type Id = { dev: number; ino: number };
  const here = (expected: Id) => {
    const s = fs.statSync(".");
    if (s.dev !== expected.dev || s.ino !== expected.ino) throw new Error("folder changed during the copy");
  };
  const top = fs.lstatSync(sites);
  if (!top.isDirectory()) return null;
  process.chdir(sites);
  here(top);
  let parent: Id = top;
  for (const name of [id, "home"]) {
    // Exact name: a case-insensitive disk would find « Vidola » for « vidola ».
    if (!fs.readdirSync(".").includes(name)) return null;
    const l = fs.lstatSync(name);
    if (!l.isDirectory()) return null;
    process.chdir(name);
    here(l);
    parent = l;
  }
  const copied: string[] = [];
  let entries = 0;
  const walk = (rel: string, folder: Id): void => {
    for (const name of fs.readdirSync(".")) {
      if (name.startsWith(".")) continue;
      if (++entries > entriesMax) throw new Error("too many files");
      const l = fs.lstatSync(name);
      if (l.isDirectory()) {
        fs.mkdirSync(`${target}/${rel}${name}`);
        process.chdir(name);
        here(l);
        walk(`${rel}${name}/`, l);
        process.chdir("..");
        here(folder);
        continue;
      }
      const dot = name.lastIndexOf(".");
      if (!l.isFile() || l.size > max || dot <= 0 || !types.includes(name.slice(dot).toLowerCase())) continue;
      const fd = fs.openSync(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try {
        if (!fs.fstatSync(fd).isFile()) continue;
        const buffer = Buffer.alloc(max + 1);
        let size = 0;
        for (let n; size <= max && (n = fs.readSync(fd, buffer, size, max + 1 - size, null)) > 0; ) size += n;
        // A file that grew since lstat is refused, never cut.
        if (size > max) continue;
        fs.writeFileSync(`${target}/${rel}${name}`, buffer.subarray(0, size));
        copied.push(rel + name);
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  walk("", parent);
  return copied;
}

/** The home of site app `id` (`<sites>/<id>/home/`) copied into `target`, a folder out of the agent's reach; null if refused. */
export async function copyHome(sites: string, id: string, target: string): Promise<string[] | null> {
  const files = await inChild(walkHome, [sites, id, target, HOME_FILE_MAX, HOME_ENTRIES_MAX, HOME_TYPES]);
  return Array.isArray(files) && files.every((f) => typeof f === "string") ? files : null;
}

/** The host's `sites.copyHome`: app `id`'s home into its copy `<dataDir>/ressac-sites/<id>/<token>/`, made by the chrome. */
export function copyHomeRequest(dataDir: string, sites: string, p: { id?: unknown; token?: unknown }): Promise<string[] | null> {
  if (typeof p?.id !== "string" || !ID_SITE.test(p.id) || typeof p.token !== "string" || !/^[0-9a-f]{32}$/.test(p.token)) return Promise.resolve(null);
  return copyHome(sites, p.id, join(dataDir, "ressac-sites", p.id, p.token));
}

/**
 * The host's `actions.copyComponent`: `<components>/<name>/component.html` (COMPONENT_HTML_MAX at most), read by the
 * confined child, into `<dataDir>/ressac-components/<name>/source-<token>.html`, a folder the chrome made; its mtime, or null.
 */
export async function copyComponentRequest(dataDir: string, components: string, p: { name?: unknown; token?: unknown }): Promise<number | null> {
  if (typeof p?.name !== "string" || !/^[a-z0-9-]{1,40}$/.test(p.name) || typeof p.token !== "string" || !/^[0-9a-f]{32}$/.test(p.token)) return null;
  const r = await inFolder<ReadFiles>(components, [p.name], readFiles, [["component.html"], COMPONENT_HTML_MAX, COMPONENT_HTML_MAX]);
  if (!r || !("files" in r)) return null;
  await writeFile(join(dataDir, "ressac-components", p.name, `source-${p.token}.html`), r.files[0]!.text, { flag: "wx" });
  return r.files[0]!.mtime;
}
