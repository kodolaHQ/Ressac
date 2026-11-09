import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.flux",
  label: "Lire des flux RSS",
  family: "Sources",
  description: "Lit des flux RSS ou Atom et donne leurs articles.",
  input: "facultative",
  fields: [
    { name: "urls", label: "Adresses des flux", required: true, kind: "textes" },
    { name: "siErreur", label: "En cas d'erreur", required: false, default: "sauter", kind: "choix", choices: ["sauter", "echouer"] },
  ],
  perItem: "non",
  chain: false,
  params: z
    .object({
      urls: z.array(z.string().min(1).max(2000)).min(1).max(20),
      onError: z.enum(["sauter", "echouer"]).default("sauter"),
    })
    .strict(),
};
