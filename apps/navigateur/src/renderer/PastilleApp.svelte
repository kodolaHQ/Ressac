<script lang="ts">
  import { acces, accesDe } from "./acces.svelte";
  import PastilleAcces from "./composants/PastilleAcces.svelte";

  /** `app:<dossier>` : l'unique id dont cette vue montre l'accès. */
  let { id }: { id: string } = $props();
  const etat = $derived(accesDe(id));
  const api = window.webaios as unknown as import("../commun/api").ApiPastille;
  // La vue grandit tant que la bulle est ouverte, et ne gêne l'appli que pendant ce temps.
  $effect(() => api.pastilleTaille(acces.bullesOuvertes > 0));
</script>

<main>{#if etat}<PastilleAcces {id} {etat} />{/if}</main>

<style>
  main { display: flex; justify-content: flex-end; align-items: flex-start; height: 100%; }
</style>
