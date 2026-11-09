import type { Space, SpaceId, ProfileId } from "../../shared/modele";

/** What must be known about an extension to warn: where it is active. */
export interface ProfileExtension {
  cle: string;
  nom: string;
  source: "store" | "agent";
  profils: ProfileId[];
}

/**
 * What saving the draft (`b`, `id` null: a new space) changes for the chosen profile's extensions. `privePartage`:
 * the names of the profile's other spaces, when the draft is private and an extension is active in it (it runs there
 * too: only a profile of its own protects it). `agentDesactivees`: the agent's extensions active in this profile,
 * which the main process disables as soon as a space of the profile is private.
 */
export function warnings(
  b: { id: SpaceId | null; prive: boolean; profil: ProfileId },
  spaces: Space[],
  lignes: ProfileExtension[],
): { privePartage: string[]; agentDesactivees: string[] } {
  const actives = lignes.filter((l) => l.profils.includes(b.profil));
  if (!b.prive || actives.length === 0) return { privePartage: [], agentDesactivees: [] };
  return {
    privePartage: spaces.filter((e) => e.id !== b.id && e.profil === b.profil).map((e) => e.nom),
    agentDesactivees: actives.filter((l) => l.source === "agent").map((l) => l.nom),
  };
}
