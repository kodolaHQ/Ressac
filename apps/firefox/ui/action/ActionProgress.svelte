<script lang="ts">
  import { untrack } from "svelte";
  import type { DirectAction } from "@webaios/kernel";
  import { PENDING, readingOf, PAGE_LAYOUT } from "../../shared/actions";
  import { api } from "../state.svelte";

  /**
   * The progress of an action run, as seen by `direct()`: one line per started block (« Lecture de … » for a block that
   * reads, otherwise the catalog label of its type; the « 7 / 12 » counter of a per-item block), then
   * « Mise en page… »; queued: « En attente ».
   * `courante` null and `enAttente` false: nothing to show.
   */
  let { current: current, waiting: pending, stop: stop }: { current: DirectAction | null; waiting: boolean; stop: () => void } = $props();

  // The kernel forgets a per-item block's count when it ends: the line keeps the last one seen (« 3 / 3 »). A new
  // run remounts this component (keyed on its start), nothing gets mixed up.
  let accounts = $state<Record<string, { done: number; total: number }>>({});
  $effect(() => {
    for (const [id, b] of Object.entries(current?.blocks ?? {})) {
      if (b.total === undefined) continue;
      const c = { done: b.done ?? 0, total: b.total };
      const seen = untrack(() => accounts[id]);
      if (seen?.done !== c.done || seen?.total !== c.total) accounts[id] = c;
    }
  });
  const lignes = $derived(Object.entries(current?.blocks ?? {}).map(([id, b]) => ({ id, ...b, account: b.total !== undefined ? { done: b.done ?? 0, total: b.total } : accounts[id] })));
  /** The catalog label of each block type; the block id until it is read (or unknown type). */
  let labels = $state.raw<ReadonlyMap<string, string>>(new Map());
  $effect(() =>
    untrack(() => {
      void api.workflow
        .catalog()
        .then((c) => (labels = new Map(c.map((b) => [b.type, b.label]))))
        .catch(() => {});
    }),
  );
  const label = (l: (typeof lignes)[number]) => (l.status === "en-cours" && l.host ? readingOf(l.host) : ((l.type && labels.get(l.type)) ?? l.id));
  const MARKS = { "en-cours": "…", reussi: "✓", partiel: "≈", echoue: "✗" } as const;
</script>

<section class="avancement" data-testid="avancement-action" aria-live="polite">
  {#if pending && !current}
    <p class="attente" data-testid="en-attente">{PENDING}</p>
  {/if}
  {#if current}
    <ol>
      {#each lignes as l (l.id)}
        <li class={l.status} data-testid="ligne-bloc">
          <span class="marque" aria-hidden="true">{MARKS[l.status]}</span>
          <span class="libelle">{label(l)}</span>
          {#if l.account}<span class="compteur" data-testid="compteur-bloc">{l.account.done} / {l.account.total}</span>{/if}
        </li>
      {/each}
      {#if current.step === "mise-en-page"}
        <li class="en-cours"><span class="marque" aria-hidden="true">…</span><span class="libelle" data-testid="mise-en-page">{PAGE_LAYOUT}</span></li>
      {/if}
    </ol>
  {/if}
  <button data-testid="arreter-action" onclick={stop}>Arrêter</button>
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
