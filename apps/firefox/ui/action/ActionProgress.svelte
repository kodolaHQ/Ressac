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
  const lines = $derived(Object.entries(current?.blocks ?? {}).map(([id, b]) => ({ id, ...b, account: b.total !== undefined ? { done: b.done ?? 0, total: b.total } : accounts[id] })));
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
  const label = (l: (typeof lines)[number]) => (l.status === "running" && l.host ? readingOf(l.host) : ((l.type && labels.get(l.type)) ?? l.id));
  const MARKS = { running: "…", succeeded: "✓", partial: "≈", failed: "✗" } as const;
</script>

<section class="progress" data-testid="action-progress" aria-live="polite">
  {#if pending && !current}
    <p class="waiting" data-testid="pending">{PENDING}</p>
  {/if}
  {#if current}
    <ol>
      {#each lines as l (l.id)}
        <li class={l.status} data-testid="block-row">
          <span class="mark" aria-hidden="true">{MARKS[l.status]}</span>
          <span class="label">{label(l)}</span>
          {#if l.account}<span class="counter" data-testid="block-counter">{l.account.done} / {l.account.total}</span>{/if}
        </li>
      {/each}
      {#if current.step === "layout"}
        <li class="running"><span class="mark" aria-hidden="true">…</span><span class="label" data-testid="layout">{PAGE_LAYOUT}</span></li>
      {/if}
    </ol>
  {/if}
  <button data-testid="stop-action" onclick={stop}>Arrêter</button>
</section>

<style>
  .progress { max-width: 960px; margin: 16px auto 0; padding: 0 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; color: var(--text); font-size: 13px; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; gap: 8px; align-items: baseline; }
  .mark { width: 1em; text-align: center; color: var(--text-muted); }
  li.running .mark { color: var(--in-progress); }
  li.failed .mark { color: var(--in-error); }
  .counter { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .waiting { margin: 0; color: var(--text-muted); }
  button { padding: 5px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: inherit; }
  button:hover { background: var(--bg-hover); }
</style>
