import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DownloadItem, Shell } from "electron";
import type { Telechargement } from "../commun/modele";

export type { Telechargement };

/** Premier chemin libre pour `nom` dans `dossier` : `nom.pdf`, `nom (1).pdf`, `nom (2).pdf`… */
export function cheminLibre(dossier: string, nom: string, existe: (chemin: string) => boolean): string {
  let propre = basename(nom.replace(/\\/g, "_")).trim();
  if (!propre || propre === "." || propre === "..") propre = "telechargement";
  // Un fichier caché (« .bashrc ») n'a pas d'extension.
  const ext = propre.startsWith(".") && propre.lastIndexOf(".") === 0 ? "" : extname(propre);
  const racine = propre.slice(0, propre.length - ext.length);
  for (let n = 0; ; n++) {
    const chemin = join(dossier, n === 0 ? propre : `${racine} (${n})${ext}`);
    if (!existe(chemin)) return chemin;
  }
}

/** Téléchargements de la session en cours (liste en mémoire). */
export class Telechargements {
  private items = new Map<string, { t: Telechargement; item: DownloadItem }>();
  /** Chemins promis à un téléchargement en cours, pas encore créés sur le disque. */
  private reserves = new Set<string>();

  constructor(
    private readonly o: {
      dossier: string;
      diffuser: (liste: Telechargement[]) => void;
      shell: Pick<Shell, "openPath" | "showItemInFolder">;
    },
  ) {}

  suivre(item: DownloadItem): void {
    mkdirSync(this.o.dossier, { recursive: true });
    const chemin = cheminLibre(this.o.dossier, item.getFilename(), (c) => this.reserves.has(c) || existsSync(c));
    this.reserves.add(chemin);
    item.setSavePath(chemin);
    const t: Telechargement = { id: randomUUID(), nom: basename(chemin), chemin, recus: 0, total: item.getTotalBytes(), etat: "en-cours" };
    this.items.set(t.id, { t, item });
    const maj = () => {
      t.recus = item.getReceivedBytes();
      t.total = item.getTotalBytes();
      this.diffuser();
    };
    item.on("updated", (_e, etat) => {
      t.etat = etat === "interrupted" ? "interrompu" : "en-cours"; // Chromium reprend seul après une coupure
      maj();
    });
    item.once("done", (_e, etat) => {
      this.reserves.delete(chemin);
      t.etat = etat === "completed" ? "termine" : etat === "cancelled" ? "annule" : "interrompu";
      maj();
    });
    this.diffuser();
  }

  liste(): Telechargement[] {
    return [...this.items.values()].map((x) => ({ ...x.t })).reverse();
  }

  ouvrir(id: string): void {
    const x = this.items.get(id);
    if (x?.t.etat === "termine") void this.o.shell.openPath(x.t.chemin);
  }

  montrer(id: string): void {
    const x = this.items.get(id);
    if (x) this.o.shell.showItemInFolder(x.t.chemin);
  }

  annuler(id: string): void {
    const x = this.items.get(id);
    if (x?.t.etat === "en-cours") x.item.cancel();
  }

  private diffuser(): void {
    this.o.diffuser(this.liste());
  }
}
