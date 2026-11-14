import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.fetch",
  label: "workflows-block-source-fetch",
  family: "Sources",
  description: "workflows-block-source-fetch-desc",
  input: "perItem",
  fields: [
    { name: "url", label: "workflows-field-address", help: "workflows-help-templates", required: true, kind: "template" },
    { name: "format", label: "workflows-field-format", required: false, default: "text", kind: "choice", choices: ["text", "json"] },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "field", label: "workflows-field-result-field", required: false, default: "content", kind: "text" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      url: Template,
      format: z.enum(["text", "json"]).default("text"),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("content"),
    })
    .strict(),
};
