<script lang="ts">
  import { AURAS, type AuraId } from "../../shared/aura";

  /**
   * A space's emoji over a soft, blurred glow of its own aura (not the active space's). The glow brightens and grows on
   * the spring when an ancestor marks it `aria-current="true"` or is hovered.
   */
  let { icon, aura }: { icon: string; aura: AuraId } = $props();
  const [a1, a2, a3] = $derived(AURAS[aura].colors);
</script>

<span class="emoji" style:--g1={a1} style:--g2={a2} style:--g3={a3}>{icon}</span>

<style>
  .emoji { position: relative; isolation: isolate; display: inline-grid; place-items: center; line-height: 1; }
  .emoji::before {
    content: "";
    position: absolute;
    inset: -4px;
    z-index: -1;
    border-radius: 50%;
    background: conic-gradient(from 210deg, var(--g1), var(--g2), var(--g3), var(--g1));
    filter: blur(5px) saturate(1.2);
    opacity: var(--glow-rest);
    transform: scale(0.8);
    transition: opacity var(--spring-d) var(--out), transform var(--spring-d) var(--spring);
    --glow-rest: 0.5;
  }
  @media (prefers-color-scheme: light) { .emoji::before { --glow-rest: 0.55; } }
  :global(:hover) > .emoji::before { opacity: 0.75; transform: scale(0.95); }
  :global([aria-current="true"]) > .emoji::before { opacity: 0.95; transform: scale(1.1); }
</style>
