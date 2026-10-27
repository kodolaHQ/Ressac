import { BrowserWindow, screen, session, type WebContents } from "electron";
import type { Application } from "@webaios/noyau";
import type { Cadre } from "../../commun/modele";
import { preferencesWeb } from "../onglets/vues";
import type { MemoireApplications } from "./service";

/** Tests automatiques : aucune fenêtre à l'écran. */
const INVISIBLE = process.env.WEBAIOS_INVISIBLE === "1";

/** Le cadre enregistré, s'il tombe encore sur un écran branché (sinon la fenêtre s'ouvrirait hors de vue). */
export function cadreVisible(c: Cadre | null | undefined): Electron.Rectangle | undefined {
  if (!c) return undefined;
  const r = { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.largeur), height: Math.round(c.hauteur) };
  const visible = screen.getAllDisplays().some(({ workArea: z }) => r.x < z.x + z.width && r.x + r.width > z.x && r.y < z.y + z.height && r.y + r.height > z.y);
  return visible ? r : undefined;
}

/**
 * Une fenêtre par appli lancée : la page de l'appli seule, sans l'interface WebAiOs, dans sa propre session
 * (`persist:app-<dossier>`, jamais celle de la navigation). Ce qui sort de l'appli va dans un onglet de la fenêtre principale.
 */
export class FenetresApplications {
  private readonly fenetres = new Map<string, BrowserWindow>();
  /** Fermetures décidées par le programme (appli arrêtée) : elles n'arrêtent rien. */
  private readonly fermeturesVoulues = new WeakSet<BrowserWindow>();

  constructor(
    private readonly o: {
      memoire: MemoireApplications;
      ouvrirOnglet: (url: string) => void;
      /** L'utilisateur a fermé la fenêtre : l'appli doit s'arrêter. */
      surFermeture: (dossier: string) => void;
    },
  ) {}

  /** Crée la fenêtre de l'appli ou la remet devant, et charge l'appli sur son port. */
  ouvrir(a: Application): void {
    const url = `http://localhost:${a.port}/`;
    let f = this.fenetres.get(a.dossier);
    if (f && !f.isDestroyed()) {
      if (!INVISIBLE) {
        if (f.isMinimized()) f.restore();
        f.show();
        f.focus();
      }
    } else f = this.creer(a);
    f.setTitle(a.nom);
    void f.loadURL(url).catch(() => {
      // Appli arrêtée entre-temps, ou rechargée aussitôt : rien à faire.
    });
  }

  private creer(a: Application): BrowserWindow {
    const { dossier } = a;
    const f = new BrowserWindow({
      width: 1200,
      height: 800,
      ...cadreVisible(this.o.memoire.lire(dossier).cadre),
      show: !INVISIBLE,
      title: a.nom,
      backgroundColor: "#ffffff",
      webPreferences: preferencesWeb(session.fromPartition(`persist:app-${dossier}`)),
    });
    this.fenetres.set(dossier, f);
    // Le titre reste le nom de l'appli : c'est lui qui la distingue des fenêtres principales.
    f.on("page-title-updated", (e) => e.preventDefault());
    // Taille et position retenues aussitôt (la mémoire écrit en différé) : une fenêtre détruite n'a plus de cadre à lire.
    const noterCadre = () => {
      if (f.isDestroyed() || f.isFullScreen() || f.isMinimized()) return;
      const { x, y, width, height } = f.getNormalBounds();
      this.o.memoire.noter(dossier, { cadre: { x, y, largeur: width, hauteur: height } });
    };
    f.on("resize", noterCadre);
    f.on("move", noterCadre);
    f.on("close", noterCadre);
    f.on("closed", () => {
      if (this.fenetres.get(dossier) === f) this.fenetres.delete(dossier);
      if (!this.fermeturesVoulues.has(f)) this.o.surFermeture(dossier);
    });
    const wc = f.webContents;
    // L'appli reste sur son origine : un lien vers ailleurs s'ouvre dans un onglet.
    wc.on("will-navigate", (e, url) => {
      if (memeOrigine(url, wc.getURL())) return;
      e.preventDefault();
      if (/^https?:\/\//.test(url)) this.o.ouvrirOnglet(url);
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) this.o.ouvrirOnglet(url);
      return { action: "deny" };
    });
    return f;
  }

  /** Fermeture voulue par le programme (appli arrêtée ou en erreur) : n'appelle pas `surFermeture`. */
  fermer(dossier: string): void {
    const f = this.fenetres.get(dossier);
    this.fenetres.delete(dossier);
    if (!f || f.isDestroyed()) return;
    this.fermeturesVoulues.add(f);
    f.close();
  }

  webContents(dossier: string): WebContents | undefined {
    const f = this.fenetres.get(dossier);
    return f && !f.isDestroyed() ? f.webContents : undefined;
  }

  ouvertes(): { dossier: string; titre: string; url: string }[] {
    return [...this.fenetres]
      .filter(([, f]) => !f.isDestroyed())
      .map(([dossier, f]) => ({ dossier, titre: f.getTitle(), url: f.webContents.getURL() }));
  }

  /** Recharge, ouvre les outils de développement ou ferme (comme l'utilisateur) la fenêtre d'appli au premier plan ; vrai si c'est le cas. */
  surPremierPlan(action: "recharger" | "outils" | "fermer"): boolean {
    const focus = BrowserWindow.getFocusedWindow();
    const f = [...this.fenetres.values()].find((x) => x === focus && !x.isDestroyed());
    if (!f) return false;
    if (action === "recharger") f.webContents.reload();
    else if (action === "outils") f.webContents.toggleDevTools();
    else f.close();
    return true;
  }
}

function memeOrigine(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
