import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "list.keep",
  label: "workflows-block-list-keep",
  family: "Listes",
  description: "workflows-block-list-keep-desc",
  input: "required",
  fields: [
    { name: "count", label: "workflows-field-count", required: true, default: 10, kind: "number", min: 1, max: 1000, integer: true },
  ],
  perItem: "no",
  chain: false,
  params: z.object({ count: z.number().int().min(1).max(1000) }).strict(),
};
