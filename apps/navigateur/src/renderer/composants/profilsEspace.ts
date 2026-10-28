import { PROFIL_DEFAUT, type Espace, type IdEspace, type IdProfil, type ProfilConnexion } from "../../commun/modele";

/** Choix du profil de connexion d'un espace, tel que `creerEspace` et `reglerEspace` le reçoivent. */
export type ChoixProfil = IdProfil | "nouveau";

/** Aucun profil choisi encore : un nouvel espace n'en présélectionne pas, l'utilisateur choisit (« Créer » attend). */
export const PROFIL_A_CHOISIR = "";

export interface OptionProfil {
  valeur: ChoixProfil;
  libelle: string;
}

/**
 * Les profils de connexion qu'on peut donner à un espace (`espaceId`, null pour un nouvel espace) : « Nouveau profil »
 * pour un nouvel espace, « Son propre profil » pour un espace existant, puis un « Partagé avec « … » » par profil
 * qu'utilise au moins un autre espace. « Son propre profil » garde le profil actuel de l'espace s'il est seul à
 * l'utiliser (en créer un nouveau effacerait ses connexions).
 */
export function optionsProfil(espaces: Espace[], profils: ProfilConnexion[], espaceId: IdEspace | null): OptionProfil[] {
  const regle = espaces.find((e) => e.id === espaceId);
  const autres = espaces.filter((e) => e.id !== espaceId);
  const propre: ChoixProfil = regle && !autres.some((e) => e.profil === regle.profil) ? regle.profil : "nouveau";
  const partages = profils.flatMap((p) => {
    const noms = autres.filter((e) => e.profil === p.id).map((e) => e.nom);
    return noms.length > 0 ? [{ valeur: p.id, libelle: `Partagé avec « ${noms.join(", ")} »` }] : [];
  });
  return [{ valeur: propre, libelle: regle ? "Son propre profil" : "Nouveau profil" }, ...partages];
}

/** Supprimer cet espace efface ses connexions : il est le dernier à utiliser un profil autre que celui par défaut. */
export function perdConnexions(espaces: Espace[], espace: Espace): boolean {
  return espace.profil !== PROFIL_DEFAUT && !espaces.some((e) => e.id !== espace.id && e.profil === espace.profil);
}

/** Régler l'espace `espaceId` sur le profil `choix` efface ses connexions : il quitte un profil dont il était le dernier. */
export function choixPerdConnexions(espaces: Espace[], espaceId: IdEspace | null, choix: ChoixProfil): boolean {
  const espace = espaces.find((e) => e.id === espaceId);
  return !!espace && choix !== espace.profil && perdConnexions(espaces, espace);
}
