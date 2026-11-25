import { api } from "../state.svelte";
import type { SpaceId } from "../../shared/model";
import type { AuraId } from "../../shared/aura";
import type { ProfileChoice } from "./spaceProfiles";

/** Settings of a space in progress in the modal (`id` null: a new space). */
export interface SpaceDraft {
  id: SpaceId | null;
  name: string;
  icon: string;
  private: boolean;
  profile: ProfileChoice;
  aura: AuraId;
}

/**
 * Modal for a space's settings, mounted at window level (App.svelte). The draft lives here: if an agent request comes
 * in front, the modal closes for the time of the request and comes back with what was typed.
 */
export const spaceSettings = $state<{ draft: SpaceDraft | null }>({ draft: null });

/**
 * A space's passport deleted with it: Touch ID first (a delete token), then « Supprimer ce passeport ». null when
 * Touch ID was refused (nothing done), false when the passport could not be removed.
 */
export async function removePassport(profile: string): Promise<boolean | null> {
  const passport = api.settings.passport!;
  const unlocked = await passport.unlock(profile, "delete");
  return unlocked ? passport.removePassport(profile, unlocked.token) : null;
}
