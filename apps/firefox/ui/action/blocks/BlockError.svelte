<script lang="ts">
  let { message }: { message: string } = $props();
</script>

<div class="pa-error" data-testid="block-error" role="note">{message}</div>
