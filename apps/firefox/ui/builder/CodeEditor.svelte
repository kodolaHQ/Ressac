<script lang="ts">
  import { untrack } from "svelte";
  import { t } from "../i18n.svelte";
  import { api } from "../state.svelte";
  import { repoOf, isActionKey } from "./target";
  import { CodeFile } from "./codes.svelte";
  import { createEdit } from "./edit.svelte";

  /**
   * The `.mjs` file of a `code` block. Nothing is written on typing (the running widget would read half-written code):
   * « Enregistrer le code » or ⌘S writes it. The code never runs here, it is only text.
   */
  /** `widget`: the workflow's key (`targetKey`), a widget's or an action's. */
  let { widget, name: name }: { widget: string; name: string } = $props();
  const depot = repoOf(api.workflow);

  // svelte-ignore state_referenced_locally
  // Once saved, the code may unblock the workflow refused for lack of this file (same edit as the builder).
  const file = new CodeFile(widget, name, depot, (n) => createEdit(widget, depot).savedCode(n));

  $effect(() =>
    untrack(() => {
      void file.read();
      // The agent may be writing the file: re-read on each change of home (or of the actions).
      return (isActionKey(widget) ? api.actions.onChange : api.home.onChange)(() => void file.read());
    }),
  );

  /** ⌘S: saves the code (no menu: the page has no « Enregistrer » of its own), except when typed in the agent's terminal. */
  function key(e: KeyboardEvent): void {
    if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
    if (e.target instanceof Element && e.target.closest(".xterm")) return;
    e.preventDefault();
    void file.save();
  }
</script>

<svelte:window onkeydown={key} />

<section class="code">
  <div class="head">
    <span class="title">{t("builder-code-title")} <code>{name}</code></span>
    {#if file.unsaved}<span class="unsaved" data-testid="code-unsaved">{t("builder-code-unsaved")}</span>{/if}
    <button data-testid="save-code" disabled={!file.unsaved || file.recording || file.disk === undefined} onclick={() => file.save()}
      >{t("builder-code-save")}</button
    >
  </div>
  {#if file.changedOnDisk}
    <div class="banner" role="status" data-testid="code-change">
      <span>{t("builder-code-changed")}</span>
      <button data-testid="reload-code" onclick={() => file.reload()}>{t("builder-code-reload")}</button>
      <button data-testid="keep-code" onclick={() => file.keepMine()}>{t("builder-code-keep")}</button>
    </div>
  {/if}
  {#if file.error}<p class="error" data-testid="code-error">{file.error}</p>{/if}
  <textarea
    data-testid="code-editor"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    wrap="off"
    disabled={file.disk === undefined}
    value={file.text}
    oninput={(e) => file.enter(e.currentTarget.value)}
  ></textarea>
</section>

<style>
  .code { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .title { flex: 1; color: var(--text-muted); }
  .unsaved { color: var(--in-progress); }
  button { padding: 4px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  .banner { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: 10px; background: var(--attention-bg); font-size: 12px; }
  .banner span { flex: 1; }
  .error { margin: 0; color: var(--in-error); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  textarea {
    box-sizing: border-box; width: 100%; min-height: 220px; resize: vertical; padding: 10px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--sheet); color: var(--text); tab-size: 2;
    font-family: var(--font-mono); font-size: 12px; line-height: 1.45;
  }
</style>
