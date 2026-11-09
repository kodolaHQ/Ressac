import type { Execution, ResumeExecution } from "@webaios/kernel";

/**
 * The widget preview's data for the chosen run: the output of its `sortie` block if it is kept in full; otherwise,
 * for the latest real run (or without a run), the widget's data — with the mention if that run did not complete (they
 * then come from an older run); otherwise the example, with the mention « données non gardées ».
 */
export function previewData(o: {
  choisie: ResumeExecution | null;
  detail: Execution | null;
  liste: ResumeExecution[];
  widget: { donnees: unknown; exemple: unknown };
}): { donnees: unknown; mention: boolean } {
  const { choisie: chosen, detail, widget } = o;
  if (chosen && detail?.id === chosen.id) {
    const output = detail.blocs.find((b) => b.type === "sortie");
    if (output && output.sortie !== undefined && !output.sortieTronquee) return { donnees: output.sortie, mention: false };
  }
  const lastTrue = o.liste.find((e) => !e.essai)?.id ?? null;
  if (!chosen || chosen.id === lastTrue) {
    const succeeded = !chosen || chosen.statut === "reussie" || chosen.statut === "partielle";
    if (widget.donnees != null) return { donnees: widget.donnees, mention: !succeeded };
    return { donnees: widget.exemple, mention: chosen !== null };
  }
  return { donnees: widget.exemple, mention: true };
}
