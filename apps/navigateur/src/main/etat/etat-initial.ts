import { randomUUID } from "node:crypto";
import { PROFIL_DEFAUT, type EtatNavigateur } from "../../commun/modele";

export function etatInitial(genId: () => string = randomUUID): EtatNavigateur {
  const espace = genId();
  return {
    version: 2,
    espaces: [{ id: espace, nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: PROFIL_DEFAUT }],
    profils: [{ id: PROFIL_DEFAUT }],
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
        cadre: null,
      },
    ],
    reglages: { moteur: "google", profilAgent: "claude", largeurPanneauAgent: 420 },
  };
}
