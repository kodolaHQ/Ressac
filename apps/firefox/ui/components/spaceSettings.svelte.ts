import type { SpaceId } from "../../shared/model";
import type { ProfileChoice } from "./spaceProfiles";

/** Settings of a space in progress in the modal (`id` null: a new space). */
export interface SpaceDraft {
  id: SpaceId | null;
  name: string;
  icon: string;
  private: boolean;
  profile: ProfileChoice;
}

/**
 * Modal for a space's settings, mounted at window level (App.svelte). The draft lives here: if an agent request comes
 * in front, the modal closes for the time of the request and comes back with what was typed.
 */
export const spaceSettings = $state<{ draft: SpaceDraft | null }>({ draft: null });
