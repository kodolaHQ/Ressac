import { z } from "zod";
import { SCROLL_MAX } from "../protocol.js";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.page",
  label: "workflows-block-source-page",
  family: "Sources",
  description: "workflows-block-source-page-desc",
  input: "perItem",
  fields: [
    { name: "url", label: "workflows-field-address", help: "workflows-help-templates", required: true, kind: "template" },
    { name: "account", label: "workflows-field-account", required: false, default: false, kind: "checkbox" },
    {
      name: "scroll",
      label: "workflows-field-scroll",
      help: "workflows-field-scroll-help",
      required: false,
      kind: "number",
      min: 0,
      max: SCROLL_MAX,
      integer: true,
    },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "field", label: "workflows-field-result-field", required: false, default: "page", kind: "text" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      url: Template,
      account: z.boolean().default(false),
      // Without a default: the hash of the params of an existing block (its memory) does not change.
      scroll: z.number().int().min(0).max(SCROLL_MAX).optional(),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("page"),
    })
    .strict(),
};
