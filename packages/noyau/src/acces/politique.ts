import type { OngletInfo } from "../mcp/pont.js";

function origine(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** Les démos de l'agent tournent dans le conteneur et s'ouvrent en local. */
function estLocale(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Ce que l'agent a le droit de lire (spec §8.2) : un onglet que l'utilisateur lui a donné, depuis lequel
 * il lui a parlé, ou une démo locale que l'agent a ouverte lui-même. Un site extérieur ouvert par
 * l'agent (Gmail, sa banque…) reste soumis à demande. Une autorisation vaut pour un site (origine) :
 * si l'utilisateur change de site, elle tombe.
 */
export class PolitiqueAcces {
  /** id d'onglet → origine autorisée */
  private readonly autorisations = new Map<string, string>();

  accorder(o: OngletInfo): void {
    const org = origine(o.url);
    if (org) this.autorisations.set(o.id, org);
  }

  interactionUtilisateur(o: OngletInfo): void {
    this.accorder(o);
  }

  ongletOuvertParAgent(o: OngletInfo): void {
    if (estLocale(o.url)) this.accorder(o);
  }

  /** L'agent a navigué lui-même un onglet auquel il avait accès : l'accès suit sur le même site ou vers une démo locale. */
  navigationParAgent(id: string, url: string): void {
    const org = origine(url);
    if (!this.autorisations.has(id)) return;
    if (org && (org === this.autorisations.get(id) || estLocale(url))) this.autorisations.set(id, org);
    else this.autorisations.delete(id);
  }

  /** Navigation faite par l'utilisateur : changer de site retire l'autorisation. */
  ongletNavigue(id: string, url: string): void {
    if (this.autorisations.get(id) !== origine(url)) this.autorisations.delete(id);
  }

  ongletFerme(id: string): void {
    this.autorisations.delete(id);
  }

  peutLire(o: OngletInfo): boolean {
    const org = origine(o.url);
    return org !== null && this.autorisations.get(o.id) === org;
  }

  /** Nouvelle conversation : plus aucune autorisation. */
  reinitialiser(): void {
    this.autorisations.clear();
  }
}
