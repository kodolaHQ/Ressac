<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { siteDe, type DemandeEnAttente, type IdOnglet } from "../../commun/modele";
  import { api } from "../etat.svelte";
  import DemandeOutilsDev from "./DemandeOutilsDev.svelte";
  import { modale } from "./modale.svelte";

  /** `ongletId` : la page affichée à l'ouverture, capturée pour le fond (null : aucune, ou un panneau la cache). */
  let { demande, ongletId }: { demande: DemandeEnAttente; ongletId: IdOnglet | null } = $props();

  /** Au-delà, la page s'efface sans capture : la modale ne doit pas attendre. */
  const ATTENTE_APERCU_MS = 1000;

  let carte: HTMLElement;
  let apercu = $state<string | null>(null);
  // Zone de la page au moment de la capture : l'image y reste, même si la fenêtre change ensuite de taille.
  let zone = $state(untrack(() => modale.zone));
  let prete = $state(false);

  const outilsDev = $derived(demande.permissions.includes("outils-dev"));
  const site = $derived(siteDe(demande.origine));

  // Une seule ouverture pour toute la file : les demandes suivantes remplacent le contenu, la page reste cachée.
  onMount(() => {
    const avant = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let finie = false;
    const ouvrir = (url: string | null) => {
      if (finie) return;
      finie = true;
      apercu = url;
      zone = modale.zone;
      // La capture est prise : la vue native peut s'effacer derrière la modale.
      modale.masquer = true;
      prete = true;
    };
    carte.focus();
    const secours = setTimeout(() => ouvrir(null), ATTENTE_APERCU_MS);
    api
      .apercuPage(untrack(() => ongletId))
      .then(ouvrir, () => ouvrir(null))
      .finally(() => clearTimeout(secours));
    return () => {
      finie = true;
      clearTimeout(secours);
      modale.masquer = false;
      // Le focus revient où il était, s'il est encore dans l'interface (pas sur la page web, qui reprend le sien).
      if (avant?.isConnected && avant !== document.body) avant.focus();
    };
  });

  // Demande suivante de la file : son contenu remplace l'ancien, le focus reste dans la modale.
  $effect(() => {
    void demande.id;
    void tick().then(() => {
      if (carte && !carte.contains(document.activeElement)) carte.focus();
    });
  });

  const refuser = () => api.permissions.repondre(demande.id, "refuser");
  const focusables = () =>
    [...carte.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")].filter((e) => !e.hasAttribute("disabled"));

  function clavier(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      refuser();
    } else if (e.key === "Enter") {
      // Un bouton qui a le focus garde sa propre action ; partout ailleurs (cases comprises), Entrée autorise.
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      e.preventDefault();
      if (!e.repeat) carte.querySelector<HTMLButtonElement>("[data-principal]")?.click();
    } else if (e.key === "Tab") {
      // Le focus ne quitte pas la modale : Tab boucle sur ses commandes.
      const liste = focusables();
      if (liste.length === 0) return e.preventDefault();
      const i = liste.indexOf(document.activeElement as HTMLElement);
      const cible = e.shiftKey ? (i <= 0 ? liste.at(-1) : null) : i === -1 || i === liste.length - 1 ? liste[0] : null;
      if (cible) {
        e.preventDefault();
        cible.focus();
      }
    }
  }
</script>

<svelte:window onkeydown={clavier} />

<div class="modale" class:prete data-testid="modale-demande">
  {#if apercu && zone}
    <div class="apercu" style:left="{zone.x}px" style:top="{zone.y}px" style:width="{zone.largeur}px" style:height="{zone.hauteur}px">
      <img data-testid="modale-apercu" src={apercu} alt="" />
    </div>
  {/if}
  <div class="voile"></div>
  <div
    class="carte"
    bind:this={carte}
    tabindex="-1"
    role="alertdialog"
    aria-modal="true"
    aria-label={outilsDev ? "Demande d'accès aux outils de développement" : "Demande d'autorisation"}
  >
    {#key demande.id}
      {#if outilsDev}
        <DemandeOutilsDev {demande} />
      {:else}
        <div class="lecture" data-testid="demande-permission">
          <p>L'agent veut lire l'onglet « {demande.titre ?? site} »</p>
          <div class="actions">
            <button onclick={refuser}>Refuser</button>
            <button class="autoriser" data-principal onclick={() => api.permissions.repondre(demande.id, "autoriser")}>Autoriser une fois</button>
          </div>
        </div>
      {/if}
    {/key}
  </div>
</div>

<style>
  .modale { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; -webkit-app-region: no-drag; }
  .apercu { position: fixed; overflow: hidden; }
  .apercu img { display: block; width: 100%; height: 100%; object-fit: cover; filter: blur(8px); transform: scale(1.03); }
  .voile { position: fixed; inset: 0; background: var(--voile); }
  .carte {
    position: relative;
    width: min(440px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 14px 18px;
    background: var(--fond-actif);
    color: var(--texte);
    border: 1px solid var(--bord);
    border-radius: 12px;
    box-shadow: var(--ombre-modale);
    font-size: 13px;
    line-height: 1.45;
    outline: none;
    opacity: 0;
    transform: translateY(6px) scale(0.98);
    transition: opacity 120ms ease-out, transform 120ms ease-out;
  }
  .prete .carte { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .carte { transition: none; transform: none; }
  }
  .lecture p { margin: 0 0 12px; font-size: 14px; overflow-wrap: anywhere; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .autoriser { background: var(--accent); border-color: var(--accent); color: white; }
</style>
