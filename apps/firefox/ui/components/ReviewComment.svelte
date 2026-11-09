<script lang="ts">
  import type { DiffComment } from "../../shared/api";
  import { PAGE_LINE_CHANGED } from "../../shared/model";
  import { api } from "../state.svelte";

  /** A review comment under its lines: its text as is (Markdown not rendered), its state, its actions. */
  let { project: project, comment: c, onChange: onChange }: { project: string; comment: DiffComment; onChange: () => void } = $props();

  let edit = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function act(f: () => Promise<void>) {
    error = null;
    try {
      await f();
      onChange();
    } catch (e) {
      error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);
    }
  }
  async function save() {
    if (edit === null) return;
    const text = edit;
    await act(() => api.review.editComment(project, c.id, text));
    if (error === null) edit = null;
  }
</script>

<div class="commentaire" class:resolu={c.resolved} data-testid="commentaire">
  <div class="tete">
    <span class="plage">{c.start === c.end ? `Ligne ${c.start}` : `Lignes ${c.start}–${c.end}`}</span>
    {#if c.sent}<span class="etat">envoyé</span>{/if}
    {#if c.resolved}<span class="etat">résolu</span>{/if}
    {#if c.lineChanged}<span class="etat change">{PAGE_LINE_CHANGED}</span>{/if}
  </div>
  {#if edit !== null}
    <textarea bind:value={edit} rows="3" aria-label="Texte du commentaire"></textarea>
    <div class="actions">
      <button onclick={() => (edit = null)}>Annuler</button>
      <button onclick={() => void save()} disabled={edit.trim() === ""}>Enregistrer</button>
    </div>
  {:else}
    <p class="texte">{c.text}</p>
    <div class="actions">
      <button onclick={() => (edit = c.text)}>Modifier</button>
      <button onclick={() => void act(() => api.review.resolve(project, c.id, !c.resolved))}>{c.resolved ? "Rouvrir" : "Résoudre"}</button>
      <button onclick={() => void act(() => api.review.deleteComment(project, c.id))}>Supprimer</button>
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
