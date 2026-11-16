<script lang="ts" module>
  import { TRACES, type IconName } from "./icons";
  export type { IconName };
</script>

<script lang="ts">
  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each TRACES[name] as d (d)}<path {d} />{/each}
</svg>

<style>
  svg { display: block; flex-shrink: 0; }
</style>
