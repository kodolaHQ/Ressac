import { definition as sourcePage } from "./source-page.js";
import { definition as sourceFeed } from "./source-feed.js";
import { definition as sourceFetch } from "./source-fetch.js";
import { definition as webSearch } from "./web-search.js";
import { definition as listNew } from "./list-new.js";
import { definition as listDedupe } from "./list-dedupe.js";
import { definition as listKeep } from "./list-keep.js";
import { definition as aiSort } from "./ai-sort.js";
import { definition as aiWrite } from "./ai-write.js";
import { definition as code } from "./code.js";
import { definition as output } from "./output.js";
import type { BlockDefinition } from "./common.js";

export type { BlockDefinition } from "./common.js";

/** The block types known to the engine, by type. The container has one run module per type. */
export const BLOCK_REGISTRY: ReadonlyMap<string, BlockDefinition> = new Map(
  [sourcePage, sourceFeed, sourceFetch, webSearch, listNew, listDedupe, listKeep, aiSort, aiWrite, code, output].map(
    (d) => [d.type, d] as const,
  ),
);
