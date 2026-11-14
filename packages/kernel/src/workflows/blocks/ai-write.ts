import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "ai.write",
  label: "workflows-block-ai-write",
  family: "IA",
  description: "workflows-block-ai-write-desc",
  input: "perItem",
  fields: [
    { name: "prompt", label: "workflows-field-prompt", help: "workflows-help-templates", required: true, default: "Résume : {text}", kind: "template" },
    { name: "field", label: "workflows-field-answer-field", required: false, default: "text", kind: "text" },
    { name: "json", label: "workflows-field-json", required: false, default: false, kind: "checkbox" },
    { name: "maxText", label: "workflows-field-max-text", required: false, default: 12_000, kind: "number", min: 1, max: 200_000, integer: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      prompt: Template,
      field: z.string().min(1).max(40).default("text"),
      json: z.boolean().default(false),
      maxText: z.number().int().min(1).max(200_000).default(12_000),
      ...ParamsPerElement,
    })
    .strict(),
};
