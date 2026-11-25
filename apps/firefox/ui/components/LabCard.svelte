<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { ARM_MS } from "../../chrome/window/site-banner";
  import { t } from "../i18n.svelte";

  /** Before the lab turns on: what it opens and its known limits. Escape, « Annuler » or the veil turn nothing on. */
  let { accept, close }: { accept: () => void; close: () => void } = $props();

  let card: HTMLElement;
  // « J'ai compris, activer » turns on risky features: it takes no press until the card has been shown for ARM_MS.
  let armed = $state(false);
  /** A Space pressed before the delay: its key up activates nothing, even once armed. */
  let spaceEarly = false;

  onMount(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.focus();
    const timer = setTimeout(() => (armed = true), ARM_MS);
    return () => {
      clearTimeout(timer);
      queueMicrotask(() => before?.isConnected && before.focus());
    };
  });

  function keydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === " " && !armed) {
      e.preventDefault();
      spaceEarly = true;
    } else if (e.key === "Enter" && !armed) {
      e.preventDefault();
    } else if (e.key === "Tab") {
      // Focus stays in the card: Tab loops over its two buttons.
      const list = [...card.querySelectorAll<HTMLElement>("button")];
      const i = list.indexOf(document.activeElement as HTMLElement);
      const target = e.shiftKey ? (i <= 0 ? list.at(-1) : null) : i === -1 || i === list.length - 1 ? list[0] : null;
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
  }
  function keyup(e: KeyboardEvent) {
    if (e.key !== " " || !spaceEarly) return;
    spaceEarly = false;
    e.preventDefault();
  }
</script>

<svelte:window onkeydown={keydown} onkeyup={keyup} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="veil" data-armed={armed || undefined} onclick={(e) => e.target === e.currentTarget && close()} out:fade={{ duration: 150 }}>
  <div class="card" bind:this={card} tabindex="-1" role="alertdialog" aria-modal="true" aria-labelledby="lab-card-title" data-testid="lab-card">
    <h2 id="lab-card-title">{t("lab-card-title")}</h2>
    <p>{t("lab-card-intro")}</p>
    <ul>
      <li>{t("lab-card-atelier")}</li>
      <li>{t("lab-card-code")}</li>
      <li>{t("lab-card-apps")}</li>
      <li>{t("lab-card-devtools")}</li>
    </ul>
    <p>{t("lab-card-more")}</p>
    <div class="buttons">
      <button data-testid="lab-card-cancel" onclick={close}>{t("lab-card-cancel")}</button>
      <button class="main" data-testid="lab-card-accept" onclick={() => armed && accept()}>{t("lab-card-accept")}</button>
    </div>
  </div>
</div>

<style>
  .veil { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; background: var(--veil); -webkit-app-region: no-drag; }
  /* Same delay for the pointer as for the keyboard: a click landing where the card appears turns nothing on. */
  .veil:not([data-armed]) .main { pointer-events: none; }
  .card { width: min(460px, 100%); max-height: calc(100vh - 32px); overflow-y: auto; box-sizing: border-box; padding: 18px 20px; border-radius: 16px; background: radial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--a1) 20%, transparent), transparent 60%), radial-gradient(110% 80% at 100% 0%, color-mix(in oklab, var(--a2) 14%, transparent), transparent 55%), var(--glass-dense); backdrop-filter: blur(30px) saturate(1.8); border: 1px solid var(--glass-edge); color: var(--text); box-shadow: var(--modal-shadow); font-size: 13px; line-height: 1.45; outline: none; animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  @media (prefers-reduced-motion: reduce) {
    .card { animation: none; }
  }
  h2 { margin: 0 0 10px; font: 600 17px/1.25 var(--font-display); letter-spacing: -0.01em; }
  p { margin: 0 0 12px; color: var(--text-muted); }
  ul { margin: 0 0 12px; padding-left: 18px; color: var(--text); }
  li + li { margin-top: 6px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover { background: var(--bg-active); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .main { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
