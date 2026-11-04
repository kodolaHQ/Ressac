import { accordRenforce, empreintePortee, libellesPortee, type AnalyseManifeste } from "../../../../packages/noyau/src/index.ts";
import type { CarteExtension } from "../../../navigateur/src/commun/extensions.ts";
import type { Espace } from "../../../navigateur/src/commun/modele.ts";

// Keep in sync with apps/navigateur/src/commun/extensions.ts carteDe (that module does not load in the noyau host).
/** The grant card of an agent extension, to activate it in `espace` (pure). */
export function carteDe(
  a: AnalyseManifeste,
  o: { cle: string; espace: Espace; espaces: Espace[]; maj?: { de: string }; remplaceAussi?: string[] },
): CarteExtension {
  const p = a.portee;
  return {
    cle: o.cle,
    nom: a.nom,
    source: "agent",
    version: a.version,
    droits: libellesPortee(p, "agent"),
    sites: [...p.hotes],
    tousLesSites: p.tousLesSites,
    reseau: [...p.reseau],
    renforce: accordRenforce(p, "agent"),
    espace: o.espace.nom,
    espaceId: o.espace.id,
    autresEspaces: o.espaces.filter((e) => e.profil === o.espace.profil && e.id !== o.espace.id).map((e) => e.nom),
    remplaceAussi: [...(o.remplaceAussi ?? [])],
    maj: o.maj ? { de: o.maj.de } : null,
    empreinte: empreintePortee(p),
  };
}
