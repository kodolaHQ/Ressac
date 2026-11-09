import { DEFAULT_PROFILE, type Space, type SpaceId, type ProfileId, type ConnectionProfile } from "../../shared/model";

/** Choice of a space's sign-in profile, as `creerEspace` and `reglerEspace` receive it. */
export type ProfileChoice = ProfileId | "nouveau";

/** No profile chosen yet: a new space does not preselect one, the user chooses (« Créer » waits). */
export const PROFILE_TO_CHOOSE = "";

export interface ProfileOption {
  valeur: ProfileChoice;
  libelle: string;
}

/**
 * The sign-in profiles that can be given to a space (`espaceId`, null for a new space): « Nouveau profil » for a new
 * space, « Son propre profil » for an existing space, then a « Partagé avec « … » » per profile used by at least one
 * other space. « Son propre profil » keeps the space's current profile if it is the only one using it (creating a
 * new one would erase its sign-ins).
 */
export function profileOptions(spaces: Space[], profiles: ConnectionProfile[], spaceId: SpaceId | null): ProfileOption[] {
  const regle = spaces.find((e) => e.id === spaceId);
  const others = spaces.filter((e) => e.id !== spaceId);
  const clean: ProfileChoice = regle && !others.some((e) => e.profil === regle.profil) ? regle.profil : "nouveau";
  const shared = profiles.flatMap((p) => {
    const names = others.filter((e) => e.profil === p.id).map((e) => e.nom);
    return names.length > 0 ? [{ valeur: p.id, libelle: `Partagé avec « ${names.join(", ")} »` }] : [];
  });
  return [{ valeur: clean, libelle: regle ? "Son propre profil" : "Nouveau profil" }, ...shared];
}

/** Deleting this space erases its sign-ins: it is the last one using a profile other than the default. */
export function losesConnections(spaces: Space[], space: Space): boolean {
  return space.profil !== DEFAULT_PROFILE && !spaces.some((e) => e.id !== space.id && e.profil === space.profil);
}

/** Setting space `espaceId` to profile `choix` erases its sign-ins: it leaves a profile it was the last one on. */
export function choiceLosesConnections(spaces: Space[], spaceId: SpaceId | null, choice: ProfileChoice): boolean {
  const space = spaces.find((e) => e.id === spaceId);
  return !!space && choice !== space.profil && losesConnections(spaces, space);
}
