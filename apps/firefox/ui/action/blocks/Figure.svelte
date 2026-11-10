<script lang="ts">
  let { p, testid = "block-figure" }: { p: { value: string; label: string }; testid?: string } = $props();
</script>

<div class="pa-figure" data-testid={testid}>
  <span class="value">{p.value || "—"}</span>
  <span class="label">{p.label}</span>
</div>
