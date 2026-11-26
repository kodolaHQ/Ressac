import { z } from "zod";
import { Template, ParamsPerElement, type BlockDefinition } from "./common.js";

// ai.sort scores the whole list in one call: no per-item mode. The old per-item keys (onError, budgetSeconds, reuse,
// keepDays) are still accepted, so existing workflow.json files keep validating; they are ignored.
const { perItem: _byElement, ...oldPerItemParams } = ParamsPerElement;

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
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({
      question: Template,
      text: Template,
      threshold: z.number().min(0).max(1).default(0.5),
      field: z.string().min(1).max(40).default("score"),
      ...oldPerItemParams,
    })
    .strict(),
};
