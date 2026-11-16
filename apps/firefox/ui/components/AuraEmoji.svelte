<script lang="ts">
  import { AURAS, type AuraId } from "../../shared/aura";
  import Icon from "./Icon.svelte";
  import { spaceIcon } from "./spaceIcons";

  /**
   * A space's emoji over a soft wash of its own aura (not the active space's), fuller when an ancestor marks it
   * `aria-current="true"` or is hovered.
   */
  // `size` (px): a square that fills its round chip, the wash included; without it, a square around the glyph.
  let { icon, aura, size }: { icon: string; aura: AuraId; size?: number } = $props();
  const [a1, a2, a3] = $derived(AURAS[aura].colors);
  const line = $derived(spaceIcon(icon));
</script>

<span class="emoji" class:sized={size !== undefined} style:--size={size ? `${size}px` : undefined} style:--g1={a1} style:--g2={a2} style:--g3={a3}>{#if line}<Icon name={line} size={size ? Math.round(size * 0.5) : 14} />{:else}{icon}{/if}</span>

<style>
  /* A square box: the glyph's own box is not one, which made the wash oval and off-centre. */
  .emoji { position: relative; isolation: isolate; display: inline-grid; place-items: center; width: 1.25em; height: 1.25em; line-height: 1; text-align: center; }
  /* A line icon takes a deeper shade of the aura, readable in both themes. */
  .emoji :global(svg) { color: color-mix(in oklab, var(--g2) 70%, var(--text)); }
  .sized { width: var(--size); height: var(--size); font-size: calc(var(--size) * 0.54); }
  /* A soft wash of the space's aura filling its round chip (no blur spilling out): faint at rest, fuller on hover and on
     the active space. */
  .emoji::before {
    content: "";
    position: absolute;
    inset: -0.25em;
    z-index: -1;
    border-radius: 50%;
    background:
      radial-gradient(circle at 30% 25%, var(--g3), transparent 65%),
      radial-gradient(circle at 75% 80%, var(--g2), transparent 70%),
      var(--g1);
    opacity: 0.16;
    transition: opacity var(--tap);
  }
  .sized::before { inset: 0; }
  :global(:hover) > .emoji::before { opacity: 0.3; }
  :global([aria-current="true"]) > .emoji::before { opacity: 0.45; }
</style>
