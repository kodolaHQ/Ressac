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
  nom: z.string(),
  dossier: z.string(),
  ports: z.array(z.number().int()),
  client: z.string().nullable(),
  declare: z.string(),
});
const SchemaClient = z.object({ id: z.string(), nom: z.string(), empreinte: z.string(), cree: z.string() });

const PROJECTS_FILE = "projets-externes.json";
const CLIENTS_FILE = "clients-externes.json";

export interface OptionsDeclaration { plages: [number, number][]; racineEspace: string; maison: string }

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
  private ecritures: Promise<unknown> = Promise.resolve();
  private readonly ecouteurs = new Set<() => void>();

  private constructor(private readonly prive: string, private liste: ExternalProject[], private lesClients: ExternalClient[]) {}

  static async ouvrir(isPrivate: string): Promise<ExternalRegistry> {
    const projects = await read(join(isPrivate, PROJECTS_FILE), ProjectSchema);
    const clients = await read(join(isPrivate, CLIENTS_FILE), SchemaClient);
    return new ExternalRegistry(isPrivate, projects, clients);
  }

  projets(): ExternalProject[] { return this.liste.map((p) => ({ ...p, ports: [...p.ports] })); }
  clients(): ExternalClient[] { return this.lesClients.map((c) => ({ ...c })); }

  surChange(f: () => void): () => void {
    this.ecouteurs.add(f);
    return () => { this.ecouteurs.delete(f); };
  }

  private ecrireFichier(name: string, data: unknown): Promise<void> {
    return writePrivateJson(join(this.prive, name), data);
  }

  // Computes the new state, writes it (clients first), and only then adopts it in memory.
  private modifier<T>(computation: () => { projets?: ExternalProject[]; clients?: ExternalClient[]; resultat: T }): Promise<T> {
    const tache = this.ecritures.then(async () => {
      const { projets: projects, clients, resultat: result } = computation();
      if (clients) await this.ecrireFichier(CLIENTS_FILE, clients);
      if (projects) await this.ecrireFichier(PROJECTS_FILE, projects);
      if (clients) this.lesClients = clients;
      if (projects) this.liste = projects;
      for (const e of [...this.ecouteurs]) { try { e(); } catch { /* a listener does not block */ } }
      return result;
    });
    this.ecritures = tache.catch(() => undefined);
    return tache;
  }

  async brancher(name: string): Promise<{ client: ExternalClient; jeton: string }> {
    const token = generateToken();
    const client: ExternalClient = {
      id: randomBytes(6).toString("hex"),
      nom: name.trim() || "Claude Code",
      empreinte: createHash("sha256").update(token).digest("hex"),
      cree: new Date().toISOString(),
    };
    await this.modifier(() => ({ clients: [...this.lesClients, client], resultat: undefined }));
    return { client: { ...client }, jeton: token };
  }

  clientDuJeton(token: string): ExternalClient | null {
    const hash = createHash("sha256").update(token).digest();
    let found: ExternalClient | null = null;
    for (const c of this.lesClients) {
      const other = Buffer.from(c.empreinte, "hex");
      if (other.length === hash.length && timingSafeEqual(other, hash)) found = c;
    }
    return found ? { ...found } : null;
  }

  async revoquer(idClient: string): Promise<void> {
    await this.modifier(() => ({
      clients: this.lesClients.filter((c) => c.id !== idClient),
      projets: this.liste.map((p) => (p.client === idClient ? { ...p, client: null } : p)),
      resultat: undefined,
    }));
  }

  async declarer(
    client: string,
    d: { dossier: string; ports: number[]; nom?: string },
    o: OptionsDeclaration,
  ): Promise<{ projet: ExternalProject; premiere: boolean; lisible: boolean }> {
    if (!isAbsolute(d.dossier)) throw new Error(FOLDER_NOT_ABSOLUTE);
    let real: string;
    try {
      real = await realpath(d.dossier);
      if (!(await stat(real)).isDirectory()) throw new Error("pas un dossier");
    } catch { throw new Error(FOLDER_NOT_FOUND); }
    let homeDir = o.maison;
    try { homeDir = await realpath(o.maison); } catch { /* raw path */ }
    if (real === sep || real === homeDir || real === o.maison) throw new Error(FOLDER_TOO_LARGE);
    let space = o.racineEspace;
    try { space = await realpath(o.racineEspace); } catch { /* raw path */ }
    if (inside(real, space) || inside(real, o.racineEspace)) throw new Error(SPACE_FOLDER);
    if (d.ports.length < 1 || d.ports.length > 10) throw new Error("Entre 1 et 10 ports.");
    for (const p of d.ports) {
      if (!Number.isInteger(p) || p < 1024 || p > 65535 || o.plages.some(([min, max]) => p >= min && p <= max)) {
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
    return this.modifier(() => {
      const existing = this.liste.find((p) => p.id === id);
      const name = d.nom?.trim() || existing?.nom || basename(real);
      const project: ExternalProject = { id, nom: name, dossier: real, ports, client, declare: existing?.declare ?? new Date().toISOString() };
      const others = this.liste.filter((p) => p.id !== id).map((p) => ({ ...p, ports: p.ports.filter((x) => !ports.includes(x)) }));
      const projects = existing ? this.liste.map((p) => (p.id === id ? project : others.find((a) => a.id === p.id)!)) : [...others, project];
      return { projets: projects, resultat: { projet: { ...project, ports: [...ports] }, premiere: !existing, lisible: readable } };
    });
  }

  async projetDe(client: string, folder: string): Promise<ExternalProject | null> {
    let real: string;
    try { real = await realpath(folder); } catch { return null; }
    const p = this.liste.find((x) => x.dossier === real && x.client === client);
    return p ? { ...p, ports: [...p.ports] } : null;
  }

  async oublier(id: string): Promise<void> {
    await this.modifier(() => ({ projets: this.liste.filter((p) => p.id !== id), resultat: undefined }));
  }
}
