import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.feed",
  label: "Lire des flux RSS",
  family: "Sources",
  description: "Lit des flux RSS ou Atom et donne leurs articles.",
  input: "optional",
  fields: [
    { name: "urls", label: "Adresses des flux", required: true, kind: "texts" },
    { name: "onError", label: "En cas d'erreur", required: false, default: "skip", kind: "choice", choices: ["skip", "fail"] },
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
