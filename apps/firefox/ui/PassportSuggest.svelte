<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type { PassportSuggestApi, PassportSuggestContext } from "../shared/api";
  import { format } from "../shared/i18n";
  import { ARM_MS } from "../chrome/window/site-banner";

  // The passport's suggestion after a typed address form is sent (chrome/passport/form-capture.ts), over the selected
  // page. Everything shown comes from the chrome; this frame only presses its answers. It never takes the focus on its
  // own: the user is in the middle of a site.
  const api = window.ressac as unknown as PassportSuggestApi;
  let ctx = $state<PassportSuggestContext | null>(null);
  let menu = $state(false);
  let root = $state<HTMLElement>();
  // The press guard of Ressac's system UI (site-banner.ts, RequestModal): the page knows where the bubble shows and could
  // send a form as the pointer arrives, so no control takes a press until it has been shown for ARM_MS, again at each showing.
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const t = (id: string, args?: Record<string, string>) => format(ctx?.locale ?? "fr", id, args);

  function update() {
    const c = api.context();
    if (!c || c.phase !== "offer") menu = false;
    if (!c) {
      clearTimeout(armTimer);
      armed = false;
    } else if (!ctx) armTimer = setTimeout(() => (armed = true), ARM_MS);
    ctx = c;
  }
  update();
  api.onChange(update);

  const busy = $derived(ctx?.phase === "busy");
  /** A control's action, only once armed. */
  const press = (f: () => void) => () => armed && f();
  // Escape answers « Non » wherever the keyboard is in this frame (a pressed button removed in busy or done takes it away from the bubble).
  function keys(e: KeyboardEvent) {
    if (e.key !== "Escape" || !ctx) return;
    e.preventDefault();
    api.no();
  }

  // The frame covers only the bubble: measured after each change (no ResizeObserver: an unpainted window never fires it).
  function fit() {
    void tick().then(() => {
      const f = window.frameElement as HTMLElement | null;
      // Gone, it keeps its last size (hidden by the chrome): shown again, the bubble is pressable where it is drawn.
      if (f && root?.offsetWidth) Object.assign(f.style, { width: `${root.offsetWidth}px`, height: `${root.offsetHeight}px` });
    });
  }
  $effect(() => {
    void [ctx, menu];
    fit();
  });
</script>

<svelte:window onkeydown={keys} />
<div class="root" bind:this={root}>
  {#if ctx}
    <div class="bubble" data-testid="passport-suggest" data-armed={armed || undefined} role="dialog" aria-labelledby="passport-suggest-title" out:fade={{ duration: 150 }} onoutroend={fit}>
      <div class="head">
        <p class="title" id="passport-suggest-title">{t("chrome-passport-suggest")}</p>
        <button class="close" data-testid="passport-suggest-close" aria-label={t("chrome-passport-suggest-close")} disabled={busy} onclick={press(() => api.no())}>✕</button>
      </div>
      <!-- Offer and done text cross-fade in one grid cell. -->
      <div class="swap">
        {#if ctx.phase === "done"}
          <p class="done" class:failed={ctx.failed} role="status" data-testid="passport-suggest-done" in:fade={{ duration: 150 }}>{ctx.done}</p>
        {:else}
          <div class="offer" out:fade={{ duration: 150 }} onoutroend={fit}>
            <ul class="values" data-testid="passport-suggest-values">
              {#each ctx.values as v, i (i)}<li>{v}</li>{/each}
            </ul>
            <label class="remember">
              <input type="checkbox" data-testid="passport-suggest-remember" checked={ctx.remember} disabled={busy} onclick={(e) => !armed && e.preventDefault()} onchange={(e) => api.remember(e.currentTarget.checked)} />
              {t("chrome-passport-suggest-remember", { site: ctx.site })}
            </label>
            <div class="actions">
              <button class="quiet" data-testid="passport-suggest-mute" aria-expanded={menu} aria-controls="passport-suggest-menu" disabled={busy} onclick={press(() => (menu = !menu))}>{t("chrome-passport-suggest-mute")} ▾</button>
              <span class="grow"></span>
              <button class="quiet" data-testid="passport-suggest-no" disabled={busy} onclick={press(() => api.no())}>{t("chrome-passport-suggest-no")}</button>
              <button class="primary" data-testid="passport-suggest-add" disabled={busy} onclick={press(() => api.add())}>{t("chrome-passport-suggest-add")}</button>
            </div>
            {#if menu}
              <div class="menu" id="passport-suggest-menu" out:fade={{ duration: 150 }} onoutroend={fit}>
                <button class="quiet" data-testid="passport-suggest-mute-site" onclick={press(() => api.mute("site"))}>{t("chrome-passport-suggest-mute-site")}</button>
                <button class="quiet" data-testid="passport-suggest-mute-all" onclick={press(() => api.mute("all"))}>{t("chrome-passport-suggest-mute-all")}</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
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
  .swap { display: grid; }
  .swap > * { grid-area: 1 / 1; }
  .offer { display: grid; gap: 8px; }
  .bubble:not([data-armed]) :is(button, input, label) { pointer-events: none; }
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
