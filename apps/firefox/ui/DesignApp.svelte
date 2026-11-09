<script lang="ts">
  import type { ApiCalque, ContexteCalque } from "../shared/api";
  import PanierDesign from "./composants/PanierDesign.svelte";

  const api = window.webaios as unknown as ApiCalque;
  let contexte = $state<ContexteCalque | null>(null);
  let texte = $state("");
  let erreur = $state<string | null>(null);
  let champ = $state<HTMLTextAreaElement>();
  let requete = 0;

  async function relire() {
    const n = ++requete;
    const c = await api.contexte().catch(() => null);
    if (n !== requete) return;
    // A new bubble (another element) starts from an empty text.
    if (c?.mode !== "bulle" || contexte?.mode !== "bulle" || c.etiquette !== contexte.etiquette || c.source !== contexte.source) {
      texte = "";
      erreur = null;
    }
    contexte = c;
  }
  void relire();
  api.surChange(() => void relire());

  $effect(() => {
    if (contexte?.mode === "bulle" && champ) champ.focus();
  });

  async function ajouter() {
    const r = await api.ajouter(texte);
    if (r.ok) texte = "";
    else erreur = r.erreur;
  }

  function clavier(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void ajouter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      api.annuler();
    }
  }
</script>

{#if contexte?.mode === "bulle"}
  <div class="bulle" data-testid="bulle-design" role="dialog" aria-label="Remarque sur l'élément">
    <div class="tete">
      <code class="etiquette">{contexte.etiquette}</code>
      {#if contexte.source}<span class="source">{contexte.source}</span>{/if}
    </div>
    {#if contexte.avertissement}<p class="avertissement" data-testid="avertissement-bulle">{contexte.avertissement}</p>{/if}
    <textarea bind:this={champ} bind:value={texte} onkeydown={clavier} placeholder="Ta remarque sur cet élément" maxlength="4000"></textarea>
    {#if erreur}<p class="erreur" role="alert">{erreur}</p>{/if}
    <div class="actions">
      <button class="annuler" onclick={() => api.annuler()}>Annuler</button>
      <button class="ajouter" onclick={() => void ajouter()}>Ajouter au panier <kbd>⌘↩</kbd></button>
    </div>
  </div>
{:else if contexte?.mode === "message"}
  <!-- Not interactive: only a click closes it (like the next keystroke, on the main process side). -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="message" data-testid="message-design" role="status" onclick={() => api.annuler()}>{contexte.message}</div>
{:else if contexte?.mode === "panier"}
  <div class="volet">
    <PanierDesign {api} projet={contexte.projet} destination={contexte.destination} sansDestination={contexte.sansDestination} fermer={() => api.annuler()} />
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
