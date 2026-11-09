import type { Execution, ResumeExecution } from "@webaios/noyau";

/**
 * The widget preview's data for the chosen run: the output of its `sortie` block if it is kept in full; otherwise,
 * for the latest real run (or without a run), the widget's data — with the mention if that run did not complete (they
 * then come from an older run); otherwise the example, with the mention « données non gardées ».
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
