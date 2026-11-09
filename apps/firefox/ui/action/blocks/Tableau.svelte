<script lang="ts">
  import PageLink from "../PageLink.svelte";
  import { sortLines } from "../sort";
  import { andOthers, sections, type Collection, type PageContext, type LienPage as Lien } from "../types";

  type Line = { valeurs: Record<string, string>; lien: Lien | null };
  let { p, ctx }: { p: Collection<Line> & { colonnes: { champ: string; libelle: string }[] }; ctx: PageContext } = $props();

  /** Click on a header: ascending sort; second click on the same one: reverse order. */
  let sorting = $state<{ champ: string; sens: "asc" | "desc" } | null>(null);
  const withLink = $derived(sections(p).some((s) => s.elements.some((l) => l.lien)));
  const sorted = $derived(
    sections(p).map((s) => {
      if (!sorting) return s;
      const lineOf = new Map(s.elements.map((l) => [l.valeurs, l]));
      return { ...s, elements: sortLines(s.elements.map((l) => l.valeurs), sorting.champ, sorting.sens).map((v) => lineOf.get(v)!) };
    }),
  );
  const cell = (l: Line, field: string) => (Object.hasOwn(l.valeurs, field) ? l.valeurs[field] : "");

  function sort(field: string) {
    sorting = sorting?.champ === field ? { champ: field, sens: sorting.sens === "asc" ? "desc" : "asc" } : { champ: field, sens: "asc" };
  }
  const ariaSort = (field: string) => (sorting?.champ !== field ? "none" : sorting.sens === "asc" ? "ascending" : "descending");
</script>

<div data-testid="bloc-tableau">
  <div class="pa-defile">
    <table class="pa-tableau">
      <thead>
        <tr>
          {#each p.colonnes as c, i (i)}
            <th scope="col" aria-sort={ariaSort(c.champ)}>
              <button type="button" onclick={() => sort(c.champ)}>{c.libelle}</button>{#if sorting?.champ === c.champ}<span class="sens" aria-hidden="true">{sorting.sens === "asc" ? "▲" : "▼"}</span>{/if}
            </th>
          {/each}
          {#if withLink}<th scope="col">Lien</th>{/if}
        </tr>
      </thead>
      {#each sorted as s, i (i)}
        <tbody>
          {#if s.valeur !== null}<tr><th scope="rowgroup" colspan={p.colonnes.length + (withLink ? 1 : 0)}>{s.valeur}</th></tr>{/if}
          {#each s.elements as l, j (j)}
            <tr>
              {#each p.colonnes as c, k (k)}<td class="pa-texte">{cell(l, c.champ)}</td>{/each}
              {#if withLink}<td>{#if l.lien}<PageLink lien={l.lien} {ctx} />{/if}</td>{/if}
            </tr>
          {/each}
        </tbody>
      {/each}
    </table>
  </div>
  {#if p.autres > 0}<p class="pa-autres">{andOthers(p.autres)}</p>{/if}
</div>
