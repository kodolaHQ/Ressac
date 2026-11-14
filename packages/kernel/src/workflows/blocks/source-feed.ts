import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.feed",
  label: "workflows-block-source-feed",
  family: "Sources",
  description: "workflows-block-source-feed-desc",
  input: "optional",
  fields: [
    { name: "urls", label: "workflows-field-feed-urls", required: true, kind: "texts" },
    { name: "onError", label: "workflows-field-on-error", required: false, default: "skip", kind: "choice", choices: ["skip", "fail"] },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({
      urls: z.array(z.string().min(1).max(2000)).min(1).max(20),
      onError: z.enum(["skip", "fail"]).default("skip"),
    })
    .strict(),
};
