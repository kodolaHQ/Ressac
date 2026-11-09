<script lang="ts">
  import "@xyflow/svelte/dist/style.css";
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import { untrack } from "svelte";
  import type { BlockCatalogEntry, Owner } from "@webaios/kernel";
  import { focusAgent } from "../components/agent.svelte";
  import { api } from "../state.svelte";
  import { freeSlot } from "./add";
  import ActionPreview from "./ActionPreview.svelte";
  import WidgetPreview from "../WidgetPreview.svelte";
  import RunsBar from "./RunsBar.svelte";
  import Canvas from "./Canvas.svelte";
  import { targetKey, repoOf, launcherOf, runsSourceOf } from "./target";
  import { confirmBlockChange, keepBeforeClosing } from "./codes.svelte";
  import { createEdit, followDisappearances } from "./edit.svelte";
  import { Executions } from "./executions.svelte";
  import RunList from "./RunList.svelte";
  import AgentTab from "../AgentTab.svelte";
  import BlockTab from "./BlockTab.svelte";
  import Palette from "./Palette.svelte";
  import { badgesOf } from "./badges";

  /**
   * The builder of a widget's workflow (page `webaios://workflow/<id>`) or an action's
   * (`webaios://workflow/action/<id>`): same canvas; an action has its panel, its input at launch and its page
   * preview.
   */
  let { target: target }: { target: Owner } = $props();
  // svelte-ignore state_referenced_locally
  const isAction = target.type === "action";
  /** This workflow's key in the window states (edits, codes, chosen run). */
  // svelte-ignore state_referenced_locally
  const id = targetKey(target);

  // Kept per window and per workflow: changing tab loses neither an invalid draft nor the history.
  const edit = createEdit(id, repoOf(api.workflow));
  followDisappearances(api.home);
  keepBeforeClosing();
  // svelte-ignore state_referenced_locally
  const runs = new Executions(id, runsSourceOf(api, target), launcherOf(api, target));
  /** What changes on disk: home for a widget, actions for an action. */
  const onChange = isAction ? api.actions.onChange : api.home.onChange;
  let catalog = $state.raw<BlockCatalogEntry[]>([]);
  const byType = $derived(new Map(catalog.map((c) => [c.type, c])));
  /**
   * Items and status of each block at the chosen run (by default the latest real one, not a trial), replaced as the
   * traces come in by those of the running run of this widget.
   */
  const badges = $derived(badgesOf(runs.chosen, runs.live));
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

  const name = $derived(edit.widget?.name ?? edit.action?.name ?? target.id);
  /** The input requested by « ▶ Lancer » (action with an input): the small window is open. */
  let request = $state<{ label: string; value: string } | null>(null);
  const hasOutput = $derived(edit.draft?.blocks.some((b) => b.type === "sortie") ?? false);
  const outputId = $derived(edit.draft?.blocks.find((b) => b.type === "sortie")?.id);
  const appState = $derived.by(() => {
    const e = edit.recordingState;
    if (e === "enregistre") return "Enregistré";
    if (e === "en-cours") return "Enregistrement…";
    if ("invalid" in e) return `Non enregistré : ${e.invalid}`;
    return `Erreur d'enregistrement : ${e.error}`;
  });

  const loadRuns = () => void runs.load().catch(() => {});

  /** A block selected on the canvas; leaving unsaved code asks for confirmation. */
  function select(block: string | null): void {
    if (block === selection) return;
    const current = selection === null ? undefined : edit.draft?.blocks.find((b) => b.id === selection);
    const source = current?.type === "code" ? current.params.source : undefined;
    if (typeof source === "string" && !confirmBlockChange(id, source)) {
      canvas?.select(selection);
      return;
    }
    selection = block;
    api.workflow.selection(target, block);
  }

  $effect(() => untrack(() => {
    // No block is reported to the agent until the user has chosen one here.
    api.workflow.selection(target, null);
    void api.workflow.catalog().then((c) => (catalog = c));
    void edit.open();
    loadRuns();
    const endDirect = runs.follow();
    const end = onChange(() => {
      void edit.review();
      loadRuns();
    });
    return () => {
      end();
      endDirect();
      api.workflow.selection(target, null);
    };
  }));

  /** ⌘Z / ⇧⌘Z: undo and redo the canvas, except in a text field (it keeps its own). */
  function key(e: KeyboardEvent): void {
    if (!e.metaKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== "z") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    e.preventDefault();
    if (e.shiftKey) edit.restore();
    else edit.cancel();
  }

  function add(type: string, position?: { x: number; y: number }): void {
    const c = byType.get(type);
    if (!c || !canvas) return;
    const p = freeSlot(position ?? canvas.center(), Object.values(edit.positions));
    void edit.add(c, p);
  }

  /** « ▶ Lancer »: an action with an input asks for it first; empty, nothing goes out. */
  function launch(): void {
    const input = edit.action?.input;
    if (input) request = { label: input.label, value: "" };
    else void runs.launch().catch(() => {});
  }

  function confirmLaunch(e: SubmitEvent): void {
    e.preventDefault();
    const value = request?.value.trim();
    if (!value) return;
    request = null;
    void runs.launch(value).catch(() => {});
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
    edit.reorder();
    canvas?.adjustView();
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
    <span class="etat" class:invalide={edit.recordingState !== "enregistre" && edit.recordingState !== "en-cours"} data-testid="etat-enregistrement"
      >{appState}</span
    >
    <div class="actions">
      <button data-testid="bouton-apercu" aria-pressed={previewOpen} onclick={() => (previewOpen = !previewOpen)}>{isAction ? "Aperçu de la page" : "Aperçu du widget"}</button>
      <button data-testid="reorganiser" disabled={!edit.draft} onclick={reorganize}>Réorganiser</button>
      <button class="lancer" data-testid="lancer" disabled={!edit.diskValid || runs.busy || edit.recordingState === "en-cours"} onclick={launch}>
        {runs.busy ? "Exécution…" : "▶ Lancer"}
      </button>
    </div>
  </header>

  {#if edit.banner}
    <div class="bandeau" data-testid="bandeau-fichier" role="status">
      {#if edit.banner === "proposer"}
        <span>L'agent a modifié le workflow pendant que le tien n'était pas enregistré.</span>
        <button data-testid="prendre-version" onclick={() => edit.takeDiskVersion()}>Prendre sa version</button>
        <button data-testid="garder-mienne" onclick={() => edit.keepMine()}>Garder la mienne</button>
      {:else}
        <span>workflow.json est illisible sur le disque (l'agent est peut-être en train de l'écrire).</span>
        <button data-testid="garder-mienne" onclick={() => edit.keepMine()}>Garder la mienne</button>
      {/if}
    </div>
  {/if}

  <!-- The right pane: « Bloc » (only with a canvas) and « Agent », the window's agent conversation. -->
  {#snippet pane(withBlock: boolean)}
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
          <BlockTab widget={id} editing={edit} {runs} catalog={byType} {selection} />
        </div>
      {/if}
      {#if rightTab === "agent"}<AgentTab />{/if}
    </aside>
  {/snippet}

  {#if edit.loading === "chargement"}
    <p class="doux message">Chargement…</p>
  {:else if edit.loading === "introuvable" || typeof edit.loading === "object"}
    <!-- Without a canvas, the agent stays there: it is up to it to repair or write the workflow. -->
    <div class="corps">
      {#if edit.loading === "introuvable"}
        <p class="doux message">
          {isAction ? "Cette action n'a pas de workflow (workflow.json), ou action.json est illisible." : "Ce widget n'a pas de workflow (ni workflow.json ni recolte.mjs)."}
        </p>
      {:else}
        <p class="erreur message" data-testid="workflow-illisible">{edit.loading.unreadable}</p>
      {/if}
      {@render pane(false)}
    </div>
  {:else}
    <SvelteFlowProvider>
      <div class="corps">
        {#if view === "executions"}<RunList {runs} onchosen={() => (view = "workflow")} />{/if}
        <Palette catalog={catalog} hasOutput={hasOutput} web={edit.widget?.web ?? edit.action?.web ?? false} action={isAction} onadd={(type) => add(type)} />
        <div class="zone-canevas">
          <Canvas
            bind:this={canvas}
            editing={edit}
            catalog={byType}
            badges={badges}
            onselection={select}
            onadd={(type, p) => add(type, p)}
          />
          {#if previewOpen}
            {#if target.type === "action"}<ActionPreview id={target.id} {runs} />{:else}<WidgetPreview id={target.id} {runs} />{/if}
          {/if}
        </div>
        {@render pane(true)}
      </div>
      {#if view === "workflow"}
        <RunsBar {runs} {selection} output={outputId} replayable={edit.diskValid && edit.recordingState !== "en-cours"} />
      {/if}
    </SvelteFlowProvider>
  {/if}

  {#if request}
    <div class="voile">
      <div class="demande" data-testid="demande-saisie" role="dialog" aria-modal="true" aria-label="Lancer l'action">
        <form onsubmit={confirmLaunch}>
          <label>
            <span>{request.label}</span>
            <input data-testid="saisie-lancer" maxlength="200" bind:value={request.value} onkeydown={requestedKey} use:focus />
          </label>
          <div class="boutons">
            <button type="button" onclick={() => (request = null)}>Annuler</button>
            <button type="submit" class="lancer" data-testid="confirmer-lancer" disabled={!request.value.trim()}>▶ Lancer</button>
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
