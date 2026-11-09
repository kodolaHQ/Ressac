<script lang="ts">
  import { untrack } from "svelte";
  import type { DirectAction } from "@webaios/noyau";
  import { EN_ATTENTE, lectureDe, MISE_EN_PAGE } from "../../shared/actions";
  import { api } from "../etat.svelte";

  /**
   * The progress of an action run, as seen by `direct()`: one line per started block (« Lecture de … » for a block that
   * reads, otherwise the catalog label of its type; the « 7 / 12 » counter of a per-item block), then
   * « Mise en page… »; queued: « En attente ».
   * `courante` null and `enAttente` false: nothing to show.
   */
  let { courante, enAttente, arreter }: { courante: DirectAction | null; enAttente: boolean; arreter: () => void } = $props();

  // The kernel forgets a per-item block's count when it ends: the line keeps the last one seen (« 3 / 3 »). A new
  // run remounts this component (keyed on its start), nothing gets mixed up.
  let comptes = $state<Record<string, { faits: number; total: number }>>({});
  $effect(() => {
    for (const [id, b] of Object.entries(courante?.blocs ?? {})) {
      if (b.total === undefined) continue;
      const c = { faits: b.faits ?? 0, total: b.total };
      const vu = untrack(() => comptes[id]);
      if (vu?.faits !== c.faits || vu?.total !== c.total) comptes[id] = c;
    }
  });
  const lignes = $derived(Object.entries(courante?.blocs ?? {}).map(([id, b]) => ({ id, ...b, compte: b.total !== undefined ? { faits: b.faits ?? 0, total: b.total } : comptes[id] })));
  /** The catalog label of each block type; the block id until it is read (or unknown type). */
  let libelles = $state.raw<ReadonlyMap<string, string>>(new Map());
  $effect(() =>
    untrack(() => {
      void api.workflow
        .catalogue()
        .then((c) => (libelles = new Map(c.map((b) => [b.type, b.libelle]))))
        .catch(() => {});
    }),
  );
  const libelle = (l: (typeof lignes)[number]) => (l.statut === "en-cours" && l.hote ? lectureDe(l.hote) : ((l.type && libelles.get(l.type)) ?? l.id));
  const MARQUES = { "en-cours": "…", reussi: "✓", partiel: "≈", echoue: "✗" } as const;
</script>

<section class="avancement" data-testid="avancement-action" aria-live="polite">
  {#if enAttente && !courante}
    <p class="attente" data-testid="en-attente">{EN_ATTENTE}</p>
  {/if}
  {#if courante}
    <ol>
      {#each lignes as l (l.id)}
        <li class={l.statut} data-testid="ligne-bloc">
          <span class="marque" aria-hidden="true">{MARQUES[l.statut]}</span>
          <span class="libelle">{libelle(l)}</span>
          {#if l.compte}<span class="compteur" data-testid="compteur-bloc">{l.compte.faits} / {l.compte.total}</span>{/if}
        </li>
      {/each}
      {#if courante.etape === "mise-en-page"}
        <li class="en-cours"><span class="marque" aria-hidden="true">…</span><span class="libelle" data-testid="mise-en-page">{MISE_EN_PAGE}</span></li>
      {/if}
    </ol>
  {/if}
  <button data-testid="arreter-action" onclick={arreter}>Arrêter</button>
</section>

<style>
  .avancement { max-width: 960px; margin: 16px auto 0; padding: 0 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; color: var(--texte); font-size: 13px; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; gap: 8px; align-items: baseline; }
  .marque { width: 1em; text-align: center; color: var(--texte-doux); }
  li.en-cours .marque { color: var(--en-cours); }
  li.echoue .marque { color: var(--en-erreur); }
  .compteur { color: var(--texte-doux); font-variant-numeric: tabular-nums; }
  .attente { margin: 0; color: var(--texte-doux); }
  button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font: inherit; }
  button:hover { background: var(--fond-survol); }
</style>
