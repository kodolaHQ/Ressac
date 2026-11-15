<script lang="ts">
  import type { DiffComment } from "../../shared/api";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";

  /** A review comment under its lines: its text as is (Markdown not rendered), its state, its actions. */
  let { project, comment: c, onChange }: { project: string; comment: DiffComment; onChange: () => void } = $props();

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

<div class="comment" class:resolved={c.resolved} data-testid="comment">
  <div class="head">
    <span class="range">{c.start === c.end ? t("agent-comment-line", { line: String(c.start) }) : t("agent-comment-lines", { start: String(c.start), end: String(c.end) })}</span>
    {#if c.sent}<span class="state">{t("agent-comment-sent")}</span>{/if}
    {#if c.resolved}<span class="state">{t("agent-comment-resolved")}</span>{/if}
    {#if c.lineChanged}<span class="state change">{t("agent-comment-line-changed")}</span>{/if}
  </div>
  {#if edit !== null}
    <textarea bind:value={edit} rows="3" aria-label={t("agent-comment-text")}></textarea>
    <div class="actions">
      <button onclick={() => (edit = null)}>{t("agent-cancel")}</button>
      <button onclick={() => void save()} disabled={edit.trim() === ""}>{t("agent-comment-save")}</button>
    </div>
  {:else}
    <p class="text">{c.text}</p>
    <div class="actions">
      <button onclick={() => (edit = c.text)}>{t("agent-comment-edit")}</button>
      <button onclick={() => void act(() => api.review.resolve(project, c.id, !c.resolved))}>{c.resolved ? t("agent-comment-reopen") : t("agent-comment-resolve")}</button>
      <button onclick={() => void act(() => api.review.deleteComment(project, c.id))}>{t("agent-comment-delete")}</button>
    </div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .comment { margin: 4px 8px 8px 106px; padding: 10px; border: 1px solid var(--glass-edge); border-radius: 12px; background: var(--glass-hi); font-family: var(--font-ui); font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
  .comment.resolved { opacity: 0.6; }
  .head { display: flex; gap: 6px; align-items: center; color: var(--text-muted); font-size: 11px; }
  .state { padding: 0 6px; border-radius: 8px; border: 1px solid var(--border); }
  .state.change { color: var(--in-error); border-color: var(--in-error); }
  .text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  textarea { font: inherit; resize: vertical; padding: 7px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--sheet); color: var(--text); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { padding: 3px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--sheet); color: var(--text); font-size: 11px; cursor: pointer; transition: transform var(--tap); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:hover:not(:disabled) { background: var(--bg-hover); }
  .error { margin: 0; color: var(--in-error); }
</style>
