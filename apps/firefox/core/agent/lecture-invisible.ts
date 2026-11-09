import { adresseLocale } from "@webaios/noyau";
import type { EtatNavigateur, IdProfil } from "../../shared/modele";

/** Au plus 2 Mo de HTML rendus par `lireHtmlInvisible`. */
export const HTML_MAX = 2 * 1024 * 1024;

/** Les profils de connexion qu'une lecture peut utiliser : ceux de l'état qu'aucun espace privé n'utilise. */
export function profilsLisibles(etat: Pick<EtatNavigateur, "profils" | "espaces">): IdProfil[] {
  const prives = new Set(etat.espaces.filter((e) => e.prive).map((e) => e.profil));
  return etat.profils.map((p) => p.id).filter((id) => !prives.has(id));
}

/** Un nom d'hôte comparable : en minuscules, sans point final (`exemple.test.` est `exemple.test`). */
const normaliser = (hote: string) => hote.toLowerCase().replace(/\.+$/, "");

/**
 * L'URL peut être chargée : http(s) seulement, jamais une adresse de la machine ou du réseau local (sauf
 * `adressesLocales`, tests seulement) ; avec `domaines`, son hôte doit être l'un d'eux exactement, comme le vérifie le
 * noyau (packages/noyau/src/widgets/recolte.ts, `verifierUrl`) : un sous-domaine n'y est pas permis.
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
 * Réunit les relevés d'une page défilée. Une liste virtualisée (Leboncoin) retire de la page les éléments sortis de
 * l'écran : la lecture finale n'en montre que les derniers. Chaque relevé est comparé au précédent : l'en-tête et le
 * pied de page communs sont mis de côté, puis la liste du nouveau relevé est recalée sur la fin de celle du précédent
 * (ce qu'ils ont en commun), et seule la suite, nouvelle, est ajoutée, avant le pied de page. Rien n'est dédoublonné
 * ligne à ligne : un même prix ou un même libellé d'un élément à l'autre reste. Les liens sont réunis par adresse, avec
 * le plus long texte vu. Le titre est celui de la lecture finale. Les plafonds s'appliquent ensuite, à la mise en forme.
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

/** Lignes de fin du relevé précédent qu'on peut ignorer pour le recalage (« Chargement… », bouton « Voir plus »). */
const FIN_IGNOREE = 3;

/** `cumul` complété de ce que `ici` montre de nouveau par rapport à `avant`, le relevé précédent. */
function ajouterSuite(cumul: string[], avant: string[], ici: string[]): string[] {
  // En-tête : les premières lignes communes.
  let debut = 0;
  while (debut < ici.length && debut < avant.length && ici[debut] === avant[debut]) debut++;
  // Pied de page : les dernières lignes communes, mais seulement tant que la ligne d'avant est aussi la même. Sinon le
  // dernier prix de la liste, pareil par hasard d'un écran à l'autre, serait pris pour du pied de page.
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
  // Le recalage : la plus longue fin de la liste d'avant (à quelques lignes près) qui commence la nouvelle liste.
  let commun = 0;
  for (let ignorees = 0; ignorees <= Math.min(FIN_IGNOREE, listeAvant.length) && commun === 0; ignorees++) {
    const fin = listeAvant.length - ignorees;
    // Une seule ligne commune après des lignes ignorées peut l'être par hasard : il en faut alors au moins deux.
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
  // Avant le pied de page déjà gardé, s'il termine le cumul.
  const piedGarde = pied > 0 && cumul.slice(-pied).every((l, i) => l === ici[ici.length - pied + i]) ? pied : 0;
  return [...cumul.slice(0, cumul.length - piedGarde), ...suite, ...cumul.slice(cumul.length - piedGarde)];
}
