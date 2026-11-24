import { format } from "../../shared/i18n";
import { DEFAULT_PROFILE, type Space, type SpaceId, type ProfileId, type ConnectionProfile } from "../../shared/model";

/** Choice of a space's sign-in profile, as `createSpace` and `updateSpace` receive it. */
export type ProfileChoice = ProfileId | "new";

/** No profile chosen yet: a new space does not preselect one, the user chooses (« Créer » waits). */
export const PROFILE_TO_CHOOSE = "";

export interface ProfileOption {
  value: ProfileChoice;
  label: string;
}

/**
 * The sign-in profiles that can be given to a space (`espaceId`, null for a new space): « Nouveau profil » for a new
 * space, « Son propre profil » for an existing space, then a « Partagé avec « … » » per profile used by at least one
 * other space. « Son propre profil » keeps the space's current profile if it is the only one using it (creating a
 * new one would erase its sign-ins).
 */
export function profileOptions(spaces: Space[], profiles: ConnectionProfile[], spaceId: SpaceId | null, locale: string): ProfileOption[] {
  const rule = spaces.find((e) => e.id === spaceId);
  const others = spaces.filter((e) => e.id !== spaceId);
  const clean: ProfileChoice = rule && !others.some((e) => e.profile === rule.profile) ? rule.profile : "new";
  const shared = profiles.flatMap((p) => {
    const names = others.filter((e) => e.profile === p.id).map((e) => e.name);
    return names.length > 0 ? [{ value: p.id, label: format(locale, "sidebar-profile-shared", { names: names.join(", ") }) }] : [];
  });
  return [{ value: clean, label: format(locale, rule ? "sidebar-profile-own" : "sidebar-profile-new") }, ...shared];
}

/** Deleting this space erases its sign-ins: it is the last one using a profile other than the default. */
export function losesConnections(spaces: Space[], space: Space): boolean {
  return space.profile !== DEFAULT_PROFILE && !spaces.some((e) => e.id !== space.id && e.profile === space.profile);
}

/**
 * What deleting `space` (with `tabs` open tabs) loses, or null when it loses nothing and needs no confirmation.
 * `passport`: the entries of its profile's passport (`passportCount`), counted only when the profile goes with it.
 */
export function deletionLosses(
  spaces: Space[],
  space: Space,
  tabs: number,
  passportCount = 0,
): { tabs: number; logins: boolean; pinned: number; folders: number; passport: number } | null {
  const logins = losesConnections(spaces, space);
  const lost = { tabs, logins, pinned: space.pinned.length, folders: space.folders.length, passport: logins ? passportCount : 0 };
  return lost.tabs > 0 || lost.logins || lost.pinned > 0 || lost.folders > 0 ? lost : null;
}

/**
 * Setting space `espaceId` to profile `choix` erases its sign-ins (it leaves a profile it was the last one on), and
 * with them its passport's `passportCount` entries; null when it loses nothing.
 */
export function choiceLosesConnections(spaces: Space[], spaceId: SpaceId | null, choice: ProfileChoice, passportCount = 0): { passport: number } | null {
  const space = spaces.find((e) => e.id === spaceId);
  return !!space && choice !== space.profile && losesConnections(spaces, space) ? { passport: passportCount } : null;
}
