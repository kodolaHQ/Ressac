<script lang="ts">
  // Electron's App.svelte, reduced to step 2: sidebar, spaces, empty page, command bar. Web pages are Firefox's <browser>, under
  // this transparent iframe; the iframe covers the whole window only when the UI shows more than its column.
  import { untrack } from "svelte";
  import BarreCommande from "../../navigateur/src/renderer/composants/BarreCommande.svelte";
  import BarreLaterale from "../../navigateur/src/renderer/composants/BarreLaterale.svelte";
  import FondFige from "../../navigateur/src/renderer/composants/FondFige.svelte";
  import Historique from "../../navigateur/src/renderer/composants/Historique.svelte";
  import MenuContextuel from "../../navigateur/src/renderer/composants/MenuContextuel.svelte";
  import ModaleDemande from "../../navigateur/src/renderer/composants/ModaleDemande.svelte";
  import ModaleEspace from "../../navigateur/src/renderer/composants/ModaleEspace.svelte";
  import PageVide from "../../navigateur/src/renderer/composants/PageVide.svelte";
  import Telechargements from "../../navigateur/src/renderer/composants/Telechargements.svelte";
  import PanneauOnglets from "../../navigateur/src/renderer/composants/PanneauOnglets.svelte";
  import { commande, fermerCommande, focusPageVide, ouvrirCommande } from "../../navigateur/src/renderer/composants/commande.svelte";
  import { estDemandeAgent } from "../../navigateur/src/renderer/composants/modale.svelte";
  import { menu } from "../../navigateur/src/renderer/composants/menu.svelte";
  import { reglagesEspace } from "../../navigateur/src/renderer/composants/reglagesEspace.svelte";
  import { api, demandeDe, etat, fenetreCourante, fermerOnglet } from "../../navigateur/src/renderer/etat.svelte";
  import { aUneVue } from "../../navigateur/src/commun/modele";
  import type { Panneau, PanneauOnglets as TabPanel } from "../../navigateur/src/commun/api";
  import InternalPage from "./InternalPage.svelte";
  import PageError from "./PageError.svelte";

  const win = window.parent.webaiosWindow!;

  const fenetre = $derived(fenetreCourante());
  const ongletActif = $derived.by(() => {
    const id = fenetre?.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });
  // A crashed or failed page shows our message instead (the window parks, as Electron detaches its view).
  const pageWeb = $derived(!!ongletActif && aUneVue(ongletActif.url) && !ongletActif.plante && !ongletActif.erreur);
  /** The history or downloads panel over the content area (⌘Y, ⇧⌘J, the sidebar's button); another tab closes it. */
  let panneau = $state<Panneau | null>(null);
  const fermerPanneau = () => {
    panneau = null;
    api.rendreFocusPage();
  };
  const basculerPanneau = (p: Panneau) => (panneau === p ? fermerPanneau() : (panneau = p));
  $effect(() => api.surPanneau(basculerPanneau));
  // The command bar targets the tab active when it opened: if another one shows, it closes.
  const idActif = $derived(ongletActif?.id);
  $effect(() => {
    void idActif;
    untrack(() => {
      commande.ouverte = null;
      panneau = null;
    });
  });
  // An agent's question covers the whole window, agent panel included. It comes before an open command bar, which closes.
  const demande = $derived(demandeDe(fenetre, ongletActif));
  const demandeAgent = $derived(demande && estDemandeAgent(demande) ? demande : undefined);
  const idDemandeAgent = $derived(demandeAgent?.id);
  $effect(() => {
    if (idDemandeAgent !== undefined) untrack(() => fermerCommande());
  });
  // Before the card mounts and takes the keyboard: the terminal or the page gets it back once the last card goes.
  const carteAgent = $derived(idDemandeAgent !== undefined);
  $effect.pre(() => {
    if (!carteAgent) return;
    const giveBack = untrack(() => win.rememberFocus());
    return () => setTimeout(giveBack);
  });
  /** The ⌃Tab panel sent by the controller (null: closed). */
  let tabPanel = $state<TabPanel | null>(null);
  // Ready: the backdrop is in place (no page capture in step 2, it is ready at once).
  let tabPanelReady = $state(false);
  $effect(() =>
    api.surPanneauOnglets((p) => {
      tabPanel = p;
      if (!p) tabPanelReady = false;
    }),
  );
  $effect(() =>
    api.surRaccourci((r) => {
      if (r === "fermerOnglet") {
        if (ongletActif) fermerOnglet(ongletActif.id);
      } else if (r === "commande") ouvrirCommande("nouveau");
      else if (r === "adresse") {
        if (ongletActif) ouvrirCommande("actif", ongletActif.url);
        else ouvrirCommande("nouveau");
      }
    }),
  );
  // Overlays cover the agent panel too; the empty page and internal pages only fill the space left of it.
  const overlay = $derived(!!demandeAgent || !!reglagesEspace.brouillon || !!menu.ouvert || !!commande.ouverte || !!tabPanel);
  $effect(() => win.setFullWindow(overlay ? "window" : !pageWeb || !!panneau));
</script>

<!-- A tab switch to the parking tab blurs the field the empty page had just focused; the controller then focuses this
     iframe again (TabSwitchDone), and the empty page takes the keyboard back. -->
<svelte:window onfocus={() => document.activeElement === document.body && focusPageVide.n++} />

<div class="fenetre" inert={!!demandeAgent || !!reglagesEspace.brouillon || !!commande.ouverte}>
  {#if fenetre}
    <BarreLaterale {fenetre} {basculerPanneau} />
  {:else}
    <aside data-testid="barre-laterale"></aside>
  {/if}
  <main class="contenu" class:opaque={!pageWeb || !!panneau} data-testid="zone-contenu">
    {#if fenetre && panneau === "historique"}
      <Historique {fenetre} fermer={fermerPanneau} />
    {:else if panneau === "telechargements"}
      <Telechargements fermer={fermerPanneau} />
    {:else if fenetre && !ongletActif}
      <PageVide {fenetre} />
    {:else if ongletActif && (ongletActif.plante || ongletActif.erreur)}
      <PageError onglet={ongletActif} />
    {:else if ongletActif && !pageWeb}
      <InternalPage />
    {/if}
  </main>
</div>
<MenuContextuel />
<!-- No page capture under the modals in step 2: the web page shows through the veil. An agent's question comes before
     the space settings, which come back with their draft. -->
{#if demandeAgent}
  <ModaleDemande demande={demandeAgent} ongletId={null} />
{:else if reglagesEspace.brouillon && fenetre}
  <ModaleEspace fenetreId={fenetre.id} ongletId={null} />
{/if}
{#if tabPanel}
  <FondFige ongletId={ongletActif?.id ?? null} surPret={() => (tabPanelReady = true)} />
  {#if tabPanelReady}<PanneauOnglets panneau={tabPanel} />{/if}
{/if}
{#if commande.ouverte && fenetre}
  <div class="couche-commande">
    <FondFige ongletId={ongletActif?.id ?? null} surPret={() => {}} />
    <BarreCommande {fenetre} {ongletActif} cede={!!tabPanel} fermerPanneau={() => (panneau = null)} />
  </div>
{/if}

<style>
  /* Transparent so the web page under the iframe shows; the sidebar and the content area paint their own. */
  :global(html, body) { background: transparent; }
  .couche-commande { position: fixed; inset: 0; z-index: 100; }
  .fenetre {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100%;
  }
  .contenu { min-width: 0; min-height: 0; }
  .opaque { background: var(--fond); }
</style>
