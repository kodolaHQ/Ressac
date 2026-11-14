import { z } from "zod";
import { OUTPUT_KINDS } from "../schema.js";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "output",
  label: "workflows-block-output",
  family: "Sortie",
  description: "workflows-block-output-desc",
  input: "required",
  fields: [
    { name: "to", label: "workflows-field-destination", required: false, default: "widget", kind: "choice", choices: [...OUTPUT_KINDS] },
    { name: "live", label: "workflows-field-live", help: "workflows-field-live-help", required: false, kind: "checkbox" },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({
      to: z.enum(OUTPUT_KINDS, { error: (i) => `workflows-val-unknown-to:${String(i.input)}` }).default("widget"),
      // Optional (absent = false), never `.default(false)` (nor a default value in the catalog: unchecked, the box removes the key): the validated params of an output of today, so the
      // `start` line sent to the container, do not change.
      live: z.boolean().optional(),
    })
    .strict(),
};
