<script lang="ts">
  import { commande } from "./commande.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { UNLOCK_REASON_LENGTH, unlockedConsoleText } from "../../shared/extensions-messages";
  import { siteDe, type PendingRequest, type TabId } from "../../shared/modele";
  import { api } from "../etat.svelte";
  import DemandeExtension from "./DemandeExtension.svelte";
  import DemandeOutilsDev from "./DemandeOutilsDev.svelte";
  import FondFige from "./FondFige.svelte";

  /** `ongletId`: the page shown at opening, captured for the background (null: none, or a panel hides it). */
  let { demande, ongletId }: { demande: PendingRequest; ongletId: TabId | null } = $props();

  /** Enter only authorizes a card visible for at least this delay: a keystroke meant for the page is not a grant. */
  const DELAI_ENTREE_MS = 400;

  let carte: HTMLElement;
  let prete = $state(false);
  // Enter armed: the card has been visible since DELAI_ENTREE_MS (re-armed on each request from the queue).
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
  /** Extension name (manifest) and agent reason: data, shown as text and bounded. */
  const nomExtension = $derived((demande.titre ?? demande.origine).slice(0, 60));
  /** The spaces the unlock covers: names given by the user, shown as text and bounded. */
  const espacesExtension = $derived((demande.espaces ?? []).slice(0, 20).map((e) => e.slice(0, 60)));
  const raisonAgent = $derived((demande.raison ?? "").slice(0, UNLOCK_REASON_LENGTH));
  const site = $derived(siteDe(demande.origine));

  // A single opening for the whole queue: following requests replace the content, the page stays hidden.
  onMount(() => {
    const avant = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    carte.focus();
    return () => {
      clearTimeout(minuterieEntree);
      // Focus goes back where it was, if it is still in the interface (not on the web page, which takes its own back):
      // after the update, when the rest of the interface is no longer inert.
      queueMicrotask(() => {
        if (avant?.isConnected && avant !== document.body) avant.focus();
      });
    };
  });

  // Next request in the queue: its content replaces the old one, focus stays in the modal.
  $effect(() => {
    void demande.id;
    untrack(armer);
    void tick().then(() => {
      if (carte && !carte.contains(document.activeElement)) carte.focus();
    });
  });

  // The command bar opened or closed on top re-arms Enter: the keystroke that closed it is not a grant.
  $effect(() => {
    void commande.ouverte;
    untrack(armer);
  });

  const refuser = () => api.permissions.repondre(demande.id, "refuser");
  const focusables = () =>
    [...carte.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")].filter((e) => !e.hasAttribute("disabled"));

  function clavier(e: KeyboardEvent) {
    // The command bar opened on top keeps the keyboard: the hidden modal reacts to nothing, even if focus has left the
    // bar's field (neither Enter, nor Escape before the ⌃Tab panel takes over, nor Tab).
    if (commande.ouverte || e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      refuser();
    } else if (e.key === "Enter") {
      // Card not visible yet, or only for too short a time: Enter does nothing, even on a button.
      if (!armee) return e.preventDefault();
      // A focused button keeps its own action; everywhere else (checkboxes included), Enter authorizes.
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      e.preventDefault();
      if (!e.repeat) carte.querySelector<HTMLButtonElement>("[data-principal]")?.click();
    } else if (e.key === "Tab") {
      // Focus does not leave the modal: Tab loops over its controls.
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

<!-- Under the command bar, nothing in the modal can take focus (native Tab from the page body). -->
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
          <!-- Never set without a card; if it were, nothing activates without having been shown. -->
          <div class="lecture">
            <p>Demande d'extension illisible.</p>
            <div class="actions"><button data-principal onclick={refuser}>Refuser</button></div>
          </div>
        {/if}
      {:else if consoleExtension}
        <div class="lecture" data-testid="demande-console-extension">
          <p>{unlockedConsoleText(nomExtension, espacesExtension)}</p>
          {#if raisonAgent}<p class="raison">Raison donnée par {demande.agent ?? "l'agent"} : « {raisonAgent} »</p>{/if}
          <div class="actions">
            <!-- Enter refuses: showing the agent what an extension reads on unshared tabs takes a real click. -->
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
            <!-- Enter refuses: showing the agent data read with the account takes a real click. -->
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
