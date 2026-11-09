import { definition as sourcePage } from "./source-page.js";
import { definition as sourceFlux } from "./source-flux.js";
import { definition as sourceRecuperer } from "./source-recuperer.js";
import { definition as webChercher } from "./web-chercher.js";
import { definition as listeNouveaux } from "./liste-nouveaux.js";
import { definition as listeDedoublonner } from "./liste-dedoublonner.js";
import { definition as listeGarder } from "./liste-garder.js";
import { definition as iaTrier } from "./ia-trier.js";
import { definition as iaRediger } from "./ia-rediger.js";
import { definition as code } from "./code.js";
import { definition as sortie } from "./sortie.js";
import type { DefinitionBloc } from "./communs.js";

export type { DefinitionBloc } from "./communs.js";

/** The block types known to the engine, by type. The container has one run module per type. */
export const REGISTRE_BLOCS: ReadonlyMap<string, DefinitionBloc> = new Map(
  [sourcePage, sourceFlux, sourceRecuperer, webChercher, listeNouveaux, listeDedoublonner, listeGarder, iaTrier, iaRediger, code, sortie].map(
    (d) => [d.type, d] as const,
  ),
);
