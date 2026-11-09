import { adresseLocale } from "@webaios/noyau";
import type { EtatNavigateur, IdProfil } from "../../shared/modele";

/** At most 2 MB of rendered HTML for an invisible HTML read. */
export const HTML_MAX = 2 * 1024 * 1024;

/** The login profiles a read can use: those of the state that no private space uses. */
export function profilsLisibles(etat: Pick<EtatNavigateur, "profils" | "espaces">): IdProfil[] {
  const prives = new Set(etat.espaces.filter((e) => e.prive).map((e) => e.profil));
  return etat.profils.map((p) => p.id).filter((id) => !prives.has(id));
}

/** A comparable host name: lowercase, without a trailing dot (`exemple.test.` is `exemple.test`). */
const normaliser = (hote: string) => hote.toLowerCase().replace(/\.+$/, "");

/**
 * The URL may be loaded: http(s) only, never an address of the machine or the local network (except
 * `adressesLocales`, tests only); with `domaines`, its host must be exactly one of them, as the
 * kernel checks (packages/noyau/src/widgets/recolte.ts, `verifierUrl`): a subdomain is not allowed there.
 */
export function urlPermise(brute: string, domaines: readonly string[] | undefined, adressesLocales = false): boolean {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!adressesLocales && adresseLocale(u.hostname)) return false;
  return !domaines || domaines.map(normaliser).includes(normaliser(u.hostname));
}

interface PartiesLues {
  titre: unknown;
  texte: unknown;
  liens: unknown;
}

/**
 * Merges the snapshots of a scrolled page. A virtualized list (Leboncoin) removes from the page the items that left
 * the screen: the final read shows only the last ones. Each snapshot is compared to the previous one: the common header and
 * footer are set aside, then the new snapshot's list is realigned on the end of the previous one's
 * (what they have in common), and only the new remainder is added, before the footer. Nothing is deduplicated
 * line by line: the same price or the same label from one item to the next stays. Links are merged by address, with
 * the longest text seen. The title is that of the final read. The caps then apply, at formatting.
 */
export function cumulerParties(releves: unknown[]): PartiesLues {
  let lignes: string[] = [];
  const liens = new Map<string, string>();
  let titre: unknown = "";
  let precedent: string[] | null = null;
  for (const r of releves) {
    const p = (r ?? {}) as Partial<PartiesLues>;
    titre = p.titre ?? titre;
    const ici = String(p.texte ?? "").split("\n");
    if (precedent === null) lignes = [...ici];
    else lignes = ajouterSuite(lignes, precedent, ici);
    precedent = ici;
    for (const l of Array.isArray(p.liens) ? (p.liens as unknown[]) : []) {
      const brut = (l as { url?: unknown; texte?: unknown } | null) ?? {};
      if (typeof brut.url !== "string") continue;
      const texte = String(brut.texte ?? "");
      if (texte.length > (liens.get(brut.url)?.length ?? -1)) liens.set(brut.url, texte);
    }
  }
  return { titre, texte: lignes.join("\n"), liens: [...liens].map(([url, texte]) => ({ url, texte })) };
}

/** Trailing lines of the previous snapshot that can be ignored for the realignment (« Chargement… », « Voir plus » button). */
const FIN_IGNOREE = 3;

/** `cumul` completed with what `ici` shows anew compared to `avant`, the previous snapshot. */
function ajouterSuite(cumul: string[], avant: string[], ici: string[]): string[] {
  // Header: the first common lines.
  let debut = 0;
  while (debut < ici.length && debut < avant.length && ici[debut] === avant[debut]) debut++;
  // Footer: the last common lines, but only as long as the line before is also the same. Otherwise the
  // list's last price, identical by chance from one screen to the next, would be taken for footer.
  let pied = 0;
  const dernier = (t: string[], k: number) => t[t.length - 1 - k];
  while (
    ici.length - pied - 1 > debut &&
    avant.length - pied - 1 > debut &&
    dernier(ici, pied) === dernier(avant, pied) &&
    dernier(ici, pied + 1) === dernier(avant, pied + 1)
  ) {
    pied++;
  }
  const listeAvant = avant.slice(debut, avant.length - pied);
  const liste = ici.slice(debut, ici.length - pied);
  // The realignment: the longest end of the previous list (give or take a few lines) that starts the new list.
  let commun = 0;
  for (let ignorees = 0; ignorees <= Math.min(FIN_IGNOREE, listeAvant.length) && commun === 0; ignorees++) {
    const fin = listeAvant.length - ignorees;
    // A single common line after ignored lines can be so by chance: at least two are then needed.
    for (let k = Math.min(fin, liste.length); k > (ignorees > 0 ? 1 : 0); k--) {
      let pareil = true;
      for (let j = 0; j < k && pareil; j++) pareil = listeAvant[fin - k + j] === liste[j];
      if (pareil) {
        commun = k;
        break;
      }
    }
  }
  const suite = liste.slice(commun);
  if (suite.length === 0) return cumul;
  // Before the footer already kept, if it ends the accumulation.
  const piedGarde = pied > 0 && cumul.slice(-pied).every((l, i) => l === ici[ici.length - pied + i]) ? pied : 0;
  return [...cumul.slice(0, cumul.length - piedGarde), ...suite, ...cumul.slice(cumul.length - piedGarde)];
}
