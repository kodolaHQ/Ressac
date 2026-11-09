import type { Execution, ResumeExecution } from "@webaios/noyau";

/**
 * Les données de l'aperçu du widget pour l'exécution choisie : la sortie de son bloc `sortie` si elle est gardée en
 * entier ; sinon, pour la dernière vraie exécution (ou sans exécution), les données du widget — avec la mention si cette
 * exécution n'a pas abouti (elles viennent alors d'une exécution plus ancienne) ; sinon l'exemple, avec la mention
 * « données non gardées ».
 */
export function donneesApercu(o: {
  choisie: ResumeExecution | null;
  detail: Execution | null;
  liste: ResumeExecution[];
  widget: { donnees: unknown; exemple: unknown };
}): { donnees: unknown; mention: boolean } {
  const { choisie, detail, widget } = o;
  if (choisie && detail?.id === choisie.id) {
    const sortie = detail.blocs.find((b) => b.type === "sortie");
    if (sortie && sortie.sortie !== undefined && !sortie.sortieTronquee) return { donnees: sortie.sortie, mention: false };
  }
  const derniereVraie = o.liste.find((e) => !e.essai)?.id ?? null;
  if (!choisie || choisie.id === derniereVraie) {
    const aboutie = !choisie || choisie.statut === "reussie" || choisie.statut === "partielle";
    if (widget.donnees != null) return { donnees: widget.donnees, mention: !aboutie };
    return { donnees: widget.exemple, mention: choisie !== null };
  }
  return { donnees: widget.exemple, mention: true };
}
