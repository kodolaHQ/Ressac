<script lang="ts">
  import { AURAS, type AuraId } from "../../shared/aura";

  /** A round dot filled with the aura's two main colors (its own, not the active space's). */
  let { aura, size = 12 }: { aura: AuraId; size?: number } = $props();
  const [a1, a2] = $derived(AURAS[aura].colors);
</script>

<span class="dot" aria-hidden="true" style:width="{size}px" style:height="{size}px" style:background="linear-gradient(135deg, {a1}, {a2})"></span>

<style>
  .dot { display: inline-block; flex: none; border-radius: 50%; }
</style>
