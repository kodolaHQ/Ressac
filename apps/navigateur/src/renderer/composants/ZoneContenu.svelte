<script lang="ts">
  import { actionDeUrl, URL_APPLICATIONS, URL_EXTENSIONS, widgetDeUrlWorkflow, type EtatFenetre, type Onglet } from "../../commun/modele";
  import { ACTIONS_EN_ESPACE_PRIVE } from "../../commun/actions";
  import PageAction from "../action/PageAction.svelte";
  import Applications from "./Applications.svelte";
  import Extensions from "./Extensions.svelte";
  import Constructeur from "../constructeur/Constructeur.svelte";
  import { acces, api, demandeDe, etat } from "../etat.svelte";
  import { estDemandeAgent, modale } from "./modale.svelte";
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
  // Les questions des sites ; celles de l'agent s'ouvrent en modale (App.svelte).
  const demande = $derived(demandeDe(fenetre, onglet));
  const widgetWorkflow = $derived(onglet ? widgetDeUrlWorkflow(onglet.url) : null);
  // Page d'une action : l'ouvrir ne lance rien. Refusée quand l'espace de l'onglet (ou celui affiché) est privé ; un
  // espace introuvable compte comme privé.
  const pageAction = $derived(onglet ? actionDeUrl(onglet.url) : null);
  const actionEnPrive = $derived.by(() => {
    const espaces = etat.valeur?.espaces ?? [];
    const prive = (id: string | undefined) => espaces.find((e) => e.id === id)?.prive ?? true;
    return prive(fenetre?.espaceActif) || prive(onglet?.espaceId);
  });

  $effect(() => {
    // Un panneau de l'interface occupe la zone : la page web s'efface (une vue couvre toujours l'interface).
    // Idem pour la bulle d'accès en mode compact, où la barre latérale s'affiche par-dessus la page, et pour la
    // modale d'une demande de l'agent (une capture floutée de la page la remplace).
    const masquer = panneau !== null || (acces.bullesOuvertes > 0 && fenetre?.compact === true) || modale.masquer;
    const envoyer = () => {
      const r = zone.getBoundingClientRect();
      modale.zone = { x: r.x, y: r.y, largeur: r.width, hauteur: r.height };
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
  {#if demande && !estDemandeAgent(demande) && !panneau}<DemandePermission {demande} />{/if}
  {#if recherche.ouverte && onglet && !panneau}<RechercheDansPage {onglet} />{/if}
  <div class="surface" bind:this={zone}>
  {#if fenetre && panneau === "historique"}
    <Historique {fenetre} fermer={fermerPanneau} />
  {:else if panneau === "telechargements"}
    <Telechargements fermer={fermerPanneau} />
  {:else if fenetre && !onglet}
    <PageVide {fenetre} />
  {:else if onglet?.url === URL_APPLICATIONS}
    <Applications />
  {:else if onglet?.url === URL_EXTENSIONS}
    <Extensions />
  {:else if widgetWorkflow}
    {#key widgetWorkflow}<Constructeur id={widgetWorkflow} />{/key}
  {:else if pageAction}
    {#if actionEnPrive}
      <p class="plante" data-testid="action-espace-prive">{ACTIONS_EN_ESPACE_PRIVE}</p>
    {:else}
      {#key `${pageAction.id}/${pageAction.execution}`}<PageAction id={pageAction.id} execution={pageAction.execution} />{/key}
    {/if}
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
