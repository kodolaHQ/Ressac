<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * One setting of Réglages: its name on the left, its control on the right with one help line under it.
   * `id` ties the name to the control (`<label for>`) and names the help (`{id}-help`, for `aria-describedby`);
   * without it, the name gets `labelId` (a radio group's `aria-labelledby`). Styles come from Settings.svelte.
   */
  let { label, help, id, labelId, testid, children, below }: { label: string; help?: string; id?: string; labelId?: string; testid?: string; children?: Snippet; below?: Snippet } = $props();
</script>

<div class="setting" data-testid={testid}>
  {#if id}<label class="name" for={id}>{label}</label>{:else}<span class="name" id={labelId}>{label}</span>{/if}
  <div class="control">
    {#if children}<div class="line">{@render children()}</div>{/if}
    {#if help}<span class="help" id={id ? `${id}-help` : undefined}>{help}</span>{/if}
    {@render below?.()}
  </div>
</div>
