import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "list.new",
  label: "workflows-block-list-new",
  family: "Listes",
  description: "workflows-block-list-new-desc",
  input: "required",
  fields: [
    { name: "key", label: "workflows-field-key", help: "workflows-field-key-help", required: true, default: "url", kind: "text" },
    { name: "keepDays", label: "workflows-field-forget-days", help: "workflows-help-no-value", required: false, kind: "number", min: 1, max: 365, integer: true },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({
      key: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "workflows-val-key-path"),
      keepDays: z.number().int().min(1).max(365).optional(),
    })
    .strict(),
};
