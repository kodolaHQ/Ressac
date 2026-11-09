<script lang="ts">
  import LienPage from "../LienPage.svelte";
  import { trierLignes } from "../tri";
  import { andOthers, sections, type Collection, type PageContext, type LienPage as Lien } from "../types";

  type Ligne = { valeurs: Record<string, string>; lien: Lien | null };
  let { p, ctx }: { p: Collection<Ligne> & { colonnes: { champ: string; libelle: string }[] }; ctx: PageContext } = $props();

  /** Click on a header: ascending sort; second click on the same one: reverse order. */
  let tri = $state<{ champ: string; sens: "asc" | "desc" } | null>(null);
  const withLink = $derived(sections(p).some((s) => s.elements.some((l) => l.lien)));
  const sorted = $derived(
    sections(p).map((s) => {
      if (!tri) return s;
      const ligneDe = new Map(s.elements.map((l) => [l.valeurs, l]));
      return { ...s, elements: trierLignes(s.elements.map((l) => l.valeurs), tri.champ, tri.sens).map((v) => ligneDe.get(v)!) };
    }),
  );
  const cellule = (l: Ligne, champ: string) => (Object.hasOwn(l.valeurs, champ) ? l.valeurs[champ] : "");

  function trier(champ: string) {
    tri = tri?.champ === champ ? { champ, sens: tri.sens === "asc" ? "desc" : "asc" } : { champ, sens: "asc" };
  }
  const ariaSort = (champ: string) => (tri?.champ !== champ ? "none" : tri.sens === "asc" ? "ascending" : "descending");
</script>

<div data-testid="bloc-tableau">
  <div class="pa-defile">
    <table class="pa-tableau">
      <thead>
        <tr>
          {#each p.colonnes as c, i (i)}
            <th scope="col" aria-sort={ariaSort(c.champ)}>
              <button type="button" onclick={() => trier(c.champ)}>{c.libelle}</button>{#if tri?.champ === c.champ}<span class="sens" aria-hidden="true">{tri.sens === "asc" ? "▲" : "▼"}</span>{/if}
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
              {#each p.colonnes as c, k (k)}<td class="pa-texte">{cellule(l, c.champ)}</td>{/each}
              {#if withLink}<td>{#if l.lien}<LienPage lien={l.lien} {ctx} />{/if}</td>{/if}
            </tr>
          {/each}
        </tbody>
      {/each}
    </table>
  </div>
  {#if p.autres > 0}<p class="pa-autres">{andOthers(p.autres)}</p>{/if}
</div>
