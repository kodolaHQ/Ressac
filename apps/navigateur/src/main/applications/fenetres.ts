import { BrowserWindow, screen, session, type WebContents } from "electron";
import type { Application } from "@webaios/noyau";
import type { Cadre } from "../../commun/modele";
import { preferencesWeb } from "../onglets/vues";
import { refuserPermissions } from "../permissions";
import { faviconEnDonnees, memeOrigine } from "./favicon";
import type { MemoireApplications } from "./service";

/** Tests automatiques : aucune fenêtre à l'écran. */
const INVISIBLE = process.env.WEBAIOS_INVISIBLE === "1";

/** Partition de session d'une appli : jamais celle de la navigation. */
export const partitionApplication = (dossier: string) => `persist:app-${dossier}`;

/** Sessions d'applis déjà fermées aux permissions (une par dossier, gardée par Electron toute la vie du navigateur). */
const sessionsFermees = new WeakSet<Electron.Session>();

/** La session d'une appli, sans aucune permission : son code n'a pas été relu. */
function sessionApplication(dossier: string): Electron.Session {
  const s = session.fromPartition(partitionApplication(dossier));
  if (!sessionsFermees.has(s)) {
    refuserPermissions(s);
    sessionsFermees.add(s);
  }
  return s;
}

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
  /** Adresse demandée à chaque fenêtre : la page n'en a pas d'autre avant d'être chargée. */
  private readonly adresses = new Map<string, string>();
  /** Fermetures décidées par le programme (appli arrêtée) : elles n'arrêtent rien. */
  private readonly fermeturesVoulues = new WeakSet<BrowserWindow>();

  constructor(
    private readonly o: {
      memoire: MemoireApplications;
      ouvrirOnglet: (url: string) => void;
      /** L'utilisateur a fermé la fenêtre : l'appli doit s'arrêter. */
      surFermeture: (dossier: string) => void;
      /** La fenêtre est fermée, par l'utilisateur ou par le programme. */
      surFermee: (dossier: string) => void;
      /** La page de l'appli a changé d'adresse. */
      surNavigation?: (dossier: string, url: string) => void;
      /** L'appli a montré son favicon (adresse `data:`, qui reste lisible quand l'appli est arrêtée). */
      surFavicon?: (dossier: string, favicon: string) => void;
    },
  ) {}

  /** Crée la fenêtre de l'appli ou la remet devant, et charge l'appli sur son port. */
  ouvrir(a: Application): void {
    const url = `http://localhost:${a.port}/`;
    const f = this.montrer(a.dossier) ? this.fenetres.get(a.dossier)! : this.creer(a);
    f.setTitle(a.nom);
    this.adresses.set(a.dossier, url);
    void f.loadURL(url).catch(() => {
      // Appli arrêtée entre-temps, ou rechargée aussitôt : rien à faire.
    });
  }

  /** Remet devant la fenêtre de l'appli, sans la recharger ; faux si elle n'en a pas. */
  montrer(dossier: string): boolean {
    const f = this.fenetres.get(dossier);
    if (!f || f.isDestroyed()) return false;
    if (!INVISIBLE) {
      if (f.isMinimized()) f.restore();
      f.show();
      f.focus();
    }
    return true;
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
      webPreferences: preferencesWeb(sessionApplication(dossier)),
    });
    this.fenetres.set(dossier, f);
    // Le titre reste le nom de l'appli : c'est lui qui la distingue des fenêtres principales.
    f.on("page-title-updated", (e) => e.preventDefault());
    const noterCadre = () => this.noterCadre(dossier, f);
    f.on("resize", noterCadre);
    f.on("move", noterCadre);
    f.on("close", noterCadre);
    f.on("closed", () => {
      if (this.fenetres.get(dossier) === f) {
        this.fenetres.delete(dossier);
        this.adresses.delete(dossier);
      }
      this.o.surFermee(dossier);
      if (!this.fermeturesVoulues.has(f)) this.o.surFermeture(dossier);
    });
    const wc = f.webContents;
    // Le code de l'appli n'a pas été relu : son « beforeunload » n'empêche ni de fermer sa fenêtre, ni de quitter.
    wc.on("will-prevent-unload", (e) => e.preventDefault());
    wc.on("page-favicon-updated", (_e, favicons) => {
      const url = favicons[0];
      if (url && this.o.surFavicon) void faviconEnDonnees((u, init) => wc.session.fetch(u, init), url, wc.getURL()).then((d) => d && this.o.surFavicon?.(dossier, d));
    });
    // L'appli reste sur son origine (celle de son port) : un lien ou une redirection du serveur vers ailleurs s'ouvre
    // dans un onglet.
    const resterSurLAppli = (e: Electron.Event, url: string) => {
      if (memeOrigine(url, this.adresses.get(dossier) ?? wc.getURL())) return;
      e.preventDefault();
      if (/^https?:\/\//.test(url)) this.o.ouvrirOnglet(url);
    };
    wc.on("will-navigate", (e, url) => resterSurLAppli(e, url));
    wc.on("will-redirect", (e, url, _surPlace, cadrePrincipal) => {
      if (cadrePrincipal) resterSurLAppli(e, url);
    });
    // L'accès de l'agent suit la page, comme pour un onglet (une relance sur un autre port change d'origine).
    wc.on("did-navigate", (_e, url) => this.o.surNavigation?.(dossier, url));
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) this.o.ouvrirOnglet(url);
      return { action: "deny" };
    });
    return f;
  }

  /** Taille et position retenues aussitôt (la mémoire écrit en différé) : une fenêtre détruite n'a plus de cadre à lire. */
  private noterCadre(dossier: string, f: BrowserWindow): void {
    if (f.isDestroyed() || f.isFullScreen() || f.isMinimized()) return;
    const { x, y, width, height } = f.getNormalBounds();
    this.o.memoire.noter(dossier, { cadre: { x, y, largeur: width, hauteur: height } });
  }

  /**
   * Fermeture voulue par le programme (appli arrêtée ou en erreur) : n'appelle pas `surFermeture`. Détruite, la fenêtre
   * ne demande rien à la page (aucun « beforeunload ») ; elle n'émet pas « close » : son cadre est noté avant.
   */
  fermer(dossier: string): void {
    const f = this.fenetres.get(dossier);
    this.fenetres.delete(dossier);
    if (!f || f.isDestroyed()) return;
    this.fermeturesVoulues.add(f);
    this.noterCadre(dossier, f);
    f.destroy();
  }

  webContents(dossier: string): WebContents | undefined {
    const f = this.fenetres.get(dossier);
    return f && !f.isDestroyed() ? f.webContents : undefined;
  }

  ouvertes(): { dossier: string; titre: string; url: string }[] {
    return [...this.fenetres]
      .filter(([, f]) => !f.isDestroyed())
      .map(([dossier, f]) => ({ dossier, titre: f.getTitle(), url: f.webContents.getURL() || this.adresses.get(dossier) || "" }));
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
