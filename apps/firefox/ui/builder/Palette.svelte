<script lang="ts">
  import type { BlockCatalogEntry, BlockFamily } from "@webaios/kernel";
  import { DRAG_BLOCK } from "./add";

  /**
   * Blocks by family: a click drops one at the center of the view, a drag where it is released. `web`: the widget (or
   * the action, `action`) declares `"web": true`; without it, « Chercher sur le web » is greyed out (the validator would refuse it).
   */
  let {
    catalog: catalog,
    hasOutput: hasOutput,
    web,
    action = false,
    onadd: onadd,
  }: { catalog: BlockCatalogEntry[]; hasOutput: boolean; web: boolean; action?: boolean; onadd: (type: string) => void } = $props();

  const NO_WEB = $derived(
    action
      ? 'L\'action doit déclarer "web": true dans ses sources (action.json) : demande-le à l\'agent.'
      : 'Le widget doit déclarer "web": true : demande-le à l\'agent.',
  );
  const grayed = (type: string) => type === "web.chercher" && !web;

  let collapsed = $state<Partial<Record<BlockFamily, boolean>>>({});
  const families = $derived.by(() => {
    const r = new Map<BlockFamily, BlockCatalogEntry[]>();
    // A single output: it is no longer offered while there is one.
    for (const c of catalog) if (!(c.type === "sortie" && hasOutput)) r.set(c.family, [...(r.get(c.family) ?? []), c]);
    return [...r];
  });
</script>

<nav class="palette" aria-label="Blocs">
  {#each families as [family, blocks] (family)}
    <section>
      <button class="famille" aria-expanded={!collapsed[family]} onclick={() => (collapsed[family] = !collapsed[family])}>
        <span class="chevron" class:replie={collapsed[family]}>▾</span>{family}
      </button>
      {#if !collapsed[family]}
        <ul>
          {#each blocks as c (c.type)}
            <li>
              <button
                class="bloc"
                draggable={!grayed(c.type)}
                disabled={grayed(c.type)}
                data-testid="palette-{c.type}"
                title={grayed(c.type) ? NO_WEB : c.description}
                ondragstart={(e) => {
                  if (grayed(c.type)) return void e.preventDefault();
                  e.dataTransfer?.setData(DRAG_BLOCK, c.type);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
                }}
                onclick={() => onadd(c.type)}
              >
                {c.label}
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
  .bloc:hover:not(:disabled) { background: var(--fond-survol); }
  .bloc:disabled { cursor: default; opacity: 0.45; }
</style>
