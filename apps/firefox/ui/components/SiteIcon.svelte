<script lang="ts">
  import { iconUrl } from "../../shared/icon";

  let { favicon, title: title, size: size = 16 }: { favicon: string | null; title: string; size?: number } = $props();
  let error = $state(false);
  // The UI has no network: an http(s) favicon goes through webaios-icone: (shared/icon.ts).
  const source = $derived(favicon ? iconUrl(favicon) : null);
</script>

{#if source && !error}
  <img src={source} alt="" width={size} height={size} onerror={() => (error = true)} />
{:else}
  <span class="letter" style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.6}px">{(title.replace(/^https?:\/\/(www\.)?/, "")[0] ?? "?").toUpperCase()}</span>
{/if}

<style>
  img { border-radius: 4px; flex: none; }
  /* No favicon: the initial on the active aura's colours, like the tiles of the charte. */
  .letter { display: inline-grid; place-content: center; flex: none; border-radius: 28%; background: linear-gradient(135deg, var(--a1), var(--a2)); color: rgb(255 255 255 / 0.95); font-weight: 600; text-shadow: 0 1px 1px rgb(0 0 0 / 0.18); }
</style>
