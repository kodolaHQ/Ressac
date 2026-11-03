<script lang="ts">
  import { commande } from "./commande.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { LONGUEUR_RAISON_DEBLOCAGE, texteDeblocageConsole } from "../../commun/extensions-messages";
  import { siteDe, type DemandeEnAttente, type IdOnglet } from "../../commun/modele";
  import { api } from "../etat.svelte";
  import DemandeExtension from "./DemandeExtension.svelte";
  import DemandeOutilsDev from "./DemandeOutilsDev.svelte";
  import FondFige from "./FondFige.svelte";

  /** `ongletId` : la page affichée à l'ouverture, capturée pour le fond (null : aucune, ou un panneau la cache). */
  let { demande, ongletId }: { demande: DemandeEnAttente; ongletId: IdOnglet | null } = $props();

  /** Entrée n'autorise qu'une carte visible depuis ce délai : une frappe destinée à la page ne vaut pas accord. */
  const DELAI_ENTREE_MS = 400;

  let carte: HTMLElement;
  let prete = $state(false);
  // Entrée armée : la carte est visible depuis DELAI_ENTREE_MS (réarmée à chaque demande de la file).
  let armee = $state(false);
  let minuterieEntree: ReturnType<typeof setTimeout> | undefined;
  function armer() {
    clearTimeout(minuterieEntree);
    armee = false;
    if (prete) minuterieEntree = setTimeout(() => (armee = true), DELAI_ENTREE_MS);
  }

  const outilsDev = $derived(demande.permissions.includes("outils-dev"));
  const donneesWidget = $derived(demande.permissions.includes("donnees-widget"));
  const extension = $derived(demande.permissions.includes("extension"));
  const consoleExtension = $derived(demande.permissions.includes("console-extension"));
  /** Nom de l'extension (manifeste) et raison de l'agent : des données, affichées en texte et bornées. */
  const nomExtension = $derived((demande.titre ?? demande.origine).slice(0, 60));
  /** Les espaces que couvre le déblocage : des noms donnés par l'utilisateur, affichés en texte et bornés. */
  const espacesExtension = $derived((demande.espaces ?? []).slice(0, 20).map((e) => e.slice(0, 60)));
  const raisonAgent = $derived((demande.raison ?? "").slice(0, LONGUEUR_RAISON_DEBLOCAGE));
  const site = $derived(siteDe(demande.origine));

  // Une seule ouverture pour toute la file : les demandes suivantes remplacent le contenu, la page reste cachée.
  onMount(() => {
    const avant = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    carte.focus();
    return () => {
      clearTimeout(minuterieEntree);
      // Le focus revient où il était, s'il est encore dans l'interface (pas sur la page web, qui reprend le sien) :
      // après la mise à jour, quand le reste de l'interface n'est plus inerte.
      queueMicrotask(() => {
        if (avant?.isConnected && avant !== document.body) avant.focus();
      });
    };
  });

  // Demande suivante de la file : son contenu remplace l'ancien, le focus reste dans la modale.
  $effect(() => {
    void demande.id;
    untrack(armer);
    void tick().then(() => {
      if (carte && !carte.contains(document.activeElement)) carte.focus();
    });
  });

  const refuser = () => api.permissions.repondre(demande.id, "refuser");
  const focusables = () =>
    [...carte.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")].filter((e) => !e.hasAttribute("disabled"));

  function clavier(e: KeyboardEvent) {
    // La barre de commande ouverte par-dessus garde le clavier : la modale cachée ne réagit à rien, même si le focus a
    // quitté le champ de la barre (ni Entrée, ni Échap avant que le panneau ⌃Tab ne prenne la main, ni Tab).
    if (commande.ouverte || e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      refuser();
    } else if (e.key === "Enter") {
      // Carte pas encore visible, ou depuis trop peu : Entrée ne fait rien, même sur un bouton.
      if (!armee) return e.preventDefault();
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

<!-- Sous la barre de commande, rien de la modale ne peut prendre le focus (Tab natif depuis le corps de la page). -->
<div class="modale" class:prete data-testid="modale-demande" data-armee={armee || undefined} inert={!!commande.ouverte}>
  <FondFige
    {ongletId}
    surPret={() => {
      prete = true;
      armer();
    }}
  />
  <div
    class="carte"
    bind:this={carte}
    tabindex="-1"
    role="alertdialog"
    aria-modal="true"
    aria-describedby={demande.extension?.renforce ? "carte-extension-avertissement" : undefined}
    aria-label={outilsDev
      ? "Demande d'accès aux outils de développement"
      : donneesWidget
        ? demande.action !== undefined
          ? "Demande d'accès aux résultats d'une action"
          : demande.site !== undefined
            ? "Demande d'accès à une appli de site"
            : "Demande d'accès aux données d'un widget"
        : extension
          ? "Activer une extension"
          : consoleExtension
            ? "Débloquer la console d'une extension"
            : "Demande d'autorisation"}
  >
    {#key demande.id}
      {#if outilsDev}
        <DemandeOutilsDev {demande} />
      {:else if extension}
        {#if demande.extension}
          <DemandeExtension {demande} carte={demande.extension} />
        {:else}
          <!-- Jamais posée sans carte ; si c'était le cas, rien ne s'active sans avoir été montré. -->
          <div class="lecture">
            <p>Demande d'extension illisible.</p>
            <div class="actions"><button data-principal onclick={refuser}>Refuser</button></div>
          </div>
        {/if}
      {:else if consoleExtension}
        <div class="lecture" data-testid="demande-console-extension">
          <p>{texteDeblocageConsole(nomExtension, espacesExtension)}</p>
          {#if raisonAgent}<p class="raison">Raison donnée par {demande.agent ?? "l'agent"} : « {raisonAgent} »</p>{/if}
          <div class="actions">
            <!-- Entrée refuse : montrer à l'agent ce qu'une extension lit sur des onglets non partagés demande un vrai clic. -->
            <button data-principal onclick={refuser}>Refuser</button>
            <button class="autoriser" onclick={() => api.permissions.repondre(demande.id, "autoriser")}>Débloquer</button>
          </div>
        </div>
      {:else if donneesWidget}
        <div class="lecture" data-testid="demande-donnees-widget">
          {#if demande.action !== undefined}
            <p>L'agent veut voir les résultats de l'action « {demande.titre ?? demande.action} » (lus avec ton compte).</p>
          {:else if demande.site !== undefined}
            <p data-testid="demande-site">L'agent veut voir l'appli de site « {demande.titre ?? demande.site} » (connectée à ton compte) : ses pages et sa mémoire, pour cette conversation.</p>
          {:else}
            <p>L'agent veut voir les données du widget « {demande.titre ?? demande.widget} » (lues avec ton compte).</p>
          {/if}
          <div class="actions">
            <!-- Entrée refuse : montrer à l'agent des données lues avec le compte demande un vrai clic. -->
            <button data-principal onclick={refuser}>Refuser</button>
            <button class="autoriser" onclick={() => api.permissions.repondre(demande.id, "autoriser")}>Autoriser pour cette conversation</button>
          </div>
        </div>
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
  .lecture p.raison { font-size: 13px; color: var(--texte-doux, inherit); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .autoriser { background: var(--accent); border-color: var(--accent); color: white; }
</style>
