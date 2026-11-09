<script lang="ts">
  import PageLink from "../PageLink.svelte";
  import { sortLines } from "../sort";
  import { andOthers, sections, type Collection, type PageContext, type LinkRef as Lien } from "../types";

  type Line = { values: Record<string, string>; link: Lien | null };
  let { p, ctx }: { p: Collection<Line> & { columns: { field: string; label: string }[] }; ctx: PageContext } = $props();

  /** Click on a header: ascending sort; second click on the same one: reverse order. */
  let sorting = $state<{ field: string; direction: "asc" | "desc" } | null>(null);
  const withLink = $derived(sections(p).some((s) => s.items.some((l) => l.link)));
  const sorted = $derived(
    sections(p).map((s) => {
      if (!sorting) return s;
      const lineOf = new Map(s.items.map((l) => [l.values, l]));
      return { ...s, items: sortLines(s.items.map((l) => l.values), sorting.field, sorting.direction).map((v) => lineOf.get(v)!) };
    }),
  );
  const cell = (l: Line, field: string) => (Object.hasOwn(l.values, field) ? l.values[field] : "");

  function sort(field: string) {
    sorting = sorting?.field === field ? { field: field, direction: sorting.direction === "asc" ? "desc" : "asc" } : { field: field, direction: "asc" };
  }
  const ariaSort = (field: string) => (sorting?.field !== field ? "none" : sorting.direction === "asc" ? "ascending" : "descending");
</script>

<div data-testid="bloc-tableau">
  <div class="pa-defile">
    <table class="pa-tableau">
      <thead>
        <tr>
          {#each p.columns as c, i (i)}
            <th scope="col" aria-sort={ariaSort(c.field)}>
              <button type="button" onclick={() => sort(c.field)}>{c.label}</button>{#if sorting?.field === c.field}<span class="sens" aria-hidden="true">{sorting.direction === "asc" ? "▲" : "▼"}</span>{/if}
            </th>
          {/each}
          {#if withLink}<th scope="col">Lien</th>{/if}
        </tr>
      </thead>
      {#each sorted as s, i (i)}
        <tbody>
          {#if s.value !== null}<tr><th scope="rowgroup" colspan={p.columns.length + (withLink ? 1 : 0)}>{s.value}</th></tr>{/if}
          {#each s.items as l, j (j)}
            <tr>
              {#each p.columns as c, k (k)}<td class="pa-texte">{cell(l, c.field)}</td>{/each}
              {#if withLink}<td>{#if l.link}<PageLink link={l.link} {ctx} />{/if}</td>{/if}
            </tr>
          {/each}
        </tbody>
      {/each}
    </table>
  </div>
  {#if p.others > 0}<p class="pa-autres">{andOthers(p.others)}</p>{/if}
</div>
