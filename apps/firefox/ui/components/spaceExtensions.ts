import type { Space, SpaceId, ProfileId } from "../../shared/model";

/** What must be known about an extension to warn: where it is active. */
export interface ProfileExtension {
  key: string;
  name: string;
  source: "store" | "agent";
  profiles: ProfileId[];
}

/**
 * What saving the draft (`b`, `id` null: a new space) changes for the chosen profile's extensions. `privePartage`:
 * the names of the profile's other spaces, when the draft is private and an extension is active in it (it runs there
 * too: only a profile of its own protects it). `agentDesactivees`: the agent's extensions active in this profile,
 * which the main process disables as soon as a space of the profile is private.
 */
export function warnings(
  b: { id: SpaceId | null; private: boolean; profile: ProfileId },
  spaces: Space[],
  lines: ProfileExtension[],
): { sharedPrivate: string[]; agentDisabled: string[] } {
  const actives = lines.filter((l) => l.profiles.includes(b.profile));
  if (!b.private || actives.length === 0) return { sharedPrivate: [], agentDisabled: [] };
  return {
    sharedPrivate: spaces.filter((e) => e.id !== b.id && e.profile === b.profile).map((e) => e.name),
    agentDisabled: actives.filter((l) => l.source === "agent").map((l) => l.name),
  };
}
