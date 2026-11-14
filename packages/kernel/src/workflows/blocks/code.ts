import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "code",
  label: "workflows-block-code",
  family: "Logique/Code",
  description: "workflows-block-code-desc",
  input: "optional",
  fields: [
    { name: "source", label: "workflows-field-file", help: "workflows-field-file-help", required: true, default: "code.mjs", kind: "text" },
    { name: "call", label: "workflows-field-call", required: false, default: "input", kind: "choice", choices: ["input", "harvest"] },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({
      // A file name from the widget's folder, nothing else: no path, no « .. ».
      source: z.string().regex(/^[a-z0-9-]+\.mjs$/, "workflows-val-mjs-file"),
      call: z.enum(["input", "harvest"]).default("input"),
    })
    .strict(),
};
