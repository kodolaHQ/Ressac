<script lang="ts">
  import { onMount } from "svelte";

  // The builder's Agent tab: the conversation stays in the agent panel, which this tab opens
  // (never closes) and gives the keyboard to, as ⌘J does.
  onMount(() => window.parent.webaiosWindow!.openAgent());
</script>
