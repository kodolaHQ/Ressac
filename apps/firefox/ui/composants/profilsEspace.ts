import { DEFAULT_PROFILE, type Space, type SpaceId, type ProfileId, type ConnectionProfile } from "../../shared/modele";

/** Choice of a space's sign-in profile, as `creerEspace` and `reglerEspace` receive it. */
export type ChoixProfil = ProfileId | "nouveau";

/** No profile chosen yet: a new space does not preselect one, the user chooses (« Créer » waits). */
export const PROFIL_A_CHOISIR = "";

export interface OptionProfil {
  valeur: ChoixProfil;
  libelle: string;
}

/**
 * The sign-in profiles that can be given to a space (`espaceId`, null for a new space): « Nouveau profil » for a new
 * space, « Son propre profil » for an existing space, then a « Partagé avec « … » » per profile used by at least one
 * other space. « Son propre profil » keeps the space's current profile if it is the only one using it (creating a
 * new one would erase its sign-ins).
 */
export function optionsProfil(espaces: Space[], profils: ConnectionProfile[], espaceId: SpaceId | null): OptionProfil[] {
  const regle = espaces.find((e) => e.id === espaceId);
  const autres = espaces.filter((e) => e.id !== espaceId);
  const propre: ChoixProfil = regle && !autres.some((e) => e.profil === regle.profil) ? regle.profil : "nouveau";
  const partages = profils.flatMap((p) => {
    const noms = autres.filter((e) => e.profil === p.id).map((e) => e.nom);
    return noms.length > 0 ? [{ valeur: p.id, libelle: `Partagé avec « ${noms.join(", ")} »` }] : [];
  });
  return [{ valeur: propre, libelle: regle ? "Son propre profil" : "Nouveau profil" }, ...partages];
}

/** Deleting this space erases its sign-ins: it is the last one using a profile other than the default. */
export function perdConnexions(espaces: Space[], espace: Space): boolean {
  return espace.profil !== DEFAULT_PROFILE && !espaces.some((e) => e.id !== espace.id && e.profil === espace.profil);
}

/** Setting space `espaceId` to profile `choix` erases its sign-ins: it leaves a profile it was the last one on. */
export function choixPerdConnexions(espaces: Space[], espaceId: SpaceId | null, choix: ChoixProfil): boolean {
  const espace = espaces.find((e) => e.id === espaceId);
  return !!espace && choix !== espace.profil && perdConnexions(espaces, espace);
}
