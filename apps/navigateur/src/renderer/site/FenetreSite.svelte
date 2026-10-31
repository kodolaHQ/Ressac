<script lang="ts">
  import { onMount } from "svelte";
  import BarreSite from "./BarreSite.svelte";
  import { ENTRER_DANS_LE_SITE, type EtatFenetreSite } from "../../commun/sites";
  import type { ApiSite } from "../../commun/api";

  /** L'unique API de cette page : le process principal sait de quelle appli elle est l'interface. */
  const api = (window as unknown as { webaios: { site: ApiSite } }).webaios.site;
  let etat = $state<EtatFenetreSite | null>(null);

  onMount(() => {
    const fin = api.surEtat((e) => (etat = e));
    void api.etat().then((e) => {
      if (e && !etat) etat = e;
    });
    return fin;
  });
  $effect(() => {
    if (etat) document.title = etat.nom;
  });
</script>

{#if etat}
  <BarreSite {etat} {api} />
  <!-- Sous la barre : la vue du site (posée par le process principal) en vue « site », l'accueil sinon. -->
  {#if etat.vue === "accueil"}
    <section class="accueil" data-testid="site-zone-accueil">
      <button data-testid="site-entrer" onclick={() => api.entrer()}>{ENTRER_DANS_LE_SITE}</button>
    </section>
  {:else if etat.vue === "accord"}
    <section class="accord" data-testid="site-zone-accord"></section>
  {/if}
{/if}

<style>
  :global(html), :global(body) { margin: 0; height: 100%; background: var(--fond); color: var(--texte); font: 13px system-ui, sans-serif; overflow: hidden; }
  :global(#app) { display: flex; flex-direction: column; height: 100%; }
  section { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding: 16px; min-height: 0; }
  .accueil button { all: unset; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: white; font-weight: 600; -webkit-app-region: no-drag; }
  .accueil button:hover { filter: brightness(1.1); }
</style>
