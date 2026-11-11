<script lang="ts">
  import type { ApiDesign, ShownElement, BatchShown } from "../../shared/api";

  /** A project's basket: its remarks, and sending to its destination. */
  let {
    api,
    project: project,
    destination,
    noDestination: withoutDestination,
    close: close,
  }: {
    api: Pick<ApiDesign, "basket" | "remove" | "send" | "batches" | "handled" | "onChange">;
    project: string;
    destination: string | null;
    noDestination: string | null;
    close?: () => void;
  } = $props();

  let elements = $state<ShownElement[]>([]);
  let error = $state<string | null>(null);
  let sending = $state(false);
  let batches = $state<BatchShown[]>([]);
  let request = 0;

  async function reread() {
    const n = ++request;
    const p = project;
    const [list, sent] = await Promise.all([api.basket(p).catch(() => []), api.batches(p).catch(() => [])]);
    if (n === request) {
      elements = list;
      batches = sent;
    }
  }

  const STATES = { pending: "en attente", read: "lu", handled: "traité" } as const;
  const hour = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  async function markProcessed(batch: string) {
    error = null;
    try {
      await api.handled(project, batch);
    } catch (e) {
      error = message(e);
    }
    void reread();
  }

  $effect(() => {
    void project;
    void reread();
    return api.onChange(() => void reread());
  });

  const n = $derived(elements.length);
  const label = $derived(`Envoyer ${n} remarque${n > 1 ? "s" : ""} à ${destination ?? "…"}`);

  async function send() {
    sending = true;
    error = null;
    try {
      const r = await api.send(project);
      if (!r.ok) error = r.error;
    } catch (e) {
      error = message(e);
    } finally {
      sending = false;
    }
    void reread();
  }

  const start = (t: string) => (t.length > 120 ? `${t.slice(0, 120)}…` : t);
</script>

<aside class="basket" data-testid="design-basket" aria-label="Panier du mode design">
  <header>
    <h2>Panier</h2>
    {#if close}<button class="close" aria-label="Fermer le panier" onclick={close}>×</button>{/if}
  </header>
  {#if n === 0}
    <p class="empty">Aucune remarque. Clique un élément de la page pour en écrire une.</p>
  {:else}
    <ul>
      {#each elements as e (e.id)}
        <li data-testid="basket-remark">
          <div class="head">
            <code class="tag">{e.label}</code>
            <button class="delete" aria-label="Supprimer" onclick={() => void api.remove(project, e.id)}>×</button>
          </div>
          <p class="text">{start(e.text)}</p>
          {#if e.source}<p class="source">{e.source}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if batches.length > 0}
    <section class="sent" aria-label="Lots envoyés">
      <h3>Envoyés</h3>
      <ul>
        {#each batches as l (l.id)}
          <li data-testid="batch-sent" data-state={l.state}>
            <div class="head">
              <span class="state">{STATES[l.state]}</span>
              <span class="when">{hour(l.created)} · {l.destination === "agent" ? "agent" : "Claude Code"} · {l.items.length}</span>
              {#if l.destination === "agent" && l.state !== "handled"}
                <button class="handled" onclick={() => void markProcessed(l.id)}>Traité</button>
              {/if}
            </div>
            {#each l.items as e (e.id)}
              <p class="sub"><code class="tag">{e.label}</code> {start(e.text)}</p>
              {#if e.handled?.note}<p class="note">{e.handled.note}</p>{/if}
            {/each}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  <footer>
    {#if destination === null && withoutDestination}<p class="reason">{withoutDestination}</p>{/if}
    {#if error}<p class="reason" role="alert">{error}</p>{/if}
    <button class="send" data-testid="send-remarks" disabled={n === 0 || destination === null || sending} onclick={send}>{label}</button>
  </footer>
</aside>

<style>
  .basket { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 12px; gap: 8px; color: var(--text); font-size: 13px; }
  header { display: flex; align-items: center; justify-content: space-between; }
  h2 { margin: 0; font: 650 18px/1.2 var(--font-display); letter-spacing: -0.02em; }
  ul { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 6px; }
  li { background: var(--sheet); border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px; box-shadow: var(--lift); animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .head { display: flex; align-items: center; gap: 6px; }
  .tag { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent); font: 11.5px var(--font-mono); }
  .text { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; }
  .source { margin: 2px 0 0; color: var(--text-muted); font-size: 11px; word-break: break-all; }
  .sent { max-height: 40%; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
  .sent ul { flex: none; overflow: visible; }
  h3 { margin: 0; font-size: 12px; color: var(--text-muted); font-weight: 600; }
  .state { font-weight: 600; font-size: 12px; }
  .when { flex: 1; color: var(--text-muted); font-size: 11px; }
  .handled { padding: 2px 8px; border-radius: 8px; background: var(--glass-hi); font-size: 12px; }
  .sub { margin: 4px 0 0; font-size: 12px; word-break: break-word; }
  .note { margin: 2px 0 0 8px; font-size: 12px; color: var(--text-muted); border-left: 2px solid var(--border); padding-left: 6px; white-space: pre-wrap; word-break: break-word; }
  .empty { color: var(--text-muted); flex: 1; margin: 0; }
  .reason { color: var(--in-progress); margin: 0 0 6px; font-size: 12px; }
  button { all: unset; cursor: pointer; }
  .close, .delete { width: 20px; height: 20px; display: grid; place-content: center; border-radius: 8px; color: var(--text-muted); }
  .close:hover, .delete:hover { background: var(--bg-hover); color: var(--text); }
  .send { display: block; box-sizing: border-box; width: 100%; text-align: center; padding: 8px 10px; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-weight: 600; transition: transform var(--tap); }
  .send:active:not(:disabled) { transform: scale(0.97); }
  .send:disabled { opacity: 0.4; cursor: default; }
</style>
