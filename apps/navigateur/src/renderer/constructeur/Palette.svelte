<script lang="ts">
  import type { CatalogueBloc, FamilleBloc } from "@webaios/noyau";
  import { GLISSER_BLOC } from "./ajout";

  /** Les blocs par famille : un clic en pose un au centre de la vue, un glisser là où on le lâche. */
  let { catalogue, aSortie, onajouter }: { catalogue: CatalogueBloc[]; aSortie: boolean; onajouter: (type: string) => void } = $props();

  let repliees = $state<Partial<Record<FamilleBloc, boolean>>>({});
  const familles = $derived.by(() => {
    const r = new Map<FamilleBloc, CatalogueBloc[]>();
    // Une seule sortie : elle n'est plus proposée tant qu'il y en a une.
    for (const c of catalogue) if (!(c.type === "sortie" && aSortie)) r.set(c.famille, [...(r.get(c.famille) ?? []), c]);
    return [...r];
  });
</script>

<nav class="palette" aria-label="Blocs">
  {#each familles as [famille, blocs] (famille)}
    <section>
      <button class="famille" aria-expanded={!repliees[famille]} onclick={() => (repliees[famille] = !repliees[famille])}>
        <span class="chevron" class:replie={repliees[famille]}>▾</span>{famille}
      </button>
      {#if !repliees[famille]}
        <ul>
          {#each blocs as c (c.type)}
            <li>
              <button
                class="bloc"
                draggable="true"
                data-testid="palette-{c.type}"
                title={c.description}
                ondragstart={(e) => {
                  e.dataTransfer?.setData(GLISSER_BLOC, c.type);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
                }}
                onclick={() => onajouter(c.type)}
              >
                {c.libelle}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</nav>

<style>
  .palette { width: 190px; flex: none; overflow-y: auto; padding: 8px; box-sizing: border-box; border-right: 1px solid var(--bord); background: var(--fond-barre); }
  section + section { margin-top: 6px; }
  .famille { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 4px; padding: 4px; cursor: pointer; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--texte-doux); }
  .chevron { display: inline-block; transition: transform 0.1s; }
  .chevron.replie { transform: rotate(-90deg); }
  ul { list-style: none; margin: 0; padding: 0; }
  .bloc { all: unset; box-sizing: border-box; width: 100%; padding: 6px 8px; border-radius: 6px; cursor: grab; font-size: 13px; color: var(--texte); }
  .bloc:hover { background: var(--fond-survol); }
</style>
