import { z } from "zod";
import { fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

// ai.sort always scores item by item: `perItem` is not a param.
const { perItem: _byElement, ...commonParams } = ParamsPerElement;

export const definition: BlockDefinition = {
  type: "ai.sort",
  label: "workflows-block-ai-sort",
  family: "IA",
  description: "workflows-block-ai-sort-desc",
  input: "required",
  fields: [
    { name: "question", label: "workflows-field-question", help: "workflows-field-question-help", required: true, defaultText: "workflows-default-question", kind: "template" },
    { name: "text", label: "workflows-field-judged-text", help: "workflows-help-templates", required: true, default: "{title}", kind: "template" },
    { name: "threshold", label: "workflows-field-threshold", required: false, default: 0.5, kind: "number", min: 0, max: 1 },
    { name: "field", label: "workflows-field-score-field", required: false, default: "score", kind: "text" },
    // ai.sort always scores item by item: the common fields do not carry the « only per item » mark.
    ...fieldsPerElementOnly().map(({ perItemOnly: _mark, ...c }) => c),
  ],
  perItem: "always",
  chain: false,
  params: z
    .object({
      question: Template,
      text: Template,
      threshold: z.number().min(0).max(1).default(0.5),
      field: z.string().min(1).max(40).default("score"),
      ...commonParams,
    })
    .strict(),
};
