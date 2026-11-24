<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type { ChangedFile, DiffFile as Diff, LiftChoice } from "../../shared/api";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import DiffFile from "./DiffFile.svelte";

  /**
   * The lift card (spec § 3): the files changed since the reveal and three choices, the quarantine by default (Entrée).
   * « Garder les fichiers et déverrouiller » first shows a box per file to delete it, then lifts. Touch ID runs in `api.agent.lock.lift`.
   */
  let { names, onClose }: { names: string[]; onClose: () => void } = $props();
  let card = $state<HTMLElement>();
  let safe = $state<HTMLButtonElement>();
  let files = $state<ChangedFile[] | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let keeping = $state(false);
  let removed = $state<Record<string, boolean>>({});
  /** The files opened with « Voir »: null while it loads or when it cannot be read. */
  let shown = $state<Record<string, Diff | null>>({});

  $effect(() => {
    void api.agent.lock.changed().then((r) => (r.ok ? (files = r.files) : (error = r.error)));
  });
  // The safe choice takes the keyboard once the list shows: Entrée quarantines. The click that opened the card can hand
  // the frame's focus back to the terminal a moment later (measured: 70-180 ms, later under load, so after a quick list):
  // until the user presses a key or the pointer, the safe choice takes the keyboard back.
  $effect(() => {
    if (files === null) return;
    let acted = false;
    const act = () => void (acted = true);
    const keep = (e: FocusEvent) => {
      if (!acted && !card?.contains(e.target as Node)) safe?.focus();
    };
    void tick().then(() => safe?.focus());
    document.addEventListener("pointerdown", act, true);
    document.addEventListener("keydown", act, true);
    document.addEventListener("focusin", keep);
    return () => {
      document.removeEventListener("pointerdown", act, true);
      document.removeEventListener("keydown", act, true);
      document.removeEventListener("focusin", keep);
    };
  });

  const namesText = $derived(names.length ? names.slice(0, 10).map((n) => n.slice(0, 60)).join(", ") : t("agent-lift-unnamed"));
  const kb = (size: number) => (size < 1024 ? `${size} o` : `${Math.ceil(size / 1024)} Ko`);

  async function toggle(path: string) {
    if (path in shown) {
      const { [path]: _, ...rest } = shown;
      shown = rest;
      return;
    }
    shown = { ...shown, [path]: null };
    const d = await api.agent.lock.file(path);
    if (path in shown) shown = { ...shown, [path]: d };
  }

  async function lift(choice: LiftChoice) {
    if (busy) return;
    if (choice === "keep" && !keeping) {
      keeping = true;
      return;
    }
    busy = true;
    error = null;
    const r = await api.agent.lock.lift(choice, choice === "keep" ? Object.keys(removed).filter((p) => removed[p]) : undefined);
    busy = false;
    if (r.ok) onClose();
    // null: Touch ID refused, nothing was sent; the card stays as it was.
    else if (r.error !== null) error = r.error;
  }
</script>

<!-- A fade never ends in a hidden panel (no frames): off screen, the card leaves at once. -->
<div class="lift" data-testid="lift-lock" role="group" aria-labelledby="lift-lock-title" bind:this={card} out:fade={{ duration: card?.getClientRects().length ? 150 : 0 }}>
  <h2 id="lift-lock-title">{t("agent-lift-title")}</h2>
  <p class="intro">{t("agent-lift-body", { names: namesText })}</p>
  {#if files === null && error === null}
    <p class="muted">{t("agent-lift-checking")}</p>
  {:else if files?.length === 0}
    <p class="muted" data-testid="lift-lock-none" in:fade={{ duration: 150 }}>{t("agent-lift-none")}</p>
  {:else if files}
    {#if keeping}<p class="muted" in:fade={{ duration: 150 }}>{t("agent-lift-keep-help")}</p>{/if}
    <ul class="files" in:fade={{ duration: 150 }}>
      {#each files as f (f.path)}
        <li data-testid="lift-lock-file" data-path={f.path}>
          <div class="file">
            {#if keeping}
              <label class="remove" in:fade={{ duration: 150 }}><input type="checkbox" data-testid="lift-lock-remove" bind:checked={removed[f.path]} />{t("agent-lift-remove")}</label>
            {/if}
            <!-- A new folder goes whole: its name may hold the value too. -->
            <span class="path">{f.kind === "dir" ? `${f.path}/` : f.path}</span>
            {#if f.kind === "file"}
              <span class="size">{kb(f.size)}</span>
              <button class="link" data-testid="lift-lock-see" aria-expanded={f.path in shown} onclick={() => void toggle(f.path)}>{t(f.path in shown ? "agent-lift-hide" : "agent-lift-see")}</button>
            {/if}
          </div>
          {#if f.path in shown}
            <div class="diff" transition:fade={{ duration: 150 }}>
              {#if shown[f.path]}<DiffFile diff={shown[f.path]!} />{:else}<p class="muted">{t("agent-lift-checking")}</p>{/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if error}<p class="error" role="alert" data-testid="lift-lock-error" in:fade={{ duration: 150 }}>{error}</p>{/if}
  <div class="actions">
    <button class="secondary" data-testid="lift-lock-cancel" disabled={busy} onclick={onClose}>{t("agent-cancel")}</button>
    <button class="secondary" data-testid="lift-lock-delete" disabled={busy} onclick={() => void lift("delete")}>{t("agent-lift-delete")}</button>
    <button class="secondary" data-testid="lift-lock-keep" disabled={busy} onclick={() => void lift("keep")}>{t("agent-lift-keep")}</button>
    <button data-testid="lift-lock-quarantine" disabled={busy} bind:this={safe} onclick={() => void lift("quarantine")}>{t("agent-lift-quarantine")}</button>
  </div>
</div>

<style>
  .lift { flex: 0 1 auto; min-height: 0; overflow: auto; margin: 0 6px 6px; padding: 12px 12px 14px; border-radius: 11px; background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--border); color: var(--text); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  h2 { margin: 0 0 6px; font: 600 14px/1.3 var(--font-display); letter-spacing: -0.01em; }
  .intro { margin: 0 0 10px; line-height: 1.45; }
  .muted { margin: 0 0 10px; color: var(--text-muted); line-height: 1.45; }
  .error { margin: 0 0 10px; color: var(--in-error); font-size: 12px; overflow-wrap: anywhere; }
  .files { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .file { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .path { flex: 1; min-width: 0; font: 500 12px var(--font-mono); overflow-wrap: anywhere; }
  .size { flex: none; color: var(--text-muted); font-size: 11px; }
  .remove { flex: none; display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-muted); }
  .diff { margin-top: 6px; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 14px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-ink); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap); }
  button.secondary { background: var(--sheet); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }
  button.link { flex: none; padding: 2px 6px; background: transparent; color: var(--accent); font-weight: 500; }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.6; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
