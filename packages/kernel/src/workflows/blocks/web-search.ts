import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

/** Only for a widget that declares `"web": true` (validateWorkflow); the search is done by the kernel. */
export const definition: BlockDefinition = {
  type: "web.search",
  label: "workflows-block-web-search",
  family: "Sources",
  description: "workflows-block-web-search-desc",
  input: "perItem",
  fields: [
    { name: "query", label: "workflows-field-search-query", help: "workflows-help-templates", required: true, default: "{title}", kind: "template" },
    { name: "count", label: "workflows-field-result-count", required: false, default: 8, kind: "number", min: 1, max: 20, integer: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "field", label: "workflows-field-results-field", required: false, default: "search", kind: "text" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      query: Template,
      count: z.number().int().min(1).max(20).default(8),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("search"),
    })
    .strict(),
};
