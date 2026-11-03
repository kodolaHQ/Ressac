import { createHash } from "node:crypto";
import { join } from "node:path";
import { PORTS } from "../conteneur/atelier.js";

export const ID_PROJET = /^(app-[A-Za-z0-9][A-Za-z0-9._-]*|ext-[0-9a-f]{16}|demo-\d{1,5})$/;
export const PLAGE_DEMOS: [number, number] = [5280, 5299];

export const INDISPONIBLE_DESIGN = "Le mode design marche sur les applis de l'agent et les projets branchés par un Claude Code";
export const SANS_CLIENT = "Aucun Claude Code branché pour ce projet : il doit le redéclarer";

export type IdProjet = string;

export type ProjetSuivi =
  | { type: "app"; projet: IdProjet; dossier: string; nom: string }
  | { type: "demo"; projet: IdProjet; port: number }
  | { type: "externe"; projet: IdProjet; dossier: string; nom: string; client: string | null };

export interface ProjetExterne { id: string; nom: string; dossier: string; ports: number[]; client: string | null; declare: string }
export interface ClientExterne { id: string; nom: string; empreinte: string; cree: string }

export interface DossiersDesign {
  remarquesEspace: string;
  prive: string;
}

export interface ContexteDisponibilite {
  appsLancees: { dossier: string; nom: string; port: number }[];
  plages: [number, number][];
  externes: ProjetExterne[];
}

export const projetApp = (dossier: string): IdProjet => `app-${dossier}`;
export const projetExterne = (id: string): IdProjet => `ext-${id}`;
export const projetDemo = (port: number): IdProjet => `demo-${port}`;
export const idExterne = (dossierReel: string): string => createHash("sha256").update(dossierReel).digest("hex").slice(0, 16);

export function dossierRemarques(d: DossiersDesign, p: IdProjet): string {
  return p.startsWith("ext-") ? join(d.prive, "remarques", p) : join(d.remarquesEspace, p);
}
export const depotRelecture = (d: DossiersDesign, p: IdProjet): string => join(d.prive, "relecture", `${p}.git`);
export const fichierCommentaires = (d: DossiersDesign, p: IdProjet): string => join(d.prive, "relecture", `${p}.commentaires.json`);

function lirePlage(texte: string): [number, number] | null {
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(texte.trim());
  if (!m) return null;
  const [min, max] = [Number(m[1]), Number(m[2])];
  return min >= 1 && max <= 65535 && min <= max ? [min, max] : null;
}

export function plagesConteneur(portsApps: string | undefined): [number, number][] {
  const base = lirePlage(PORTS) ?? PLAGE_DEMOS;
  const plages: [number, number][] = [base];
  const autre = portsApps === undefined ? null : lirePlage(portsApps);
  if (autre && (autre[0] !== base[0] || autre[1] !== base[1])) plages.push(autre);
  return plages;
}

export function projetPourAdresse(url: string, c: ContexteDisponibilite): ProjetSuivi | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" || (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") || u.port === "") return null;
  const port = Number(u.port);
  const appli = c.appsLancees.find((a) => a.port === port);
  if (appli) return projetPourFenetreApp(appli.dossier, appli.nom);
  if (c.plages.some(([min, max]) => port >= min && port <= max)) return { type: "demo", projet: projetDemo(port), port };
  const ext = c.externes.find((e) => e.ports.includes(port));
  if (ext) return { type: "externe", projet: projetExterne(ext.id), dossier: ext.dossier, nom: ext.nom, client: ext.client };
  return null;
}

export function projetPourFenetreApp(dossier: string, nom: string): ProjetSuivi {
  return { type: "app", projet: projetApp(dossier), dossier, nom };
}

export function destinationDe(p: ProjetSuivi, clients: ClientExterne[]): { libelle: string } | { indisponible: string } {
  if (p.type !== "externe") return { libelle: "l'agent" };
  const client = p.client === null ? undefined : clients.find((k) => k.id === p.client);
  return client ? { libelle: `Claude Code (${client.nom})` } : { indisponible: SANS_CLIENT };
}
