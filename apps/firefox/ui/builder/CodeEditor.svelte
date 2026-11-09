<script lang="ts">
  import { untrack } from "svelte";
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
  <div class="tete">
    <span class="titre">Code <code>{name}</code></span>
    {#if file.unsaved}<span class="non-enregistre" data-testid="code-non-enregistre">Code non enregistré</span>{/if}
    <button data-testid="enregistrer-code" disabled={!file.unsaved || file.recording || file.disk === undefined} onclick={() => file.save()}
      >Enregistrer le code</button
    >
  </div>
  {#if file.changedOnDisk}
    <div class="bandeau" role="status" data-testid="code-change">
      <span>Le fichier a changé sur le disque</span>
      <button data-testid="recharger-code" onclick={() => file.reload()}>Recharger</button>
      <button data-testid="garder-code" onclick={() => file.keepMine()}>Garder le mien</button>
    </div>
  {/if}
  {#if file.error}<p class="erreur" data-testid="erreur-code">{file.error}</p>{/if}
  <textarea
    data-testid="editeur-code"
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
  .tete { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .titre { flex: 1; color: var(--texte-doux); }
  .non-enregistre { color: var(--en-cours); }
  button { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  button:disabled { opacity: 0.5; }
  .bandeau { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; background: var(--fond-actif); font-size: 12px; }
  .bandeau span { flex: 1; }
  .erreur { margin: 0; color: var(--en-erreur); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  textarea {
    box-sizing: border-box; width: 100%; min-height: 220px; resize: vertical; padding: 8px; border-radius: 6px;
    border: 1px solid var(--bord); background: var(--fond); color: var(--texte); tab-size: 2;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.45;
  }
</style>
