<script lang="ts">
  import { tick, untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { t } from "../i18n.svelte";
  import { choosePaste, dismissBubble, focus, type Bubble } from "./terminalAgent.svelte";

  /**
   * Ressac's bubble over the agent's terminal (spec § 5.4 bis): a label's value, shown here only, or a paste held until
   * the user chooses « Coller masqué » (Entrée) or « Coller en clair ». Nothing in it is ever written to the session but
   * the chosen paste. `visible`: the panel is shown (a hidden one draws no frames, its fade would never end).
   */
  let { b: live, visible }: { b: Bubble | null; visible: boolean } = $props();
  // Leaving, the panel's bubble is already null: the last one stays drawn while it fades (reading null would throw and
  // leave it on screen, inert).
  let kept = untrack(() => live) as Bubble;
  const b = $derived((kept = live ?? kept));
  let preferred = $state<HTMLButtonElement>();
  let cancel = $state<HTMLButtonElement>();
  // A held paste takes the keyboard from the terminal: Entrée answers here and never reaches the agent. Unchecked, the
  // default is to cancel.
  $effect(() => {
    if (b.kind === "paste") void tick().then(() => (preferred ?? cancel)?.focus());
  });
  /** The keyboard goes back to the terminal after an answer. */
  function answer(masked: boolean | null) {
    if (masked === null) dismissBubble();
    else choosePaste(masked);
    focus();
  }
</script>

<!-- A revealed value leaves the DOM at once: it has no `out:` (Svelte removes a node in a transition's onfinish, a frame
     later, and a hidden panel draws none). A held paste fades. -->
{#snippet reveal(bb: Bubble & { kind: "reveal" })}
  {#if bb.value !== null}
    <p class="value" data-testid="mask-bubble-value">{bb.value}</p>
  {:else}
    <p>{t("agent-mask-bubble-unknown")}</p>
  {/if}
  <div class="actions">
    <button class="secondary" data-testid="mask-bubble-hide" onclick={() => answer(null)}>{t("agent-mask-bubble-hide")}</button>
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
{#if b.kind === "reveal"}
  <div class="bubble" data-testid="mask-bubble" role="status" onkeydown={(e) => e.key === "Escape" && (e.preventDefault(), answer(null))}>
    {@render reveal(b)}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_interactive_supports_focus -->
  <div
    class="bubble"
    data-testid="mask-bubble"
    role="alertdialog"
    out:fade|global={{ duration: visible && !document.hidden ? 150 : 0 }}
    onkeydown={(e) => e.key === "Escape" && (e.preventDefault(), answer(null))}
  >
    <p data-testid="mask-paste-text">{b.names ? t("agent-mask-paste-names", { names: b.names.slice(0, 10).join(", ") }) : t("agent-mask-paste-unchecked")}</p>
    <div class="actions">
      {#if b.masked !== null}
        <button bind:this={preferred} data-testid="mask-paste-masked" onclick={() => answer(true)}>{t("agent-mask-paste-masked")}</button>
      {/if}
      <button class="secondary" data-testid="mask-paste-clear" onclick={() => answer(false)}>{t("agent-mask-paste-clear")}</button>
      <button class="secondary" bind:this={cancel} data-testid="mask-paste-cancel" onclick={() => answer(null)}>{t("agent-mask-paste-cancel")}</button>
    </div>
  </div>
{/if}

<style>
  /* Over the terminal's bottom, never in its flow: showing it does not resize the agent's screen. */
  .bubble { position: absolute; left: 14px; right: 14px; bottom: 36px; z-index: 2; padding: 10px 12px; border-radius: 12px; background: var(--glass-hi); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); color: var(--text); font-size: 12.5px; line-height: 1.45; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  p { margin: 0 0 10px; overflow-wrap: anywhere; }
  .value { padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--sheet); font: 12px/1.45 var(--font-mono); white-space: pre-line; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  button { margin: 0; padding: 6px 14px; border-radius: 10px; border: 0; background: var(--accent); color: var(--accent-ink); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap); }
  button.secondary { background: var(--sheet); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
