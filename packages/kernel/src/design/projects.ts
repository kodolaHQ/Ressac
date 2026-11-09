import { createHash } from "node:crypto";
import { join } from "node:path";
import { containerPortRange } from "../container/workshop.js";

export const PROJECT_ID = /^(app-[A-Za-z0-9][A-Za-z0-9._-]*|ext-[0-9a-f]{16}|demo-\d{1,5}|site-[a-z0-9][a-z0-9-]{0,59})$/;

export const DESIGN_UNAVAILABLE = "Le mode design marche sur les applis de l'agent, les applis de site et les projets branchés par un Claude Code";
export const SITE_DESIGN_UNAVAILABLE = "Le mode design marche dans les pages du site et sur l'accueil, pas sur la carte d'accord, une page de connexion ni en plein écran";
export const SITE_CAPTURE_WARNING = "L'extrait et la capture de cet élément iront à l'agent.";
export const NO_CLIENT = "Aucun Claude Code branché pour ce projet : il doit le redéclarer";

export type ProjectId = string;

export type TrackedProject =
  | { type: "app"; projet: ProjectId; dossier: string; nom: string }
  | { type: "demo"; projet: ProjectId; port: number }
  | { type: "site"; projet: ProjectId; id: string; nom: string }
  | { type: "externe"; projet: ProjectId; dossier: string; nom: string; client: string | null };

export interface ExternalProject { id: string; nom: string; dossier: string; ports: number[]; client: string | null; declare: string }
export interface ExternalClient { id: string; nom: string; empreinte: string; cree: string }

export interface DesignFolders {
  remarquesEspace: string;
  prive: string;
}

export interface AvailabilityContext {
  appsLancees: { dossier: string; nom: string; port: number }[];
  plages: [number, number][];
  externes: ExternalProject[];
}

export const appProject = (folder: string): ProjectId => `app-${folder}`;
export const externalProject = (id: string): ProjectId => `ext-${id}`;
export const siteProject = (id: string): ProjectId => `site-${id}`;
export const demoProject = (port: number): ProjectId => `demo-${port}`;
export const externalId = (realFolder: string): string => createHash("sha256").update(realFolder).digest("hex").slice(0, 16);

export function remarksFolder(d: DesignFolders, p: ProjectId): string {
  return p.startsWith("ext-") ? join(d.prive, "remarques", p) : join(d.remarquesEspace, p);
}
export const reviewStore = (d: DesignFolders, p: ProjectId): string => join(d.prive, "relecture", `${p}.git`);
export const commentsFile = (d: DesignFolders, p: ProjectId): string => join(d.prive, "relecture", `${p}.commentaires.json`);

function readRange(text: string): [number, number] | null {
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(text.trim());
  if (!m) return null;
  const [min, max] = [Number(m[1]), Number(m[2])];
  return min >= 1 && max <= 65535 && min <= max ? [min, max] : null;
}

export function containerRanges(portsApps: string | undefined): [number, number][] {
  const base = containerPortRange();
  const ranges: [number, number][] = [base];
  const other = portsApps === undefined ? null : readRange(portsApps);
  if (other && (other[0] !== base[0] || other[1] !== base[1])) ranges.push(other);
  return ranges;
}

export function projectForUrl(url: string, c: AvailabilityContext): TrackedProject | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" || (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") || u.port === "") return null;
  const port = Number(u.port);
  const app = c.appsLancees.find((a) => a.port === port);
  if (app) return projectForAppWindow(app.dossier, app.nom);
  if (c.plages.some(([min, max]) => port >= min && port <= max)) return { type: "demo", projet: demoProject(port), port };
  const ext = c.externes.find((e) => e.ports.includes(port));
  if (ext) return { type: "externe", projet: externalProject(ext.id), dossier: ext.dossier, nom: ext.nom, client: ext.client };
  return null;
}

export function projectForAppWindow(folder: string, name: string): TrackedProject {
  return { type: "app", projet: appProject(folder), dossier: folder, nom: name };
}

export function projectForSite(id: string, name: string): TrackedProject {
  return { type: "site", projet: siteProject(id), id, nom: name };
}

export function destinationOf(p: TrackedProject, clients: ExternalClient[]): { libelle: string } | { indisponible: string } {
  if (p.type !== "externe") return { libelle: "l'agent" };
  const client = p.client === null ? undefined : clients.find((k) => k.id === p.client);
  return client ? { libelle: `Claude Code (${client.nom})` } : { indisponible: NO_CLIENT };
}
