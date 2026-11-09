import type { Espace, IdEspace, IdProfil } from "../../shared/modele";

/** Ce qu'il faut savoir d'une extension pour avertir : où elle est active. */
export interface ExtensionDuProfil {
  cle: string;
  nom: string;
  source: "store" | "agent";
  profils: IdProfil[];
}

/**
 * Ce que l'enregistrement du brouillon (`b`, `id` null : un nouvel espace) change pour les extensions du profil
 * choisi. `privePartage` : les noms des autres espaces de ce profil, quand le brouillon est privé et qu'une extension y
 * est active (elle y tourne aussi : seul un profil à lui l'en protège). `agentDesactivees` : les extensions de l'agent
 * actives dans ce profil, que le processus principal désactive dès qu'un espace du profil est privé.
 */
export function avertissements(
  b: { id: IdEspace | null; prive: boolean; profil: IdProfil },
  espaces: Espace[],
  lignes: ExtensionDuProfil[],
): { privePartage: string[]; agentDesactivees: string[] } {
  const actives = lignes.filter((l) => l.profils.includes(b.profil));
  if (!b.prive || actives.length === 0) return { privePartage: [], agentDesactivees: [] };
  return {
    privePartage: espaces.filter((e) => e.id !== b.id && e.profil === b.profil).map((e) => e.nom),
    agentDesactivees: actives.filter((l) => l.source === "agent").map((l) => l.nom),
  };
}
