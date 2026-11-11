<script lang="ts">
  import { AURAS, type AuraId } from "../../shared/aura";

  /**
   * A space's emoji over a soft wash of its own aura (not the active space's), fuller when an ancestor marks it
   * `aria-current="true"` or is hovered.
   */
  let { icon, aura }: { icon: string; aura: AuraId } = $props();
  const [a1, a2, a3] = $derived(AURAS[aura].colors);
</script>

<span class="emoji" style:--g1={a1} style:--g2={a2} style:--g3={a3}>{icon}</span>

<style>
  .emoji { position: relative; isolation: isolate; display: inline-grid; place-items: center; line-height: 1; }
  /* A soft wash of the space's aura filling its round chip (no blur spilling out): faint at rest, fuller on hover and on
     the active space. */
  .emoji::before {
    content: "";
    position: absolute;
    inset: -6px;
    z-index: -1;
    border-radius: 50%;
    background:
      radial-gradient(circle at 30% 25%, var(--g3), transparent 65%),
      radial-gradient(circle at 75% 80%, var(--g2), transparent 70%),
      var(--g1);
    opacity: 0.16;
    transition: opacity var(--tap);
  }
  :global(:hover) > .emoji::before { opacity: 0.3; }
  :global([aria-current="true"]) > .emoji::before { opacity: 0.45; }
</style>
