<script lang="ts">
  // Electron's App.svelte, reduced to step 2: sidebar, spaces, empty page, command bar. Web pages are Firefox's <browser>, under
  // this transparent iframe; the iframe covers the whole window only when the UI shows more than its column.
  import { tick, untrack } from "svelte";
  import PageAction from "../../navigateur/src/renderer/action/PageAction.svelte";
  import Actions from "../../navigateur/src/renderer/composants/Actions.svelte";
  import Applications from "../../navigateur/src/renderer/composants/Applications.svelte";
  import BarreCommande from "../../navigateur/src/renderer/composants/BarreCommande.svelte";
  import BarreLaterale from "../../navigateur/src/renderer/composants/BarreLaterale.svelte";
  import Extensions from "../../navigateur/src/renderer/composants/Extensions.svelte";
  import FondFige from "../../navigateur/src/renderer/composants/FondFige.svelte";
  import Historique from "../../navigateur/src/renderer/composants/Historique.svelte";
  import MenuContextuel from "../../navigateur/src/renderer/composants/MenuContextuel.svelte";
  import ModaleDemande from "../../navigateur/src/renderer/composants/ModaleDemande.svelte";
  import ModaleEspace from "../../navigateur/src/renderer/composants/ModaleEspace.svelte";
  import PageVide from "../../navigateur/src/renderer/composants/PageVide.svelte";
  import Telechargements from "../../navigateur/src/renderer/composants/Telechargements.svelte";
  import PanneauOnglets from "../../navigateur/src/renderer/composants/PanneauOnglets.svelte";
  import Relecture from "../../navigateur/src/renderer/composants/Relecture.svelte";
  import { focusAgent } from "../../navigateur/src/renderer/composants/agent.svelte";
  import { design, relireDesign } from "../../navigateur/src/renderer/composants/design.svelte";
  import { commande, fermerCommande, focusPageVide, ouvrirCommande } from "../../navigateur/src/renderer/composants/commande.svelte";
  import { estDemandeAgent } from "../../navigateur/src/renderer/composants/modale.svelte";
  import { menu } from "../../navigateur/src/renderer/composants/menu.svelte";
  import { reglagesEspace } from "../../navigateur/src/renderer/composants/reglagesEspace.svelte";
  import { acces, api, demandeDe, etat, fenetreCourante, fermerOnglet } from "../../navigateur/src/renderer/etat.svelte";
  import { actionDeUrl, aUneVue, cibleDeUrlWorkflow, projetDeUrlRelecture, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS } from "../../navigateur/src/commun/modele";
  import { ACTIONS_EN_ESPACE_PRIVE } from "../../navigateur/src/commun/actions";
  import { masquer, REVELATION_INITIALE, surZone, type ZoneGauche } from "../../navigateur/src/commun/revelation";
  import type { Panneau, PanneauOnglets as TabPanel } from "../../navigateur/src/commun/api";
  import type { ApiFirefox } from "./api";
  import InternalPage from "./InternalPage.svelte";
  import PageError from "./PageError.svelte";
  import WorkflowBuilder from "./WorkflowBuilder.svelte";

  const MASQUAGE_MS = 300;

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
  /** A widget's or an action's workflow builder is the active tab. */
  const cibleConstructeur = $derived(ongletActif ? cibleDeUrlWorkflow(ongletActif.url) : null);
  // Electron's ZoneContenu: an action's page launches nothing when opened. Refused when the tab's space (or the one shown)
  // is private; a space not found counts as private.
  const pageAction = $derived(ongletActif ? actionDeUrl(ongletActif.url) : null);
  const projetRelecture = $derived(ongletActif ? projetDeUrlRelecture(ongletActif.url) : null);
  const actionEnPrive = $derived.by(() => {
    const espaces = etat.valeur?.espaces ?? [];
    const prive = (id: string | undefined) => espaces.find((e) => e.id === id)?.prive ?? true;
    return prive(fenetre?.espaceActif) || prive(ongletActif?.espaceId);
  });
  /**
   * ⌘J or ✦ on a builder tab (Electron's agentDuConstructeur): its Agent tab. A UI panel over it closes first; the
   * request waits for the builder to mount again, so that it sees it.
   */
  function agentDuConstructeur(): void {
    if (panneau === null) return void focusAgent.n++;
    panneau = null;
    void tick().then(() => focusAgent.n++);
  }
  $effect(() => api.surPanneau(basculerPanneau));
  // ZoneContenu's design mode: it follows the tab shown and its address (the chrome stops the mode if it changes).
  $effect(() => {
    void ongletActif?.id;
    void ongletActif?.url;
    void relireDesign();
  });
  /** The cart column: while the design mode is on, or asked by « Panier ». */
  const panierDesign = $derived.by(() => {
    const e = design.etat;
    return e?.projet && panneau === null && (e.actif || design.panierDemande) ? e : null;
  });
  const firefox = api as unknown as ApiFirefox;
  // The column is a chrome frame beside the page: opened again on another project, so that it shows that one's cart.
  $effect(() => {
    void panierDesign?.projet?.projet;
    firefox.designVolet(!!panierDesign);
  });
  $effect(() =>
    firefox.surVoletFerme(() => {
      design.panierDemande = false;
      if (design.etat?.actif) api.design.basculer();
    }),
  );
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
      } else if (r === "agent" && cibleConstructeur) agentDuConstructeur();
    }),
  );
  // Overlays cover the agent panel too; the empty page and internal pages only fill the space left of it.
  const overlay = $derived(!!demandeAgent || !!reglagesEspace.brouillon || !!menu.ouvert || !!commande.ouverte || !!tabPanel);
  $effect(() => win.setFullWindow(overlay ? "window" : !pageWeb || !!panneau));

  // Compact mode, as Electron's App: touching the left edge reveals the sidebar. Unlike Electron it floats over the page, which
  // keeps its size: resizing a page on every frame of the slide would not be smooth.
  // The controller reports the mouse everywhere in the window; the decision is in revelation.ts.
  const compact = $derived(fenetre?.compact ?? false);
  let revelee = $state(false);
  let armee = REVELATION_INITIALE.armee;
  let zone: ZoneGauche = "loin";
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const barreVisible = $derived(!compact || revelee);

  function surZoneSouris(z: ZoneGauche) {
    zone = z;
    if (!compact) return;
    const r = surZone({ revelee, armee }, z);
    armee = r.armee;
    revelee = r.revelee;
    if (r.masquer) planifierMasquage();
    else clearTimeout(minuterie);
  }
  function planifierMasquage() {
    clearTimeout(minuterie);
    // The access bubble is mounted outside the sidebar: while it is open, the sidebar stays.
    if (!revelee || acces.bullesOuvertes > 0) return;
    minuterie = setTimeout(() => {
      if (zone !== "loin" || acces.bullesOuvertes > 0) return;
      const r = masquer(zone);
      revelee = r.revelee;
      armee = r.armee;
    }, MASQUAGE_MS);
  }
  // Once the bubble closes, hiding resumes if the mouse is already away from the sidebar.
  $effect(() => {
    if (acces.bullesOuvertes === 0) untrack(() => zone === "loin" && planifierMasquage());
  });
  $effect(() => api.surZoneGauche(surZoneSouris));
  $effect(() => win.setSidebarColumn(!compact));
  $effect(() => win.setSidebarVisible(barreVisible));
  $effect(() => {
    if (!compact) {
      clearTimeout(minuterie);
      revelee = false;
    }
  });
</script>

<!-- A tab switch to the parking tab blurs the field the empty page had just focused; the controller then focuses this
     iframe again (TabSwitchDone), and the empty page takes the keyboard back. -->
<svelte:window onfocus={() => document.activeElement === document.body && focusPageVide.n++} />

<div class="fenetre" inert={!!demandeAgent || !!reglagesEspace.brouillon || !!commande.ouverte} class:compact class:couverte={overlay}>
  <div class="colonne" class:repliee={!barreVisible} inert={!barreVisible}>
    {#if fenetre}
      <!-- ✦ on a builder tab: the controller opens the panel and sends "agent", handled above. -->
      <BarreLaterale {fenetre} {basculerPanneau} agentDuConstructeur={() => win.openAgent()} />
    {:else}
      <aside data-testid="barre-laterale"></aside>
    {/if}
  </div>
  <main class="contenu" class:opaque={!pageWeb || !!panneau} data-testid="zone-contenu">
    {#if fenetre && panneau === "historique"}
      <Historique {fenetre} fermer={fermerPanneau} />
    {:else if panneau === "telechargements"}
      <Telechargements fermer={fermerPanneau} />
    {:else if fenetre && !ongletActif}
      <PageVide {fenetre} />
    {:else if ongletActif && (ongletActif.plante || ongletActif.erreur)}
      <PageError onglet={ongletActif} />
    {:else if ongletActif?.url === URL_EXTENSIONS}
      <Extensions />
    {:else if ongletActif?.url === URL_APPLICATIONS}
      <Applications />
    {:else if ongletActif?.url === URL_ACTIONS}
      {#if actionEnPrive}
        <p class="plante" data-testid="action-espace-prive">{ACTIONS_EN_ESPACE_PRIVE}</p>
      {:else}
        <Actions />
      {/if}
    {:else if cibleConstructeur}
      {#if cibleConstructeur.type === "action" && actionEnPrive}
        <p class="plante" data-testid="action-espace-prive">{ACTIONS_EN_ESPACE_PRIVE}</p>
      {:else}
        {#key `${cibleConstructeur.type}:${cibleConstructeur.id}`}<WorkflowBuilder cible={cibleConstructeur} />{/key}
      {/if}
    {:else if pageAction}
      {#if actionEnPrive}
        <p class="plante" data-testid="action-espace-prive">{ACTIONS_EN_ESPACE_PRIVE}</p>
      {:else}
        {#key `${pageAction.id}/${pageAction.execution}`}<PageAction id={pageAction.id} execution={pageAction.execution} />{/key}
      {/if}
    {:else if projetRelecture}
      {#key `${ongletActif?.id}:${projetRelecture}`}<Relecture projet={projetRelecture} ongletId={ongletActif?.id ?? ""} />{/key}
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
  /* Firefox's -webkit-app-region: the same areas. An overlay over the sidebar keeps its clicks. */
  .fenetre:not(.couverte) :global(.barre) { -moz-window-dragging: drag; }
  .fenetre :global(.barre :is(.navigation button, .ligne, .defilant, footer)) { -moz-window-dragging: no-drag; }
  /* The Actions page's confirmation covers the window, its drag areas too (Electron's no-drag on its veil). */
  .fenetre :global(:is([data-testid="voile-suppression-action"], [data-testid="confirmation-suppression-action"])) { -moz-window-dragging: no-drag; }
  .couche-commande { position: fixed; inset: 0; z-index: 100; }
  .fenetre {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100%;
  }
  .fenetre.compact { grid-template-columns: 1fr; }
  .colonne { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; }
  .compact .colonne {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 10;
    width: 240px;
    border-right: 1px solid var(--bord);
    transition: transform 200ms ease;
  }
  .compact .repliee { transform: translateX(-100%); visibility: hidden; transition: transform 200ms ease, visibility 0s 200ms; }
  @media (prefers-reduced-motion: reduce) {
    .compact .colonne { transition: none; }
  }
  /* Electron's .surface: the action page fills it (position: absolute), not the window. */
  .contenu { position: relative; min-width: 0; min-height: 0; }
  .opaque { background: var(--fond); }
  /* Electron's ZoneContenu. */
  .plante { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--texte); }
</style>
