<script lang="ts">
  import type { Commentaire } from "../../shared/api";
  import { PAGE_LINE_CHANGED } from "../../shared/modele";
  import { api } from "../etat.svelte";

  /** A review comment under its lines: its text as is (Markdown not rendered), its state, its actions. */
  let { projet: project, commentaire: c, surChange }: { projet: string; commentaire: Commentaire; surChange: () => void } = $props();

  let edition = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function act(f: () => Promise<void>) {
    error = null;
    try {
      await f();
      surChange();
    } catch (e) {
      error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);
    }
  }
  async function save() {
    if (edition === null) return;
    const text = edition;
    await act(() => api.relecture.modifierCommentaire(project, c.id, text));
    if (error === null) edition = null;
  }
</script>

<div class="commentaire" class:resolu={c.resolu} data-testid="commentaire">
  <div class="tete">
    <span class="plage">{c.debut === c.fin ? `Ligne ${c.debut}` : `Lignes ${c.debut}–${c.fin}`}</span>
    {#if c.envoye}<span class="etat">envoyé</span>{/if}
    {#if c.resolu}<span class="etat">résolu</span>{/if}
    {#if c.ligneChangee}<span class="etat change">{PAGE_LINE_CHANGED}</span>{/if}
  </div>
  {#if edition !== null}
    <textarea bind:value={edition} rows="3" aria-label="Texte du commentaire"></textarea>
    <div class="actions">
      <button onclick={() => (edition = null)}>Annuler</button>
      <button onclick={() => void save()} disabled={edition.trim() === ""}>Enregistrer</button>
    </div>
  {:else}
    <p class="texte">{c.texte}</p>
    <div class="actions">
      <button onclick={() => (edition = c.texte)}>Modifier</button>
      <button onclick={() => void act(() => api.relecture.resoudre(project, c.id, !c.resolu))}>{c.resolu ? "Rouvrir" : "Résoudre"}</button>
      <button onclick={() => void act(() => api.relecture.supprimerCommentaire(project, c.id))}>Supprimer</button>
    </div>
  {/if}
  {#if error}<p class="erreur">{error}</p>{/if}
</div>

<style>
  .commentaire { margin: 4px 8px 8px 106px; padding: 8px; border: 1px solid var(--bord); border-radius: 6px; background: var(--fond-barre); font-family: system-ui, sans-serif; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
  .commentaire.resolu { opacity: 0.6; }
  .tete { display: flex; gap: 6px; align-items: center; color: var(--texte-doux); font-size: 11px; }
  .etat { padding: 0 6px; border-radius: 8px; border: 1px solid var(--bord); }
  .etat.change { color: var(--en-erreur); border-color: var(--en-erreur); }
  .texte { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  textarea { font: inherit; resize: vertical; padding: 6px; border: 1px solid var(--bord); border-radius: 4px; background: var(--fond); color: var(--texte); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  button { padding: 2px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); font-size: 11px; }
  button:hover:not(:disabled) { background: var(--fond-survol); }
  .erreur { margin: 0; color: var(--en-erreur); }
</style>
