import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "list.dedupe",
  label: "workflows-block-list-dedupe",
  family: "Listes",
  description: "workflows-block-list-dedupe-desc",
  input: "required",
  fields: [
    { name: "keys", label: "workflows-field-keys", help: "workflows-field-keys-help", required: true, default: ["url"], kind: "texts" },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({ keys: z.array(z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "workflows-val-key-path")).min(1).max(10) })
    .strict(),
};
