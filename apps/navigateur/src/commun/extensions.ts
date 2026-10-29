import { accordRenforce, empreintePortee, libellesPortee, type AnalyseManifeste, type SourceExtension } from "@webaios/noyau";
import type { Espace, EtatNavigateur } from "./modele";

/** Réponse à une saisie qui n'est ni un id d'extension, ni l'adresse de sa page du Chrome Web Store. */
export const SAISIE_INVALIDE = "Adresse ou identifiant du Chrome Web Store attendu";

/** Ce que montre la carte d'accord d'une extension (DemandeExtension.svelte) : tout y est affiché en texte. */
export interface CarteExtension {
  cle: string;
  nom: string;
  source: SourceExtension;
  version: string;
  /** Libellés de la portée (`libellesPortee`), dans leur ordre. */
  droits: string[];
  sites: string[];
  tousLesSites: boolean;
  /** Agent : domaines où elle peut envoyer (`[]` : nulle part) ; Store : null. */
  reseau: string[] | null;
  /** Accord renforcé : une case à cocher avant « Activer ». */
  renforce: boolean;
  /** Nom de l'espace où elle est activée. */
  espace: string;
  /** Son id : la carte tombe si l'espace disparaît (ou, pour l'agent, si son profil devient privé). */
  espaceId: string;
  /** Les autres espaces du même profil, où elle sera active aussi. */
  autresEspaces: string[];
  /** Mise à jour : la version installée. */
  maj: { de: string } | null;
  /** `empreintePortee` de la portée montrée : l'appelant n'écrit l'accord que pour une portée de même empreinte. */
  empreinte: string;
}

/** Réponse de la carte : `empreinte` est celle de la portée montrée (la première carte, si la demande l'a rejointe). */
export interface ReponseAccord {
  accepte: boolean;
  empreinte: string;
}

/** La carte d'accord d'une extension analysée, pour l'activer dans `espace` (pur). */
export function carteDe(
  a: AnalyseManifeste,
  o: { cle: string; source: SourceExtension; espace: Espace; etat: EtatNavigateur; maj?: { de: string } },
): CarteExtension {
  const p = a.portee;
  return {
    cle: o.cle,
    nom: a.nom,
    source: o.source,
    version: a.version,
    droits: libellesPortee(p, o.source),
    sites: [...p.hotes],
    tousLesSites: p.tousLesSites,
    reseau: o.source === "agent" ? [...p.reseau] : null,
    // Plus large que la règle « scripts sur tous les sites » : `scripting` avec un accès à tous les sites injecte partout.
    renforce: accordRenforce(p, o.source),
    espace: o.espace.nom,
    espaceId: o.espace.id,
    autresEspaces: o.etat.espaces.filter((e) => e.profil === o.espace.profil && e.id !== o.espace.id).map((e) => e.nom),
    maj: o.maj ? { de: o.maj.de } : null,
    empreinte: empreintePortee(p),
  };
}
