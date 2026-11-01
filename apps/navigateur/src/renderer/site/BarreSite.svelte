<script lang="ts">
  import Icone from "../composants/Icone.svelte";
  import { HAUTEUR_BARRE_SITE, CHERCHER_ADRESSE, lienBloque, OUVRIR_DANS_UN_ONGLET, type EtatFenetreSite } from "../../commun/sites";
  import type { ApiSite } from "../../commun/api";

  let { etat, api }: { etat: EtatFenetreSite; api: ApiSite } = $props();
  /** macOS : les boutons de la fenêtre sont dans la barre, à gauche. */
  const mac = navigator.userAgent.includes("Mac");
  const surSite = $derived(etat.vue === "site");
</script>

<!-- Le fond se glisse (déplace la fenêtre) ; chaque bouton et la mention sont cliquables (no-drag). -->
<header data-testid="barre-site" class:mac style:height="{HAUTEUR_BARRE_SITE}px">
  <nav>
    <button data-testid="site-precedent" aria-label="Reculer" disabled={!surSite || !etat.peutReculer} onclick={() => api.precedent()}><Icone nom="reculer" /></button>
    <button data-testid="site-suivant" aria-label="Avancer" disabled={!surSite || !etat.peutAvancer} onclick={() => api.suivant()}><Icone nom="avancer" /></button>
    {#if etat.aAccueil}
      <button data-testid="site-accueil" aria-label="Accueil de l'appli" aria-pressed={etat.vue === "accueil"} disabled={etat.vue === "accord"} onclick={() => api.accueil()}><Icone nom="accueil" /></button>
    {/if}
    <button data-testid="site-recharger" aria-label="Recharger" disabled={!surSite} onclick={() => api.recharger()}><Icone nom="recharger" /></button>
  </nav>
  <div class="titre">
    <span data-testid="site-nom" class="nom">{etat.nom}</span>
    <span data-testid="site-domaine" class="domaine">{etat.domaine}</span>
  </div>
  {#if etat.suivi && surSite}
    <button data-testid="site-chercher-adresse" class="chercher" onclick={() => api.chercherAdresse()}>{CHERCHER_ADRESSE}</button>
  {/if}
  {#if etat.avis}
    <div data-testid="site-avis" class="avis" role="status">
      {#if etat.avis.genre === "lien-bloque"}
        <span>{lienBloque(etat.avis.domaine)}</span>
        <button data-testid="site-ouvrir-onglet" onclick={() => api.ouvrirBloque()}>{OUVRIR_DANS_UN_ONGLET}</button>
      {:else}
        <span>{etat.avis.texte}</span>
      {/if}
    </div>
  {/if}
</header>

<style>
  header { display: flex; align-items: center; gap: 10px; padding: 0 8px; box-sizing: border-box; background: var(--fond-barre); border-bottom: 1px solid var(--bord); -webkit-app-region: drag; user-select: none; overflow: hidden; }
  header.mac { padding-left: 78px; }
  nav { display: flex; gap: 2px; flex: none; }
  nav button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--texte-doux); -webkit-app-region: no-drag; }
  nav button:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  nav button:disabled { opacity: 0.4; }
  nav button[aria-pressed="true"] { background: var(--fond-actif); color: var(--texte); }
  .titre { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nom { font-weight: 600; color: var(--texte); }
  .domaine { color: var(--texte-doux); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .chercher { all: unset; flex: none; padding: 3px 8px; border-radius: 5px; font-size: 12px; color: var(--texte-doux); white-space: nowrap; -webkit-app-region: no-drag; }
  .chercher:hover { background: var(--fond-survol); color: var(--texte); }
  .avis { display: flex; align-items: center; gap: 8px; flex: none; max-width: 60%; padding: 3px 4px 3px 10px; border-radius: 6px; background: var(--attention-fond); color: var(--texte); font-size: 12px; -webkit-app-region: no-drag; }
  .avis span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .avis button { all: unset; padding: 2px 8px; border-radius: 5px; background: var(--fond-actif); color: var(--texte); white-space: nowrap; -webkit-app-region: no-drag; }
  .avis button:hover { background: var(--fond-survol); }
</style>
