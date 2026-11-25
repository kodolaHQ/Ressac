<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type { PassportSuggestApi, PassportSuggestContext } from "../shared/api";
  import { format } from "../shared/i18n";

  // The passport's suggestion after a typed address form is sent (chrome/passport/form-capture.ts), over the selected
  // page. Everything shown comes from the chrome; this frame only presses its answers. It never takes the focus on its
  // own: the user is in the middle of a site.
  const api = window.ressac as unknown as PassportSuggestApi;
  let ctx = $state<PassportSuggestContext | null>(null);
  let menu = $state(false);
  let root = $state<HTMLElement>();
  const t = (id: string, args?: Record<string, string>) => format(ctx?.locale ?? "fr", id, args);

  function update() {
    const c = api.context();
    if (!c || c.phase !== "offer") menu = false;
    ctx = c;
  }
  update();
  api.onChange(update);

  const busy = $derived(ctx?.phase === "busy");

  // The frame covers only the bubble: measured after each change (no ResizeObserver: an unpainted window never fires it).
  function fit() {
    void tick().then(() => {
      const f = window.frameElement as HTMLElement | null;
      if (f && root) Object.assign(f.style, { width: `${root.offsetWidth}px`, height: `${root.offsetHeight}px` });
    });
  }
  $effect(() => {
    void [ctx, menu];
    fit();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="root" bind:this={root} onkeydown={(e) => e.key === "Escape" && (e.preventDefault(), api.no())}>
  {#if ctx}
    <div class="bubble" data-testid="passport-suggest" role="dialog" aria-labelledby="passport-suggest-title" out:fade={{ duration: 150 }} onoutroend={fit}>
      <div class="head">
        <p class="title" id="passport-suggest-title">{t("chrome-passport-suggest")}</p>
        <button class="close" data-testid="passport-suggest-close" aria-label={t("chrome-passport-suggest-close")} disabled={busy} onclick={() => api.no()}>✕</button>
      </div>
      {#if ctx.phase === "done"}
        <p class="done" class:failed={ctx.failed} role="status" data-testid="passport-suggest-done">{ctx.done}</p>
      {:else}
        <ul class="values" data-testid="passport-suggest-values">
          {#each ctx.values as v, i (i)}<li>{v}</li>{/each}
        </ul>
        <label class="remember">
          <input type="checkbox" data-testid="passport-suggest-remember" checked={ctx.remember} disabled={busy} onchange={(e) => api.remember(e.currentTarget.checked)} />
          {t("chrome-passport-suggest-remember", { site: ctx.site })}
        </label>
        <div class="actions">
          <button class="quiet" data-testid="passport-suggest-mute" aria-expanded={menu} aria-controls="passport-suggest-menu" disabled={busy} onclick={() => (menu = !menu)}>{t("chrome-passport-suggest-mute")} ▾</button>
          <span class="grow"></span>
          <button class="quiet" data-testid="passport-suggest-no" disabled={busy} onclick={() => api.no()}>{t("chrome-passport-suggest-no")}</button>
          <button class="primary" data-testid="passport-suggest-add" disabled={busy} onclick={() => api.add()}>{t("chrome-passport-suggest-add")}</button>
        </div>
        {#if menu}
          <div class="menu" id="passport-suggest-menu" out:fade={{ duration: 150 }} onoutroend={fit}>
            <button class="quiet" data-testid="passport-suggest-mute-site" onclick={() => api.mute("site")}>{t("chrome-passport-suggest-mute-site")}</button>
            <button class="quiet" data-testid="passport-suggest-mute-all" onclick={() => api.mute("all")}>{t("chrome-passport-suggest-mute-all")}</button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body), :global(#app) { margin: 0; overflow: hidden; }
  .root { display: inline-block; }
  .bubble { box-sizing: border-box; width: 340px; display: grid; gap: 8px; padding: 12px 14px; border-radius: 14px; background: var(--glass-dense); color: var(--text); border: 1px solid var(--glass-edge); box-shadow: var(--float); font: 13px/1.45 var(--font-ui); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .head { display: flex; align-items: flex-start; gap: 8px; }
  .title { flex: 1; margin: 0; font-size: 13.5px; font-weight: 600; }
  .values { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; overflow-wrap: anywhere; }
  .remember { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
  .remember input { margin: 0; accent-color: var(--accent); }
  .done { margin: 0; }
  .done.failed { color: var(--in-error); }
  .actions, .menu { display: flex; align-items: center; gap: 6px; }
  .menu { justify-content: flex-start; animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .grow { flex: 1; }
  button { all: unset; cursor: pointer; padding: 5px 12px; border-radius: 9px; transition: transform var(--tap), background var(--tap); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .quiet { color: var(--text-muted); }
  .quiet:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  .close { padding: 2px 7px; color: var(--text-muted); }
  .close:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  .primary { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
</style>
