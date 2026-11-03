import type { EtatNavigateur, IdFenetre, IdOnglet } from "./modele";
import { cleEspace } from "./modele";

/** Onglets ouverts que l'espace actif peut afficher, dans l'ordre de la barre latérale : essentiels, épinglés, puis les autres. */
export function ongletsParcourables(etat: EtatNavigateur, fenetreId: IdFenetre): IdOnglet[] {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const espace = f && etat.espaces.find((x) => x.id === f.espaceActif);
  if (!f || !espace) return [];
  const cle = cleEspace(etat, espace.id);
  const ouverts = Object.values(etat.onglets).filter((o) => o.fenetreId === f.id);
  const essentiels = etat.essentiels.flatMap((fav) =>
    ouverts.filter((o) => o.lien?.type === "essentiel" && o.lien.id === fav.id && cleEspace(etat, o.espaceId) === cle).map((o) => o.id),
  );
  const epingles = espace.epingles.flatMap((fav) =>
    ouverts.filter((o) => o.lien?.type === "epingle" && o.lien.id === fav.id && o.espaceId === espace.id).map((o) => o.id),
  );
  const vus = new Set<IdOnglet>();
  return [...essentiels, ...epingles, ...(f.ordre[espace.id] ?? [])].filter((id) => !vus.has(id) && !!vus.add(id) && !!etat.onglets[id]);
}
