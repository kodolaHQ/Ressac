import { definition as sourcePage } from "./source-page.js";
import { definition as sourceFlux } from "./source-flux.js";
import { definition as sourceRecuperer } from "./source-fetch.js";
import { definition as webChercher } from "./web-search.js";
import { definition as listeNouveaux } from "./list-new.js";
import { definition as listeDedoublonner } from "./list-dedoublonner.js";
import { definition as listeGarder } from "./list-keep.js";
import { definition as iaTrier } from "./ia-trier.js";
import { definition as iaRediger } from "./ai-write.js";
import { definition as code } from "./code.js";
import { definition as sortie } from "./sortie.js";
import type { DefinitionBloc } from "./common.js";

export type { DefinitionBloc } from "./common.js";

/** The block types known to the engine, by type. The container has one run module per type. */
export const BLOCK_REGISTRY: ReadonlyMap<string, DefinitionBloc> = new Map(
  [sourcePage, sourceFlux, sourceRecuperer, webChercher, listeNouveaux, listeDedoublonner, listeGarder, iaTrier, iaRediger, code, sortie].map(
    (d) => [d.type, d] as const,
  ),
);
