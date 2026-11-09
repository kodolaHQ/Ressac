<script lang="ts">
  import "@xyflow/svelte/dist/style.css";
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import { untrack } from "svelte";
  import type { CatalogueBloc, Owner } from "@webaios/kernel";
  import { focusAgent } from "../components/agent.svelte";
  import { api } from "../state.svelte";
  import { freeSlot } from "./add";
  import ActionPreview from "./ActionPreview.svelte";
  import WidgetPreview from "../WidgetPreview.svelte";
  import RunsBar from "./RunsBar.svelte";
  import Canvas from "./Canvas.svelte";
  import { targetKey, depotDe, launcherOf, sourceExecutionsDe } from "./target";
  import { confirmerChangementDeBloc, keepBeforeClosing } from "./codes.svelte";
  import { createEdit, followDisappearances } from "./edition.svelte";
  import { Executions } from "./executions.svelte";
  import RunList from "./RunList.svelte";
  import AgentTab from "../AgentTab.svelte";
  import BlockTab from "./BlockTab.svelte";
  import Palette from "./Palette.svelte";
  import { pastillesDe } from "./badges";

  /**
   * The builder of a widget's workflow (page `webaios://workflow/<id>`) or an action's
   * (`webaios://workflow/action/<id>`): same canvas; an action has its panel, its input at launch and its page
   * preview.
   */
  let { cible: target }: { cible: Owner } = $props();
  // svelte-ignore state_referenced_locally
  const isAction = target.type === "action";
  /** This workflow's key in the window states (edits, codes, chosen run). */
  // svelte-ignore state_referenced_locally
  const id = targetKey(target);

  // Kept per window and per workflow: changing tab loses neither an invalid draft nor the history.
  const edition = createEdit(id, depotDe(api.workflow));
  followDisappearances(api.accueil);
  keepBeforeClosing();
  // svelte-ignore state_referenced_locally
  const executions = new Executions(id, sourceExecutionsDe(api, target), launcherOf(api, target));
  /** What changes on disk: home for a widget, actions for an action. */
  const surChange = isAction ? api.actions.surChange : api.accueil.surChange;
  let catalogue = $state.raw<CatalogueBloc[]>([]);
  const parType = $derived(new Map(catalogue.map((c) => [c.type, c])));
  /**
   * Items and status of each block at the chosen run (by default the latest real one, not a trial), replaced as the
   * traces come in by those of the running run of this widget.
   */
  const pastilles = $derived(pastillesDe(executions.choisie, executions.enDirect));
  /** The block shown in the « Bloc » tab. */
  let selection = $state<string | null>(null);
  let canvas = $state<ReturnType<typeof Canvas>>();
  let view = $state<"workflow" | "executions">("workflow");
  let previewOpen = $state(false);
  /** Right pane tab: the selected block, or the window's agent conversation. */
  let rightTab = $state<"bloc" | "agent">("bloc");
  // ⌘J or ✦ while the builder is shown: the « Agent » tab, whose terminal takes the keyboard.
  const agentRequests = untrack(() => focusAgent.n);
  $effect(() => {
    if (focusAgent.n !== agentRequests) rightTab = "agent";
  });

  const name = $derived(edition.widget?.nom ?? edition.action?.nom ?? target.id);
  /** The input requested by « ▶ Lancer » (action with an input): the small window is open. */
  let request = $state<{ libelle: string; valeur: string } | null>(null);
  const aSortie = $derived(edition.brouillon?.blocs.some((b) => b.type === "sortie") ?? false);
  const idSortie = $derived(edition.brouillon?.blocs.find((b) => b.type === "sortie")?.id);
  const appState = $derived.by(() => {
    const e = edition.etatEnregistrement;
    if (e === "enregistre") return "Enregistré";
    if (e === "en-cours") return "Enregistrement…";
    if ("invalide" in e) return `Non enregistré : ${e.invalide}`;
    return `Erreur d'enregistrement : ${e.erreur}`;
  });

  const chargerExecutions = () => void executions.charger().catch(() => {});

  /** A block selected on the canvas; leaving unsaved code asks for confirmation. */
  function select(bloc: string | null): void {
    if (bloc === selection) return;
    const courant = selection === null ? undefined : edition.brouillon?.blocs.find((b) => b.id === selection);
    const source = courant?.type === "code" ? courant.parametres.source : undefined;
    if (typeof source === "string" && !confirmerChangementDeBloc(id, source)) {
      canvas?.selectionner(selection);
      return;
    }
    selection = bloc;
    api.workflow.selection(target, bloc);
  }

  $effect(() => untrack(() => {
    // No block is reported to the agent until the user has chosen one here.
    api.workflow.selection(target, null);
    void api.workflow.catalogue().then((c) => (catalogue = c));
    void edition.ouvrir();
    chargerExecutions();
    const finDirect = executions.suivre();
    const fin = surChange(() => {
      void edition.relire();
      chargerExecutions();
    });
    return () => {
      fin();
      finDirect();
      api.workflow.selection(target, null);
    };
  }));

  /** ⌘Z / ⇧⌘Z: undo and redo the canvas, except in a text field (it keeps its own). */
  function key(e: KeyboardEvent): void {
    if (!e.metaKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== "z") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    e.preventDefault();
    if (e.shiftKey) edition.retablir();
    else edition.annuler();
  }

  function add(type: string, position?: { x: number; y: number }): void {
    const c = parType.get(type);
    if (!c || !canvas) return;
    const p = freeSlot(position ?? canvas.centre(), Object.values(edition.positions));
    void edition.ajouter(c, p);
  }

  /** « ▶ Lancer »: an action with an input asks for it first; empty, nothing goes out. */
  function lancer(): void {
    const input = edition.action?.saisie;
    if (input) request = { libelle: input.libelle, valeur: "" };
    else void executions.lancer().catch(() => {});
  }

  function confirmLaunch(e: SubmitEvent): void {
    e.preventDefault();
    const valeur = request?.valeur.trim();
    if (!valeur) return;
    request = null;
    void executions.lancer(valeur).catch(() => {});
  }

  function requestedKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    request = null;
  }

  /** The field takes the keyboard when the small window opens. */
  function focus(n: HTMLInputElement): void {
    n.focus();
  }

  function reorganize(): void {
    edition.reorganiser();
    canvas?.ajusterVue();
  }
</script>

<svelte:window onkeydown={key} />

<div class="constructeur" data-testid="constructeur">
  <header>
    <h1>{name}</h1>
    <div class="onglets" role="tablist">
      <button role="tab" aria-selected={view === "workflow"} class:actif={view === "workflow"} onclick={() => (view = "workflow")}>Workflow</button>
      <button role="tab" data-testid="vue-executions" aria-selected={view === "executions"} class:actif={view === "executions"} onclick={() => (view = "executions")}
        >Exécutions</button
      >
    </div>
    <span class="etat" class:invalide={edition.etatEnregistrement !== "enregistre" && edition.etatEnregistrement !== "en-cours"} data-testid="etat-enregistrement"
      >{appState}</span
    >
    <div class="actions">
      <button data-testid="bouton-apercu" aria-pressed={previewOpen} onclick={() => (previewOpen = !previewOpen)}>{isAction ? "Aperçu de la page" : "Aperçu du widget"}</button>
      <button data-testid="reorganiser" disabled={!edition.brouillon} onclick={reorganize}>Réorganiser</button>
      <button class="lancer" data-testid="lancer" disabled={!edition.disqueValide || executions.occupe || edition.etatEnregistrement === "en-cours"} onclick={lancer}>
        {executions.occupe ? "Exécution…" : "▶ Lancer"}
      </button>
    </div>
  </header>

  {#if edition.bandeau}
    <div class="bandeau" data-testid="bandeau-fichier" role="status">
      {#if edition.bandeau === "proposer"}
        <span>L'agent a modifié le workflow pendant que le tien n'était pas enregistré.</span>
        <button data-testid="prendre-version" onclick={() => edition.prendreVersionDisque()}>Prendre sa version</button>
        <button data-testid="garder-mienne" onclick={() => edition.garderLaMienne()}>Garder la mienne</button>
      {:else}
        <span>workflow.json est illisible sur le disque (l'agent est peut-être en train de l'écrire).</span>
        <button data-testid="garder-mienne" onclick={() => edition.garderLaMienne()}>Garder la mienne</button>
      {/if}
    </div>
  {/if}

  <!-- The right pane: « Bloc » (only with a canvas) and « Agent », the window's agent conversation. -->
  {#snippet volet(withBlock: boolean)}
    <aside class="droite" class:agent={rightTab === "agent"} aria-label={rightTab === "agent" ? "Agent" : "Bloc"}>
      <div class="onglets-droite" role="tablist">
        {#if withBlock}
          <button role="tab" aria-selected={rightTab === "bloc"} class:actif={rightTab === "bloc"} onclick={() => (rightTab = "bloc")}>Bloc</button>
        {/if}
        <button role="tab" data-testid="onglet-agent" aria-selected={rightTab === "agent"} class:actif={rightTab === "agent"} onclick={() => (rightTab = "agent")}
          >Agent</button
        >
      </div>
      {#if withBlock}
        <!-- The « Bloc » tab stays mounted, hidden: a setting or code being typed is not lost there. -->
        <div class="volet-bloc" hidden={rightTab !== "bloc"}>
          <BlockTab widget={id} {edition} {executions} catalogue={parType} {selection} />
        </div>
      {/if}
      {#if rightTab === "agent"}<AgentTab />{/if}
    </aside>
  {/snippet}

  {#if edition.chargement === "chargement"}
    <p class="doux message">Chargement…</p>
  {:else if edition.chargement === "introuvable" || typeof edition.chargement === "object"}
    <!-- Without a canvas, the agent stays there: it is up to it to repair or write the workflow. -->
    <div class="corps">
      {#if edition.chargement === "introuvable"}
        <p class="doux message">
          {isAction ? "Cette action n'a pas de workflow (workflow.json), ou action.json est illisible." : "Ce widget n'a pas de workflow (ni workflow.json ni recolte.mjs)."}
        </p>
      {:else}
        <p class="erreur message" data-testid="workflow-illisible">{edition.chargement.illisible}</p>
      {/if}
      {@render volet(false)}
    </div>
  {:else}
    <SvelteFlowProvider>
      <div class="corps">
        {#if view === "executions"}<RunList {executions} onchoisie={() => (view = "workflow")} />{/if}
        <Palette {catalogue} {aSortie} web={edition.widget?.web ?? edition.action?.web ?? false} action={isAction} onajouter={(type) => add(type)} />
        <div class="zone-canevas">
          <Canvas
            bind:this={canvas}
            {edition}
            catalogue={parType}
            {pastilles}
            onselection={select}
            onajouter={(type, p) => add(type, p)}
          />
          {#if previewOpen}
            {#if target.type === "action"}<ActionPreview id={target.id} {executions} />{:else}<WidgetPreview id={target.id} {executions} />{/if}
          {/if}
        </div>
        {@render volet(true)}
      </div>
      {#if view === "workflow"}
        <RunsBar {executions} {selection} sortie={idSortie} rejouable={edition.disqueValide && edition.etatEnregistrement !== "en-cours"} />
      {/if}
    </SvelteFlowProvider>
  {/if}

  {#if request}
    <div class="voile">
      <div class="demande" data-testid="demande-saisie" role="dialog" aria-modal="true" aria-label="Lancer l'action">
        <form onsubmit={confirmLaunch}>
          <label>
            <span>{request.libelle}</span>
            <input data-testid="saisie-lancer" maxlength="200" bind:value={request.valeur} onkeydown={requestedKey} use:focus />
          </label>
          <div class="boutons">
            <button type="button" onclick={() => (request = null)}>Annuler</button>
            <button type="submit" class="lancer" data-testid="confirmer-lancer" disabled={!request.valeur.trim()}>▶ Lancer</button>
          </div>
        </form>
      </div>
    </div>
  {/if}
</div>

<style>
  .constructeur { position: relative; height: 100%; display: flex; flex-direction: column; color: var(--texte); min-height: 0; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--bord); flex-wrap: wrap; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .onglets { display: flex; gap: 2px; }
  .onglets button { padding: 4px 10px; border-radius: 6px; border: none; background: none; color: var(--texte-doux); }
  .onglets button.actif { background: var(--fond-actif); color: var(--texte); }
  .onglets button:disabled { opacity: 0.5; }
  .etat { font-size: 12px; color: var(--texte-doux); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .etat.invalide { color: var(--en-erreur); }
  .actions { display: flex; gap: 8px; margin-left: auto; }
  .actions button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .actions button:disabled { opacity: 0.5; }
  .actions .lancer { border-color: var(--accent); background: var(--accent); color: white; }
  .bandeau { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--fond-actif); font-size: 13px; }
  .bandeau span { flex: 1; }
  .corps { position: relative; flex: 1; display: flex; min-height: 0; }
  .zone-canevas { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; }
  .droite { width: 320px; flex: none; display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--bord); background: var(--fond-barre); }
  /* The side panel's width (--agent, set by App): the terminal keeps its columns when moving from one to the other. */
  .droite.agent { width: var(--agent, 420px); }
  .volet-bloc { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .volet-bloc[hidden] { display: none; }
  .onglets-droite { display: flex; gap: 2px; padding: 8px 12px 0; }
  .onglets-droite button { padding: 4px 10px; border-radius: 6px; border: none; background: none; color: var(--texte-doux); }
  .onglets-droite button.actif { background: var(--fond-actif); color: var(--texte); }
  .message { padding: 20px 24px; margin: 0; }
  .corps > .message { flex: 1; min-width: 0; }
  .doux { color: var(--texte-doux); }
  .erreur { color: var(--en-erreur); white-space: pre-wrap; word-break: break-word; }
  .voile { position: absolute; inset: 0; z-index: 10; display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: rgba(0, 0, 0, 0.25); }
  .demande form { display: flex; flex-direction: column; gap: 12px; }
  .demande { width: 340px; max-width: calc(100% - 32px); padding: 16px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); box-shadow: var(--ombre-modale); font-size: 13px; }
  .demande label { display: flex; flex-direction: column; gap: 6px; }
  .demande input { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); font: inherit; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .boutons button:disabled { opacity: 0.5; }
  .boutons .lancer { border-color: var(--accent); background: var(--accent); color: white; }
</style>
