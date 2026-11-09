import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { containerPortRange } from "../container/workshop.js";
import { generateToken } from "../mcp/server.js";
import { writePrivateJson } from "./atomic-write.js";
import { externalId, type ExternalClient, type ExternalProject } from "./projects.js";

export const FOLDER_NOT_ABSOLUTE = "Le dossier doit être un chemin absolu.";
export const FOLDER_NOT_FOUND = "Ce dossier n'existe pas sur le Mac.";
export const FOLDER_TOO_LARGE = "Ce dossier est trop large : ni /, ni le dossier personnel.";
export const SPACE_FOLDER = "Ce dossier est dans l'espace de WebAiOs : ses applis se relisent depuis la page Applications.";
export const UNREADABLE_WARNING = "WebAiOs ne peut pas lire ce dossier : la relecture sera indisponible tant que l'utilisateur n'a pas donné l'accès";
export const deniedPort = (p: number): string =>
  `Port ${p} refusé : entre 1024 et 65535, hors des ports du conteneur de WebAiOs (${containerPortRange().join("–")} et ceux des applis).`;

const ProjectSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  name: z.string(),
  folder: z.string(),
  ports: z.array(z.number().int()),
  client: z.string().nullable(),
  declared: z.string(),
});
const SchemaClient = z.object({ id: z.string(), name: z.string(), hash: z.string(), created: z.string() });

const PROJECTS_FILE = "projets-externes.json";
const CLIENTS_FILE = "clients-externes.json";

export interface OptionsDeclaration { ranges: [number, number][]; spaceRoot: string; home: string }

const inside = (folder: string, root: string): boolean => {
  const r = relative(root, folder);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

async function read<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("liste attendue");
    return value.map((v) => schema.parse(v));
  } catch {
    try { await copyFile(file, `${file}.abime-${new Date().toISOString().replace(/[:.]/g, "-")}`); } catch { /* best-effort copy */ }
    return [];
  }
}

export class ExternalRegistry {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  private constructor(private readonly privateDir: string, private list: ExternalProject[], private theClients: ExternalClient[]) {}

  static async open(isPrivate: string): Promise<ExternalRegistry> {
    const projects = await read(join(isPrivate, PROJECTS_FILE), ProjectSchema);
    const clients = await read(join(isPrivate, CLIENTS_FILE), SchemaClient);
    return new ExternalRegistry(isPrivate, projects, clients);
  }

  projects(): ExternalProject[] { return this.list.map((p) => ({ ...p, ports: [...p.ports] })); }
  clients(): ExternalClient[] { return this.theClients.map((c) => ({ ...c })); }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }

  private writeFile(name: string, data: unknown): Promise<void> {
    return writePrivateJson(join(this.privateDir, name), data);
  }

  // Computes the new state, writes it (clients first), and only then adopts it in memory.
  private edit<T>(computation: () => { projects?: ExternalProject[]; clients?: ExternalClient[]; result: T }): Promise<T> {
    const tache = this.writes.then(async () => {
      const { projects: projects, clients, result: result } = computation();
      if (clients) await this.writeFile(CLIENTS_FILE, clients);
      if (projects) await this.writeFile(PROJECTS_FILE, projects);
      if (clients) this.theClients = clients;
      if (projects) this.list = projects;
      for (const e of [...this.listeners]) { try { e(); } catch { /* a listener does not block */ } }
      return result;
    });
    this.writes = tache.catch(() => undefined);
    return tache;
  }

  async connect(name: string): Promise<{ client: ExternalClient; token: string }> {
    const token = generateToken();
    const client: ExternalClient = {
      id: randomBytes(6).toString("hex"),
      name: name.trim() || "Claude Code",
      hash: createHash("sha256").update(token).digest("hex"),
      created: new Date().toISOString(),
    };
    await this.edit(() => ({ clients: [...this.theClients, client], result: undefined }));
    return { client: { ...client }, token: token };
  }

  tokenClient(token: string): ExternalClient | null {
    const hash = createHash("sha256").update(token).digest();
    let found: ExternalClient | null = null;
    for (const c of this.theClients) {
      const other = Buffer.from(c.hash, "hex");
      if (other.length === hash.length && timingSafeEqual(other, hash)) found = c;
    }
    return found ? { ...found } : null;
  }

  async revoke(idClient: string): Promise<void> {
    await this.edit(() => ({
      clients: this.theClients.filter((c) => c.id !== idClient),
      projects: this.list.map((p) => (p.client === idClient ? { ...p, client: null } : p)),
      result: undefined,
    }));
  }

  async declare(
    client: string,
    d: { folder: string; ports: number[]; name?: string },
    o: OptionsDeclaration,
  ): Promise<{ project: ExternalProject; first: boolean; readable: boolean }> {
    if (!isAbsolute(d.folder)) throw new Error(FOLDER_NOT_ABSOLUTE);
    let real: string;
    try {
      real = await realpath(d.folder);
      if (!(await stat(real)).isDirectory()) throw new Error("pas un dossier");
    } catch { throw new Error(FOLDER_NOT_FOUND); }
    let homeDir = o.home;
    try { homeDir = await realpath(o.home); } catch { /* raw path */ }
    if (real === sep || real === homeDir || real === o.home) throw new Error(FOLDER_TOO_LARGE);
    let space = o.spaceRoot;
    try { space = await realpath(o.spaceRoot); } catch { /* raw path */ }
    if (inside(real, space) || inside(real, o.spaceRoot)) throw new Error(SPACE_FOLDER);
    if (d.ports.length < 1 || d.ports.length > 10) throw new Error("Entre 1 et 10 ports.");
    for (const p of d.ports) {
      if (!Number.isInteger(p) || p < 1024 || p > 65535 || o.ranges.some(([min, max]) => p >= min && p <= max)) {
        throw new Error(deniedPort(p));
      }
    }
    let readable = true;
    try { await readdir(real); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") readable = false;
    }
    const id = externalId(real);
    const ports = [...new Set(d.ports)];
    return this.edit(() => {
      const existing = this.list.find((p) => p.id === id);
      const name = d.name?.trim() || existing?.name || basename(real);
      const project: ExternalProject = { id, name: name, folder: real, ports, client, declared: existing?.declared ?? new Date().toISOString() };
      const others = this.list.filter((p) => p.id !== id).map((p) => ({ ...p, ports: p.ports.filter((x) => !ports.includes(x)) }));
      const projects = existing ? this.list.map((p) => (p.id === id ? project : others.find((a) => a.id === p.id)!)) : [...others, project];
      return { projects: projects, result: { project: { ...project, ports: [...ports] }, first: !existing, readable: readable } };
    });
  }

  async projectOf(client: string, folder: string): Promise<ExternalProject | null> {
    let real: string;
    try { real = await realpath(folder); } catch { return null; }
    const p = this.list.find((x) => x.folder === real && x.client === client);
    return p ? { ...p, ports: [...p.ports] } : null;
  }

  async forget(id: string): Promise<void> {
    await this.edit(() => ({ projects: this.list.filter((p) => p.id !== id), result: undefined }));
  }
}
