<script lang="ts">
  import { fade } from "svelte/transition";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";

  /**
   * « Voir » on a masking card (spec § 8): the values are fetched from the host on click, for this window's own
   * conversation, and shown here only; hidden again, they are dropped. `text`: shown with each label of `labels` replaced
   * by its value (a label the host no longer knows stays a label). `seeing`: for what the card hides besides (usernames).
   */
  let {
    text = "",
    labels = [],
    see = "home-request-mask-see",
    hide = "home-request-mask-hide",
    seeing = $bindable(false),
  }: { text?: string; labels?: string[]; see?: string; hide?: string; seeing?: boolean } = $props();

  let shown = $state<string | null>(null);
  // Hidden from outside too (the card answered): the value goes at once.
  $effect(() => {
    if (!seeing) shown = null;
  });
  let asked = 0;
  async function toggle() {
    const n = ++asked;
    // Hidden: the value goes now, never kept until a fade ends (a window that draws no frames never ends it).
    if (seeing) return void ((seeing = false), (shown = null));
    seeing = true;
    if (!labels.length || !text) return;
    const values = await Promise.all(labels.map((l) => api.agent.revealLocal(l)));
    if (n !== asked || !seeing) return;
    let out = text;
    labels.forEach((l, i) => (out = out.replaceAll(l, values[i] ?? l)));
    shown = out;
  }
</script>

<button class="see" data-testid="mask-request-see" aria-expanded={seeing} onclick={toggle}>{t(seeing ? hide : see)}</button>
{#if seeing && shown !== null}
  <!-- No fade when the window draws no frames: the element would stay until a fade that never ends. -->
  <p class="value" data-testid="mask-request-value" out:fade={{ duration: document.hidden ? 0 : 150 }}>{shown}</p>
{/if}

<style>
  button.see { display: block; margin: 0 0 12px; padding: 0; border: 0; background: none; color: var(--text-muted); font: 500 12.5px var(--font-ui); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  button.see:hover { color: var(--text); }
  button.see:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .value { margin: 0 0 12px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); font: 12px/1.45 var(--font-mono); white-space: pre-line; overflow-wrap: anywhere; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
