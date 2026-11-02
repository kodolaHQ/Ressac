import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { genererJeton } from "../mcp/serveur.js";
import { idExterne, type ClientExterne, type ProjetExterne } from "./projets.js";

export const DOSSIER_NON_ABSOLU = "Le dossier doit être un chemin absolu.";
export const DOSSIER_INTROUVABLE = "Ce dossier n'existe pas sur le Mac.";
export const DOSSIER_TROP_LARGE = "Ce dossier est trop large : ni /, ni le dossier personnel.";
export const DOSSIER_ESPACE = "Ce dossier est dans l'espace de WebAiOs : ses applis se relisent depuis la page Applications.";
export const AVERTISSEMENT_ILLISIBLE = "WebAiOs ne peut pas lire ce dossier : la relecture sera indisponible tant que l'utilisateur n'a pas donné l'accès";
export const portRefuse = (p: number): string =>
  `Port ${p} refusé : entre 1024 et 65535, hors des ports du conteneur de WebAiOs (5280–5299 et ceux des applis).`;

const SchemaProjet = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  nom: z.string(),
  dossier: z.string(),
  ports: z.array(z.number().int()),
  client: z.string().nullable(),
  declare: z.string(),
});
const SchemaClient = z.object({ id: z.string(), nom: z.string(), empreinte: z.string(), cree: z.string() });

const FICHIER_PROJETS = "projets-externes.json";
const FICHIER_CLIENTS = "clients-externes.json";

export interface OptionsDeclaration { plages: [number, number][]; racineEspace: string; maison: string }

const dedans = (dossier: string, racine: string): boolean => {
  const r = relative(racine, dossier);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

async function lire<T>(fichier: string, schema: z.ZodType<T>): Promise<T[]> {
  let brut: string;
  try { brut = await readFile(fichier, "utf8"); } catch { return []; }
  try {
    const valeur = JSON.parse(brut);
    if (!Array.isArray(valeur)) throw new Error("liste attendue");
    return valeur.map((v) => schema.parse(v));
  } catch {
    try { await copyFile(fichier, `${fichier}.abime-${new Date().toISOString().replace(/[:.]/g, "-")}`); } catch { /* copie au mieux */ }
    return [];
  }
}

export class RegistreExternes {
  private ecritures: Promise<unknown> = Promise.resolve();
  private readonly ecouteurs = new Set<() => void>();

  private constructor(private readonly prive: string, private liste: ProjetExterne[], private lesClients: ClientExterne[]) {}

  static async ouvrir(prive: string): Promise<RegistreExternes> {
    const projets = await lire(join(prive, FICHIER_PROJETS), SchemaProjet);
    const clients = await lire(join(prive, FICHIER_CLIENTS), SchemaClient);
    return new RegistreExternes(prive, projets, clients);
  }

  projets(): ProjetExterne[] { return this.liste.map((p) => ({ ...p, ports: [...p.ports] })); }
  clients(): ClientExterne[] { return this.lesClients.map((c) => ({ ...c })); }

  surChange(f: () => void): () => void {
    this.ecouteurs.add(f);
    return () => { this.ecouteurs.delete(f); };
  }

  private async ecrireFichier(nom: string, donnees: unknown): Promise<void> {
    await mkdir(this.prive, { recursive: true, mode: 0o700 });
    await chmod(this.prive, 0o700);
    const cible = join(this.prive, nom);
    const temporaire = `${cible}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporaire, JSON.stringify(donnees, null, 2), { mode: 0o600 });
    await chmod(temporaire, 0o600);
    await rename(temporaire, cible);
  }

  // Applique la modification en mémoire puis écrit, à la suite des écritures précédentes.
  private modifier<T>(f: () => T, projets: boolean, clients: boolean): Promise<T> {
    const tache = this.ecritures.then(async () => {
      const resultat = f();
      if (projets) await this.ecrireFichier(FICHIER_PROJETS, this.liste);
      if (clients) await this.ecrireFichier(FICHIER_CLIENTS, this.lesClients);
      for (const e of [...this.ecouteurs]) { try { e(); } catch { /* un écouteur ne bloque pas */ } }
      return resultat;
    });
    this.ecritures = tache.catch(() => undefined);
    return tache;
  }

  async brancher(nom: string): Promise<{ client: ClientExterne; jeton: string }> {
    const jeton = genererJeton();
    const client: ClientExterne = {
      id: randomBytes(6).toString("hex"),
      nom: nom.trim() || "Claude Code",
      empreinte: createHash("sha256").update(jeton).digest("hex"),
      cree: new Date().toISOString(),
    };
    await this.modifier(() => { this.lesClients.push(client); }, false, true);
    return { client: { ...client }, jeton };
  }

  clientDuJeton(jeton: string): ClientExterne | null {
    const empreinte = createHash("sha256").update(jeton).digest();
    let trouve: ClientExterne | null = null;
    for (const c of this.lesClients) {
      const autre = Buffer.from(c.empreinte, "hex");
      if (autre.length === empreinte.length && timingSafeEqual(autre, empreinte)) trouve = c;
    }
    return trouve ? { ...trouve } : null;
  }

  async revoquer(idClient: string): Promise<void> {
    await this.modifier(() => {
      this.lesClients = this.lesClients.filter((c) => c.id !== idClient);
      this.liste = this.liste.map((p) => (p.client === idClient ? { ...p, client: null } : p));
    }, true, true);
  }

  async declarer(
    client: string,
    d: { dossier: string; ports: number[]; nom?: string },
    o: OptionsDeclaration,
  ): Promise<{ projet: ProjetExterne; premiere: boolean; lisible: boolean }> {
    if (!isAbsolute(d.dossier)) throw new Error(DOSSIER_NON_ABSOLU);
    let reel: string;
    try {
      reel = await realpath(d.dossier);
      if (!(await stat(reel)).isDirectory()) throw new Error("pas un dossier");
    } catch { throw new Error(DOSSIER_INTROUVABLE); }
    let maison = o.maison;
    try { maison = await realpath(o.maison); } catch { /* chemin brut */ }
    if (reel === sep || reel === maison || reel === o.maison) throw new Error(DOSSIER_TROP_LARGE);
    let espace = o.racineEspace;
    try { espace = await realpath(o.racineEspace); } catch { /* chemin brut */ }
    if (dedans(reel, espace) || dedans(reel, o.racineEspace)) throw new Error(DOSSIER_ESPACE);
    if (d.ports.length < 1 || d.ports.length > 10) throw new Error("Entre 1 et 10 ports.");
    for (const p of d.ports) {
      if (!Number.isInteger(p) || p < 1024 || p > 65535 || o.plages.some(([min, max]) => p >= min && p <= max)) {
        throw new Error(portRefuse(p));
      }
    }
    let lisible = true;
    try { await readdir(reel); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") lisible = false;
    }
    const id = idExterne(reel);
    const ports = [...new Set(d.ports)];
    return this.modifier(() => {
      const existant = this.liste.find((p) => p.id === id);
      const nom = d.nom?.trim() || existant?.nom || basename(reel);
      const projet: ProjetExterne = { id, nom, dossier: reel, ports, client, declare: existant?.declare ?? new Date().toISOString() };
      this.liste = this.liste.map((p) => (p.id === id ? p : { ...p, ports: p.ports.filter((x) => !ports.includes(x)) }));
      if (existant) this.liste = this.liste.map((p) => (p.id === id ? projet : p));
      else this.liste.push(projet);
      return { projet: { ...projet, ports: [...ports] }, premiere: !existant, lisible };
    }, true, false);
  }

  async projetDe(client: string, dossier: string): Promise<ProjetExterne | null> {
    let reel: string;
    try { reel = await realpath(dossier); } catch { return null; }
    const p = this.liste.find((x) => x.dossier === reel && x.client === client);
    return p ? { ...p, ports: [...p.ports] } : null;
  }

  async oublier(id: string): Promise<void> {
    await this.modifier(() => { this.liste = this.liste.filter((p) => p.id !== id); }, true, false);
  }
}
