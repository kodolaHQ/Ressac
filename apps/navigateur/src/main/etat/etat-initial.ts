import { randomUUID } from "node:crypto";
import type { EtatNavigateur } from "../../commun/modele";

export function etatInitial(genId: () => string = randomUUID): EtatNavigateur {
  const espace = genId();
  return {
    version: 1,
    espaces: [{ id: espace, nom: "Perso", icone: "🏠", epingles: [] }],
    essentiels: [],
    onglets: {},
    fenetres: [
      {
        id: genId(),
        espaceActif: espace,
        ordre: { [espace]: [] },
        actif: { [espace]: null },
        compact: false,
        panneauAgentOuvert: false,
        fermesRecemment: [],
      },
    ],
    reglages: { moteur: "google" },
  };
}
