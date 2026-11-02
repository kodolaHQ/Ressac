import type { Action } from "../commun/api";
import type { EtatNavigateur, IdFenetre } from "../commun/modele";

type Element = { favori: string } | { onglet: string };

/** Ce que la barre latérale affiche, de haut en bas : épinglés de l'espace, puis ses onglets. */
function elementsAffiches(etat: EtatNavigateur, fenetreId: IdFenetre): { elements: Element[]; courant: number } {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const espace = f && etat.espaces.find((e) => e.id === f.espaceActif);
  if (!f || !espace) return { elements: [], courant: -1 };
  const elements: Element[] = [...espace.epingles.map((p) => ({ favori: p.id })), ...(f.ordre[espace.id] ?? []).map((id) => ({ onglet: id }))];
  const actif = f.actif[espace.id];
  const o = actif ? etat.onglets[actif] : undefined;
  const courant = o ? elements.findIndex((x) => ("onglet" in x ? x.onglet === o.id : x.favori === o.lien?.id)) : -1;
  return { elements, courant };
}

function versElement(fenetreId: IdFenetre, x: Element | undefined): Action | null {
  if (!x) return null;
  return "onglet" in x ? { type: "activerOnglet", id: x.onglet } : { type: "ouvrirFavori", fenetreId, genre: "epingle", id: x.favori };
}

/** ⌘1…⌘8 : n-ième élément affiché ; ⌘9 : le dernier. */
export function versNieme(etat: EtatNavigateur, fenetreId: IdFenetre, n: number): Action | null {
  const { elements } = elementsAffiches(etat, fenetreId);
  return versElement(fenetreId, n === 9 ? elements.at(-1) : elements[n - 1]);
}
