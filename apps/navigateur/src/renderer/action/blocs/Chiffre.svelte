<script lang="ts">
  let { p, testid = "bloc-chiffre" }: { p: { valeur: string; libelle: string }; testid?: string } = $props();
</script>

<div class="pa-chiffre" data-testid={testid}>
  <span class="valeur">{p.valeur || "—"}</span>
  <span class="libelle">{p.libelle}</span>
</div>
