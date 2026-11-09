<script lang="ts">
  let { message }: { message: string } = $props();
</script>

<div class="pa-erreur" data-testid="bloc-erreur" role="note">{message}</div>
