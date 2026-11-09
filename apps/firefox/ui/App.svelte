<script lang="ts">
  // The window's UI: sidebar, spaces, empty page, command bar. Web pages are Firefox's <browser>, under
  // this transparent iframe; the iframe covers the whole window only when the UI shows more than its column.
  import { tick, untrack } from "svelte";
  import PageAction from "../ui/action/PageAction.svelte";
  import Actions from "../ui/composants/Actions.svelte";
  import Applications from "../ui/composants/Applications.svelte";
  import CommandBar from "../ui/composants/BarreCommande.svelte";
  import Sidebar from "../ui/composants/BarreLaterale.svelte";
  import Extensions from "../ui/composants/Extensions.svelte";
  import FrozenBackground from "../ui/composants/FondFige.svelte";
  import History from "../ui/composants/Historique.svelte";
  import ContextMenu from "../ui/composants/MenuContextuel.svelte";
  import RequestModal from "../ui/composants/ModaleDemande.svelte";
  import SpaceModal from "../ui/composants/ModaleEspace.svelte";
  import EmptyPage from "../ui/composants/PageVide.svelte";
  import Downloads from "../ui/composants/Telechargements.svelte";
  import TabsPanel from "../ui/composants/PanneauOnglets.svelte";
  import Review from "../ui/composants/Relecture.svelte";
  import { focusAgent } from "../ui/composants/agent.svelte";
  import { design, rereadDesign } from "../ui/composants/design.svelte";
  import { command, closeCommand, focusEmptyPage, openCommand } from "../ui/composants/commande.svelte";
  import { isAgentRequest } from "../ui/composants/modale.svelte";
  import { menu } from "../ui/composants/menu.svelte";
  import { spaceSettings } from "../ui/composants/reglagesEspace.svelte";
  import { access, api, requestOf, appState, currentWindow, closeTab } from "../ui/etat.svelte";
  import { actionDeUrl, hasView, workflowUrlTarget, reviewUrlProject, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS } from "../shared/modele";
  import { ACTIONS_IN_PRIVATE_SPACE } from "../shared/actions";
  import { masquer, INITIAL_REVEAL, surZone, type ZoneGauche } from "../shared/revelation";
  import type { Panel, TabsPanel as TabPanel } from "../shared/api";
  import type { ApiFirefox } from "./api";
  import InternalPage from "./InternalPage.svelte";
  import PageError from "./PageError.svelte";
  import WorkflowBuilder from "./WorkflowBuilder.svelte";

  const HIDING_MS = 300;

  const win = window.parent.webaiosWindow!;

  const winState = $derived(currentWindow());
  const activeTab = $derived.by(() => {
    const id = winState?.actif[winState.espaceActif];
    return id ? appState.valeur?.onglets[id] : undefined;
  });
  // A crashed or failed page shows our message instead (the window parks its <browser>).
  const pageWeb = $derived(!!activeTab && hasView(activeTab.url) && !activeTab.plante && !activeTab.erreur);
  /** The history or downloads panel over the content area (⌘Y, ⇧⌘J, the sidebar's button); another tab closes it. */
  let panel = $state<Panel | null>(null);
  const closePanel = () => {
    panel = null;
    api.rendreFocusPage();
  };
  const togglePanel = (p: Panel) => (panel === p ? closePanel() : (panel = p));
  /** A widget's or an action's workflow builder is the active tab. */
  const builderTarget = $derived(activeTab ? workflowUrlTarget(activeTab.url) : null);
  // An action's page launches nothing when opened. Refused when the tab's space (or the one shown)
  // is private; a space not found counts as private.
  const pageAction = $derived(activeTab ? actionDeUrl(activeTab.url) : null);
  const reviewProject = $derived(activeTab ? reviewUrlProject(activeTab.url) : null);
  const privateAction = $derived.by(() => {
    const spaces = appState.valeur?.espaces ?? [];
    const isPrivate = (id: string | undefined) => spaces.find((e) => e.id === id)?.prive ?? true;
    return isPrivate(winState?.espaceActif) || isPrivate(activeTab?.espaceId);
  });
  /**
   * ⌘J or ✦ on a builder tab: its Agent tab. A UI panel over it closes first; the
   * request waits for the builder to mount again, so that it sees it.
   */
  function builderAgent(): void {
    if (panel === null) return void focusAgent.n++;
    panel = null;
    void tick().then(() => focusAgent.n++);
  }
  $effect(() => api.surPanneau(togglePanel));
  // ZoneContenu's design mode: it follows the tab shown and its address (the chrome stops the mode if it changes).
  $effect(() => {
    void activeTab?.id;
    void activeTab?.url;
    void rereadDesign();
  });
  /** The cart column: while the design mode is on, or asked by « Panier ». */
  const designBasket = $derived.by(() => {
    const e = design.etat;
    return e?.projet && panel === null && (e.actif || design.panierDemande) ? e : null;
  });
  const firefox = api as unknown as ApiFirefox;
  // The column is a chrome frame beside the page: opened again on another project, so that it shows that one's cart.
  // A string, not the state object (new at each read): the column opens once per project, never at each read.
  const drawerProject = $derived(designBasket?.projet?.projet ?? null);
  $effect(() => firefox.designVolet(drawerProject !== null));
  $effect(() =>
    firefox.surVoletFerme(() => {
      design.panierDemande = false;
      if (design.etat?.actif) api.design.basculer();
    }),
  );
  // The command bar targets the tab active when it opened: if another one shows, it closes.
  const activeId = $derived(activeTab?.id);
  $effect(() => {
    void activeId;
    untrack(() => {
      command.ouverte = null;
      panel = null;
    });
  });
  // An agent's question covers the whole window, agent panel included. It comes before an open command bar, which closes.
  const request = $derived(requestOf(winState, activeTab));
  const agentRequest = $derived(request && isAgentRequest(request) ? request : undefined);
  const agentRequestId = $derived(agentRequest?.id);
  $effect(() => {
    if (agentRequestId !== undefined) untrack(() => closeCommand());
  });
  // Before the card mounts and takes the keyboard: the terminal or the page gets it back once the last card goes.
  const carteAgent = $derived(agentRequestId !== undefined);
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
        if (activeTab) closeTab(activeTab.id);
      } else if (r === "commande") openCommand("nouveau");
      else if (r === "adresse") {
        if (activeTab) openCommand("actif", activeTab.url);
        else openCommand("nouveau");
      } else if (r === "agent" && builderTarget) builderAgent();
    }),
  );
  // Overlays cover the agent panel too; the empty page and internal pages only fill the space left of it.
  const overlay = $derived(!!agentRequest || !!spaceSettings.brouillon || !!menu.ouvert || !!command.ouverte || !!tabPanel);
  $effect(() => win.setFullWindow(overlay ? "window" : !pageWeb || !!panel));

  // Compact mode: touching the left edge reveals the sidebar. It floats over the page, which
  // keeps its size: resizing a page on every frame of the slide would not be smooth.
  // The controller reports the mouse everywhere in the window; the decision is in revelation.ts.
  const compact = $derived(winState?.compact ?? false);
  let revealed = $state(false);
  let armed = INITIAL_REVEAL.armee;
  let zone: ZoneGauche = "loin";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const barVisible = $derived(!compact || revealed);

  function onMouseZone(z: ZoneGauche) {
    zone = z;
    if (!compact) return;
    const r = surZone({ revelee: revealed, armee: armed }, z);
    armed = r.armee;
    revealed = r.revelee;
    if (r.masquer) scheduleHide();
    else clearTimeout(timer);
  }
  function scheduleHide() {
    clearTimeout(timer);
    // The access bubble is mounted outside the sidebar: while it is open, the sidebar stays.
    if (!revealed || access.bullesOuvertes > 0) return;
    timer = setTimeout(() => {
      if (zone !== "loin" || access.bullesOuvertes > 0) return;
      const r = masquer(zone);
      revealed = r.revelee;
      armed = r.armee;
    }, HIDING_MS);
  }
  // Once the bubble closes, hiding resumes if the mouse is already away from the sidebar.
  $effect(() => {
    if (access.bullesOuvertes === 0) untrack(() => zone === "loin" && scheduleHide());
  });
  $effect(() => api.surZoneGauche(onMouseZone));
  $effect(() => win.setSidebarColumn(!compact));
  $effect(() => win.setSidebarVisible(barVisible));
  $effect(() => {
    if (!compact) {
      clearTimeout(timer);
      revealed = false;
    }
  });
</script>

<!-- A tab switch to the parking tab blurs the field the empty page had just focused; the controller then focuses this
     iframe again (TabSwitchDone), and the empty page takes the keyboard back. -->
<svelte:window onfocus={() => document.activeElement === document.body && focusEmptyPage.n++} />

<div class="fenetre" inert={!!agentRequest || !!spaceSettings.brouillon || !!command.ouverte} class:compact class:couverte={overlay}>
  <div class="colonne" class:repliee={!barVisible} inert={!barVisible}>
    {#if winState}
      <!-- ✦ on a builder tab: the controller opens the panel and sends "agent", handled above. -->
      <Sidebar fenetre={winState} basculerPanneau={togglePanel} agentDuConstructeur={() => win.openAgent()} />
    {:else}
      <aside data-testid="barre-laterale"></aside>
    {/if}
  </div>
  <main class="contenu" class:opaque={!pageWeb || !!panel} data-testid="zone-contenu">
    {#if winState && panel === "historique"}
      <History fenetre={winState} fermer={closePanel} />
    {:else if panel === "telechargements"}
      <Downloads fermer={closePanel} />
    {:else if winState && !activeTab}
      <EmptyPage fenetre={winState} />
    {:else if activeTab && (activeTab.plante || activeTab.erreur)}
      <PageError onglet={activeTab} />
    {:else if activeTab?.url === URL_EXTENSIONS}
      <Extensions />
    {:else if activeTab?.url === URL_APPLICATIONS}
      <Applications />
    {:else if activeTab?.url === URL_ACTIONS}
      {#if privateAction}
        <p class="plante" data-testid="action-espace-prive">{ACTIONS_IN_PRIVATE_SPACE}</p>
      {:else}
        <Actions />
      {/if}
    {:else if builderTarget}
      {#if builderTarget.type === "action" && privateAction}
        <p class="plante" data-testid="action-espace-prive">{ACTIONS_IN_PRIVATE_SPACE}</p>
      {:else}
        {#key `${builderTarget.type}:${builderTarget.id}`}<WorkflowBuilder cible={builderTarget} />{/key}
      {/if}
    {:else if pageAction}
      {#if privateAction}
        <p class="plante" data-testid="action-espace-prive">{ACTIONS_IN_PRIVATE_SPACE}</p>
      {:else}
        {#key `${pageAction.id}/${pageAction.execution}`}<PageAction id={pageAction.id} execution={pageAction.execution} />{/key}
      {/if}
    {:else if reviewProject}
      {#key `${activeTab?.id}:${reviewProject}`}<Review projet={reviewProject} ongletId={activeTab?.id ?? ""} />{/key}
    {:else if activeTab && !pageWeb}
      <InternalPage />
    {/if}
  </main>
</div>
<ContextMenu />
<!-- No page capture under the modals in step 2: the web page shows through the veil. An agent's question comes before
     the space settings, which come back with their draft. -->
{#if agentRequest}
  <RequestModal demande={agentRequest} ongletId={null} />
{:else if spaceSettings.brouillon && winState}
  <SpaceModal fenetreId={winState.id} ongletId={null} />
{/if}
{#if tabPanel}
  <FrozenBackground ongletId={activeTab?.id ?? null} surPret={() => (tabPanelReady = true)} />
  {#if tabPanelReady}<TabsPanel panneau={tabPanel} />{/if}
{/if}
{#if command.ouverte && winState}
  <div class="couche-commande">
    <FrozenBackground ongletId={activeTab?.id ?? null} surPret={() => {}} />
    <CommandBar fenetre={winState} ongletActif={activeTab} cede={!!tabPanel} fermerPanneau={() => (panel = null)} />
  </div>
{/if}

<style>
  /* Transparent so the web page under the iframe shows; the sidebar and the content area paint their own. */
  :global(html, body) { background: transparent; }
  /* Firefox's -webkit-app-region: the same areas. An overlay over the sidebar keeps its clicks. */
  .fenetre:not(.couverte) :global(.barre) { -moz-window-dragging: drag; }
  .fenetre :global(.barre :is(.navigation button, .ligne, .defilant, footer)) { -moz-window-dragging: no-drag; }
  /* The Actions page's confirmation covers the window, its drag areas too (no-drag on its veil). */
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
  /* The action page fills it (position: absolute), not the window. */
  .contenu { position: relative; min-width: 0; min-height: 0; }
  .opaque { background: var(--fond); }
  /* The page's error and crash messages. */
  .plante { display: grid; place-content: center; gap: 12px; height: 100%; text-align: center; color: var(--texte); }
</style>
