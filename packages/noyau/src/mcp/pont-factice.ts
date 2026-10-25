import { OngletIntrouvable, type OngletInfo, type PontNavigateur } from "./pont.js";

// PNG 1×1 transparent.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** Navigateur simulé : pour les tests et la commande de développement. */
export class PontFactice implements PontNavigateur {
  readonly appels: { methode: string; args: unknown[] }[] = [];
  private readonly onglets: OngletInfo[];
  private actif: string | null;
  private readonly autoriser: boolean;
  private compteur = 0;

  constructor(onglets: OngletInfo[], o: { actif: string | null; autoriser: boolean }) {
    this.onglets = onglets.map((x) => ({ ...x }));
    this.actif = o.actif;
    this.autoriser = o.autoriser;
  }

  private noter(methode: string, ...args: unknown[]) {
    this.appels.push({ methode, args });
  }

  private trouver(id: string): OngletInfo {
    const o = this.onglets.find((x) => x.id === id);
    if (!o) throw new OngletIntrouvable(id);
    return o;
  }

  async ongletActif() {
    this.noter("ongletActif");
    return this.onglets.find((x) => x.id === this.actif) ?? null;
  }

  async listerOnglets() {
    this.noter("listerOnglets");
    return this.onglets.map((x) => ({ ...x }));
  }

  async lireTexte(id: string) {
    this.noter("lireTexte", id);
    const o = this.trouver(id);
    return { texte: `Texte de ${o.titre} (${o.url})` };
  }

  async ouvrirOnglet(url: string, espace?: string) {
    this.noter("ouvrirOnglet", url, espace);
    const o = { id: `agent-${++this.compteur}`, titre: url, url, espace: espace ?? "perso" };
    this.onglets.push(o);
    this.actif = o.id;
    return { ...o };
  }

  async naviguer(id: string, url: string) {
    this.noter("naviguer", id, url);
    this.trouver(id).url = url;
  }

  async capturer(id: string) {
    this.noter("capturer", id);
    this.trouver(id);
    return PNG;
  }

  async demanderAutorisation(o: OngletInfo) {
    this.noter("demanderAutorisation", o.id);
    return this.autoriser;
  }
}
