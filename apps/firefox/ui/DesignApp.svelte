<script lang="ts">
  import type { OverlayApi, OverlayContext } from "../shared/api";
  import DesignBasket from "./composants/PanierDesign.svelte";

  const api = window.webaios as unknown as OverlayApi;
  let context = $state<OverlayContext | null>(null);
  let text = $state("");
  let error = $state<string | null>(null);
  let champ = $state<HTMLTextAreaElement>();
  let request = 0;

  async function reread() {
    const n = ++request;
    const c = await api.contexte().catch(() => null);
    if (n !== request) return;
    // A new bubble (another element) starts from an empty text.
    if (c?.mode !== "bulle" || context?.mode !== "bulle" || c.etiquette !== context.etiquette || c.source !== context.source) {
      text = "";
      error = null;
    }
    context = c;
  }
  void reread();
  api.surChange(() => void reread());

  $effect(() => {
    if (context?.mode === "bulle" && champ) champ.focus();
  });

  async function add() {
    const r = await api.ajouter(text);
    if (r.ok) text = "";
    else error = r.erreur;
  }

  function clavier(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void add();
    } else if (e.key === "Escape") {
      e.preventDefault();
      api.annuler();
    }
  }
</script>

{#if context?.mode === "bulle"}
  <div class="bulle" data-testid="bulle-design" role="dialog" aria-label="Remarque sur l'élément">
    <div class="tete">
      <code class="etiquette">{context.etiquette}</code>
      {#if context.source}<span class="source">{context.source}</span>{/if}
    </div>
    {#if context.avertissement}<p class="avertissement" data-testid="avertissement-bulle">{context.avertissement}</p>{/if}
    <textarea bind:this={champ} bind:value={text} onkeydown={clavier} placeholder="Ta remarque sur cet élément" maxlength="4000"></textarea>
    {#if error}<p class="erreur" role="alert">{error}</p>{/if}
    <div class="actions">
      <button class="annuler" onclick={() => api.annuler()}>Annuler</button>
      <button class="ajouter" onclick={() => void add()}>Ajouter au panier <kbd>⌘↩</kbd></button>
    </div>
  </div>
{:else if context?.mode === "message"}
  <!-- Not interactive: only a click closes it (like the next keystroke, on the main process side). -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="message" data-testid="message-design" role="status" onclick={() => api.annuler()}>{context.message}</div>
{:else if context?.mode === "panier"}
  <div class="volet">
    <DesignBasket {api} projet={context.projet} destination={context.destination} sansDestination={context.sansDestination} fermer={() => api.annuler()} />
  </div>
{/if}

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; overflow: hidden; }
  .bulle { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; gap: 6px; padding: 8px; background: var(--fond-actif); color: var(--texte); border: 1px solid var(--accent); border-radius: 8px; font-size: 12px; }
  .tete { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
  .etiquette { color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .source { color: var(--texte-doux); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea { flex: 1; resize: none; box-sizing: border-box; width: 100%; padding: 6px; border-radius: 5px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); font: inherit; outline: none; }
  textarea:focus { border-color: var(--accent); }
  .avertissement { margin: 0; color: var(--texte-doux); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .erreur { margin: 0; color: var(--en-erreur); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 5px; }
  .annuler { color: var(--texte-doux); }
  .annuler:hover { background: var(--fond-survol); color: var(--texte); }
  .ajouter { background: var(--accent); color: #fff; font-weight: 600; }
  kbd { font: inherit; opacity: 0.8; margin-left: 4px; }
  .message { box-sizing: border-box; height: 100%; display: flex; align-items: center; padding: 8px 12px; background: var(--fond-actif); color: var(--texte); border: 1px solid var(--bord); border-radius: 8px; font-size: 12px; line-height: 1.35; cursor: default; overflow: hidden; }
  .volet { height: 100%; border-radius: 8px; overflow: hidden; }
</style>
