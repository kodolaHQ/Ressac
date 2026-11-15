import type { Execution, ResumeExecution } from "@ressac/kernel";

/**
 * The widget preview's data for the chosen run: the output of its `sortie` block if it is kept in full; otherwise,
 * for the latest real run (or without a run), the widget's data — with the mention if that run did not complete (they
 * then come from an older run); otherwise the example, with the mention « données non gardées ».
 */
export function previewData(o: {
  chosen: ResumeExecution | null;
  detail: Execution | null;
  list: ResumeExecution[];
  widget: { data: unknown; example: unknown };
}): { data: unknown; mention: boolean } {
  const { chosen, detail, widget } = o;
  if (chosen && detail?.id === chosen.id) {
    const output = detail.blocks.find((b) => b.type === "output");
    if (output && output.output !== undefined && !output.outputTruncated) return { data: output.output, mention: false };
  }
  const lastTrue = o.list.find((e) => !e.attempt)?.id ?? null;
  if (!chosen || chosen.id === lastTrue) {
    const succeeded = !chosen || chosen.status === "succeeded" || chosen.status === "partial";
    if (widget.data != null) return { data: widget.data, mention: !succeeded };
    return { data: widget.example, mention: chosen !== null };
  }
  return { data: widget.example, mention: true };
}
