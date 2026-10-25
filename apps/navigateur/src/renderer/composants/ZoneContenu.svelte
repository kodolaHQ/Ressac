<script lang="ts">
  import type { EtatFenetre, Onglet } from "../../commun/modele";
  import { api, demandes } from "../etat.svelte";
  import DemandePermission from "./DemandePermission.svelte";
  import { recherche } from "./recherche.svelte";
  import RechercheDansPage from "./RechercheDansPage.svelte";
  import type { Panneau } from "../../commun/api";
  import Historique from "./Historique.svelte";
  import PageVide from "./PageVide.svelte";
  import Telechargements from "./Telechargements.svelte";

  let {
    fenetre,
    onglet,
    panneau = null,
    fermerPanneau = () => {},
  }: { fenetre: EtatFenetre | undefined; onglet: Onglet | undefined; panneau?: Panneau | null; fermerPanneau?: () => void } = $props();
  let zone: HTMLElement;
  // Une question d'une popup (sans onglet) s'affiche sur l'onglet actif.
  const demande = $derived(demandes.liste.find((d) => d.ongletId === null || d.ongletId === onglet?.id));

  $effect(() => {
    // Un panneau de l'interface occupe la zone : la page web s'efface (une vue couvre toujours l'interface).
    const masquer = panneau !== null;
    const envoyer = () => {
      const r = zone.getBoundingClientRect();
      api.bornesContenu({ x: r.x, y: r.y, largeur: masquer ? 0 : r.width, hauteur: masquer ? 0 : r.height });
    };
    envoyer();
    const obs = new ResizeObserver(envoyer);
    obs.observe(zone);
    window.addEventListener("resize", envoyer);
    return () => {
      obs.disconnect();
      window.removeEventListener("resize", envoyer);
    };
  });
</script>

<main class="contenu" data-testid="zone-contenu">
  {#if demande && !panneau}<DemandePermission {demande} />{/if}
  {#if recherche.ouverte && onglet && !panneau}<RechercheDansPage {onglet} />{/if}
  <div class="surface" bind:this={zone}>
  {#if fenetre && panneau === "historique"}
    <Historique {fenetre} fermer={fermerPanneau} />
  {:else if panneau === "telechargements"}
    <Telechargements fermer={fermerPanneau} />
  {:else if fenetre && !onglet}
    <PageVide {fenetre} />
  {:else if onglet?.erreur}
    <div class="plante">
      <p>Impossible d'ouvrir cette page.</p>
      <p class="detail">{onglet.url} — {onglet.erreur}</p>
      <button onclick={() => api.naviguer(onglet.id, onglet.url)}>Recharger</button>
    </div>
  {:else if onglet?.plante}
    <div class="plante">
      <p>Cette page a planté.</p>
      <button onclick={() => api.commande(onglet.id, "recharger")}>Recharger</button>
    </div>
  {/if}
  </div>
</main>

<style>
  .contenu { background: var(--fond); display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .surface { flex: 1; position: relative; min-height: 0; }
  .detail { color: var(--texte-doux); font-size: 12px; word-break: break-all; }
  .plante { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--texte); }
</style>
