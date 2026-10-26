<script lang="ts" module>
  /** Tracés au trait sur une grille de 24, pour que toutes les icônes aient la même taille et la même épaisseur. */
  const TRACES = {
    reculer: ["M19 12H5", "m12 19-7-7 7-7"],
    avancer: ["M5 12h14", "m12 5 7 7-7 7"],
    recharger: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
    fermer: ["M18 6 6 18", "m6 6 12 12"],
    barre: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M9 3v18"],
    plus: ["M5 12h14", "M12 5v14"],
    agent: ["M12 3l1.8 5.4a2 2 0 0 0 1.3 1.3L20.5 11.5l-5.4 1.8a2 2 0 0 0-1.3 1.3L12 20l-1.8-5.4a2 2 0 0 0-1.3-1.3L3.5 11.5l5.4-1.8a2 2 0 0 0 1.3-1.3z"],
    telecharger: ["M12 3v12", "m7 10 5 5 5-5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
  } as const;
  export type NomIcone = keyof typeof TRACES;
</script>

<script lang="ts">
  let { nom, taille = 16 }: { nom: NomIcone; taille?: number } = $props();
</script>

<svg
  width={taille}
  height={taille}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each TRACES[nom] as d (d)}<path {d} />{/each}
</svg>

<style>
  svg { display: block; flex-shrink: 0; }
</style>
