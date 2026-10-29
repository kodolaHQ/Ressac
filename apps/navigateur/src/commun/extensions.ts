import { accordRenforce, libellesPortee, type AnalyseManifeste, type SourceExtension } from "@webaios/noyau";
import type { Espace, EtatNavigateur } from "./modele";

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
  /** Les autres espaces du même profil, où elle sera active aussi. */
  autresEspaces: string[];
  /** Mise à jour : la version installée. */
  maj: { de: string } | null;
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
    autresEspaces: o.etat.espaces.filter((e) => e.profil === o.espace.profil && e.id !== o.espace.id).map((e) => e.nom),
    maj: o.maj ? { de: o.maj.de } : null,
  };
}
