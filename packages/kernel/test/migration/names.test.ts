import { describe, expect, it } from "vitest";
import * as names from "../../src/migration/names.js";

const FRENCH = new Set(
  ("etat fenetre onglet espace accueil fichier dossier chemin donnees erreur texte nom cle liste resultat profil projet " +
    "memoire recolte relecture noyau hote retouche empreinte accord ouvrir fermer ecrire lire enregistrer supprimer " +
    "ajouter afficher attendre demarrer arreter envoyer garder valider charger creer chercher lancer executer traiter " +
    "trier rediger saisie libelle brouillon demande panneau barre bouton composant parametres adresse delai duree suivi " +
    "refus atelier viseur panier sonde titre valeur statut sortie entree lien bloc").split(" "),
);

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[-_./ ]+/)
    .filter(Boolean);

type Map = Readonly<Record<string, string>>;
const maps = Object.entries(names).filter(([n]) => !n.endsWith("EXCEPTIONS")) as [string, Map][];
const exceptions = [...Object.values(names.KEY_EXCEPTIONS), ...Object.values(names.VALUE_EXCEPTIONS)];

/** English names that several French names share on purpose (same meaning in different formats). */
const SHARED: Record<string, string[]> = {
  KEYS: ["pinned", "previous", "right", "read", "running", "progress", "done", "input", "start", "label"],
  VALUES: ["succeeded", "partial", "failed", "interrupted", "running", "devtools", "refused", "group", "review", "read"],
  WINDOW_API: ["review"],
};

describe("migration names", () => {
  it("no English name contains a French word", () => {
    const bad = [...maps.map(([, m]) => m), ...exceptions]
      .flatMap((m) => Object.values(m))
      .filter((v) => words(v).some((w) => FRENCH.has(w)));
    expect(bad).toEqual([]);
  });

  it("two French names share an English name only where listed", () => {
    for (const [name, m] of maps) {
      const count = new Map<string, number>();
      for (const v of Object.values(m)) count.set(v, (count.get(v) ?? 0) + 1);
      const shared = [...count].filter(([, n]) => n > 1).map(([v]) => v).sort();
      expect(shared, name).toEqual([...(SHARED[name] ?? [])].sort());
    }
  });

  it("covers exactly the 9 French block types", () => {
    expect(names.BLOCK_TYPES).toEqual({
      "source.flux": "source.feed",
      "source.recuperer": "source.fetch",
      "web.chercher": "web.search",
      "liste.nouveaux": "list.new",
      "liste.dedoublonner": "list.dedupe",
      "liste.garder": "list.keep",
      "ia.trier": "ai.sort",
      "ia.rediger": "ai.write",
      sortie: "output",
    });
  });

  it("has no identity mapping", () => {
    const same = [...maps.map(([, m]) => m), ...exceptions].flatMap((m) => Object.entries(m)).filter(([k, v]) => k === v);
    expect(same).toEqual([]);
  });

  it("keeps the starter widget id and the layout height", () => {
    expect(names.KEYS.l).toBe("w");
    expect("h" in names.KEYS).toBe(false);
    expect(maps.filter(([, m]) => "meteo" in m)).toEqual([]);
  });
});
