import { randomUUID } from "node:crypto";
import { DEFAULT_PROFILE, type BrowserState } from "../../shared/model";

export function initialState(genId: () => string = randomUUID): BrowserState {
  const space = genId();
  return {
    version: 2,
    espaces: [{ id: space, nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: DEFAULT_PROFILE }],
    profils: [{ id: DEFAULT_PROFILE }],
    essentiels: [],
    onglets: {},
    fenetres: [
      {
        id: genId(),
        espaceActif: space,
        ordre: { [space]: [] },
        actif: { [space]: null },
        compact: false,
        panneauAgentOuvert: false,
        fermesRecemment: [],
        cadre: null,
      },
    ],
    reglages: { moteur: "google", profilAgent: "claude", largeurPanneauAgent: 420 },
  };
}
