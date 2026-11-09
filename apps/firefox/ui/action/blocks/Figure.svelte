<script lang="ts">
  let { p, testid = "bloc-chiffre" }: { p: { value: string; label: string }; testid?: string } = $props();
</script>

<div class="pa-chiffre" data-testid={testid}>
  <span class="valeur">{p.value || "—"}</span>
  <span class="libelle">{p.label}</span>
</div>
