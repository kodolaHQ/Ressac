<script lang="ts">
  import "@xyflow/svelte/dist/style.css";
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import { untrack } from "svelte";
  import type { BlockCatalogEntry, Owner } from "@ressac/kernel";
  import { focusAgent } from "../components/agent.svelte";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import { useLocale } from "./say";
  import { freeSlot } from "./add";
  import ActionPreview from "./ActionPreview.svelte";
  import WidgetPreview from "../WidgetPreview.svelte";
  import RunsBar from "./RunsBar.svelte";
  import Canvas from "./Canvas.svelte";
  import { targetKey, repoOf, launcherOf, runsSourceOf } from "./target";
  import { confirmBlockChange, keepBeforeClosing } from "./codes.svelte";
  import { createEdit, followDisappearances, AWAITING_CHOICE } from "./edit.svelte";
  import { Executions } from "./executions.svelte";
  import RunList from "./RunList.svelte";
  import AgentTab from "../AgentTab.svelte";
  import BlockTab from "./BlockTab.svelte";
  import Palette from "./Palette.svelte";
  import { badgesOf } from "./badges";
  import AccountGrantCard from "../components/AccountGrantCard.svelte";
  import type { ActionShown } from "../../shared/actions";

  /**
   * The builder of a widget's workflow (page `ressac://workflow/<id>`) or an action's
   * (`ressac://workflow/action/<id>`): same canvas; an action has its panel, its input at launch and its page
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
  let view = $state<"workflow" | "runs">("workflow");
  let previewOpen = $state(false);
  /** Right pane tab: the selected block, or the window's agent conversation. */
  let rightTab = $state<"block" | "agent">("block");
  // ⌘J or ✦ while the builder is shown: the « Agent » tab, whose terminal takes the keyboard.
  const agentRequests = untrack(() => focusAgent.n);
  $effect(() => {
    if (focusAgent.n !== agentRequests) rightTab = "agent";
  });

  const name = $derived(edit.widget?.name ?? edit.action?.name ?? target.id);
  /** The input requested by « ▶ Lancer » (action with an input): the small window is open. */
  let request = $state<{ label: string; value: string } | null>(null);
  const hasOutput = $derived(edit.draft?.blocks.some((b) => b.type === "output") ?? false);
  const outputId = $derived(edit.draft?.blocks.find((b) => b.type === "output")?.id);
  $effect.pre(() => useLocale(appState.value?.locale ?? "fr"));
  const saveText = $derived.by(() => {
    const e = edit.recordingState;
    if (e === "saved") return t("builder-save-saved");
    if (e === "saving") return t("builder-save-saving");
    if ("invalid" in e) return t("builder-save-invalid", { reason: e.invalid === AWAITING_CHOICE ? t(AWAITING_CHOICE) : e.invalid });
    return t("builder-save-error", { reason: e.error });
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
    else void start();
  }

  /** An action that reads with an account and has no grant yet: the action page's grant card first, then the run. */
  let grantFor = $state<{ action: ActionShown; input?: string } | null>(null);
  async function start(input?: string): Promise<void> {
    if (isAction) {
      const a = (await api.actions.list().catch(() => [])).find((x) => x.id === target.id);
      if (a && a.account.length > 0 && !a.grant) return void (grantFor = { action: a, input });
    }
    await (input === undefined ? runs.launch() : runs.launch(input)).catch(() => {});
  }
  async function giveGrant(profile: string): Promise<void> {
    const g = grantFor;
    grantFor = null;
    if (!g) return;
    const r = await api.actions.grant({ id: g.action.id, profile, account: [...g.action.account], public: [...g.action.public] });
    if (!r.ok) return void (runs.denial = t("builder-grant-error", { reason: r.error }));
    await start(g.input);
  }

  function confirmLaunch(e: SubmitEvent): void {
    e.preventDefault();
    const value = request?.value.trim();
    if (!value) return;
    request = null;
    void start(value);
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

<div class="builder" data-testid="builder">
  <header>
    <h1>{name}</h1>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={view === "workflow"} class:active={view === "workflow"} onclick={() => (view = "workflow")}>{t("builder-tab-workflow")}</button>
      <button role="tab" data-testid="executions-view" aria-selected={view === "runs"} class:active={view === "runs"} onclick={() => (view = "runs")}
        >{t("builder-tab-runs")}</button
      >
    </div>
    <span class="state" class:invalid={edit.recordingState !== "saved" && edit.recordingState !== "saving"} data-testid="save-status"
      >{saveText}</span
    >
    <div class="actions">
      <button data-testid="preview-button" aria-pressed={previewOpen} onclick={() => (previewOpen = !previewOpen)}>{t(isAction ? "builder-preview-action" : "builder-preview-widget")}</button>
      <button data-testid="rearrange" disabled={!edit.draft} onclick={reorganize}>{t("builder-rearrange")}</button>
      <button class="launch" data-testid="launch" disabled={!edit.diskValid || runs.busy || edit.recordingState === "saving"} onclick={launch}>
        {runs.busy ? t("builder-running") : t("builder-launch")}
      </button>
    </div>
  </header>

  {#if edit.banner}
    <div class="banner" data-testid="file-banner" role="status">
      {#if edit.banner === "proposer"}
        <span>{t("builder-banner-proposal")}</span>
        <button data-testid="take-version" onclick={() => edit.takeDiskVersion()}>{t("builder-banner-take")}</button>
        <button data-testid="keep-mine" onclick={() => edit.keepMine()}>{t("builder-banner-keep")}</button>
      {:else}
        <span>{t("builder-banner-unreadable")}</span>
        <button data-testid="keep-mine" onclick={() => edit.keepMine()}>{t("builder-banner-keep")}</button>
      {/if}
    </div>
  {/if}

  <!-- The right pane: « Bloc » (only with a canvas) and « Agent », the window's agent conversation. -->
  {#snippet pane(withBlock: boolean)}
    <aside class="right" class:agent={rightTab === "agent"} aria-label={rightTab === "agent" ? t("builder-pane-agent") : t("builder-pane-block")}>
      <div class="tabs-right" role="tablist">
        {#if withBlock}
          <button role="tab" aria-selected={rightTab === "block"} class:active={rightTab === "block"} onclick={() => (rightTab = "block")}>{t("builder-pane-block")}</button>
        {/if}
        <button role="tab" data-testid="agent-tab" aria-selected={rightTab === "agent"} class:active={rightTab === "agent"} onclick={() => (rightTab = "agent")}
          >{t("builder-pane-agent")}</button
        >
      </div>
      {#if withBlock}
        <!-- The « Bloc » tab stays mounted, hidden: a setting or code being typed is not lost there. -->
        <div class="block-pane" hidden={rightTab !== "block"}>
          <BlockTab widget={id} editing={edit} {runs} catalog={byType} {selection} />
        </div>
      {/if}
      {#if rightTab === "agent"}<AgentTab />{/if}
    </aside>
  {/snippet}

  {#if edit.loading === "loading"}
    <p class="muted message">{t("builder-loading")}</p>
  {:else if edit.loading === "not-found" || typeof edit.loading === "object"}
    <!-- Without a canvas, the agent stays there: it is up to it to repair or write the workflow. -->
    <div class="body">
      {#if edit.loading === "not-found"}
        <p class="muted message">
          {t(isAction ? "builder-no-workflow-action" : "builder-no-workflow-widget")}
        </p>
      {:else}
        <p class="error message" data-testid="workflow-unreadable">{edit.loading.unreadable}</p>
      {/if}
      {@render pane(false)}
    </div>
  {:else}
    <SvelteFlowProvider>
      <div class="body">
        {#if view === "runs"}<RunList {runs} onchosen={() => (view = "workflow")} />{/if}
        <Palette catalog={catalog} hasOutput={hasOutput} web={edit.widget?.web ?? edit.action?.web ?? false} action={isAction} onadd={(type) => add(type)} />
        <div class="canvas-zone">
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
        <RunsBar {runs} {selection} output={outputId} replayable={edit.diskValid && edit.recordingState !== "saving"} />
      {/if}
    </SvelteFlowProvider>
  {/if}

  {#if grantFor}
    <AccountGrantCard
      subject="action"
      name={grantFor.action.name}
      domains={grantFor.action.account}
      public={grantFor.action.public}
      profilesForGrant={api.actions.profilesForGrant}
      close={() => (grantFor = null)}
      allow={(profile) => void giveGrant(profile)}
    />
  {/if}

  {#if request}
    <div class="veil">
      <div class="request" data-testid="input-request" role="dialog" aria-modal="true" aria-label={t("builder-launch-dialog")}>
        <form onsubmit={confirmLaunch}>
          <label>
            <span>{request.label}</span>
            <input data-testid="launch-input" maxlength="200" bind:value={request.value} onkeydown={requestedKey} use:focus />
          </label>
          <div class="buttons">
            <button type="button" onclick={() => (request = null)}>{t("builder-cancel")}</button>
            <button type="submit" class="launch" data-testid="confirm-launch" disabled={!request.value.trim()}>{t("builder-launch")}</button>
          </div>
        </form>
      </div>
    </div>
  {/if}
</div>

<style>
  .builder { position: relative; height: 100%; display: flex; flex-direction: column; color: var(--text); min-height: 0; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  h1 { margin: 0; font: 650 22px/1.1 var(--font-display); letter-spacing: -0.02em; }
  .tabs { display: flex; gap: 2px; }
  .tabs button, .tabs-right button { padding: 5px 11px; border-radius: 10px; border: none; background: none; color: var(--text-muted); font: 500 13px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  .tabs button:active, .tabs-right button:active { transform: scale(0.97); }
  .tabs button.active, .tabs-right button.active { background: var(--glass-hi); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); color: var(--text); }
  .tabs button:disabled { opacity: 0.5; }
  .state { font-size: 12px; color: var(--text-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .state.invalid { color: var(--in-error); }
  .actions { display: flex; gap: 8px; margin-left: auto; }
  .actions button, .buttons button { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  :is(.actions, .buttons) button:hover:not(:disabled) { background: var(--bg-active); }
  :is(.actions, .buttons) button:active:not(:disabled) { transform: scale(0.97); }
  .actions button:disabled { opacity: 0.5; }
  :is(.actions, .buttons) .launch, :is(.actions, .buttons) .launch:hover:not(:disabled) { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
  .banner { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--attention-bg); font-size: 13px; }
  .banner span { flex: 1; }
  .body { position: relative; flex: 1; display: flex; min-height: 0; }
  .canvas-zone { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; }
  /* Narrow window (the agent panel open beside it): the side pane gives way before the canvas does. */
  .right { width: clamp(240px, 36%, 320px); flex: none; display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--border); }
  /* The side panel's width (--agent, set by App): the terminal keeps its columns when moving from one to the other. */
  .right.agent { width: var(--agent, 420px); }
  .block-pane { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .block-pane[hidden] { display: none; }
  .tabs-right { display: flex; gap: 2px; padding: 8px 12px 0; }
  .message { padding: 20px 24px; margin: 0; }
  .body > .message { flex: 1; min-width: 0; }
  .muted { color: var(--text-muted); }
  .error { color: var(--in-error); white-space: pre-wrap; word-break: break-word; }
  .veil { position: absolute; inset: 0; z-index: 10; display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: var(--veil); backdrop-filter: blur(6px); }
  .request form { display: flex; flex-direction: column; gap: 12px; }
  .request { width: 340px; max-width: calc(100% - 32px); padding: 18px 20px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass-dense); box-shadow: var(--modal-shadow); font-size: 13px; animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .request label { display: flex; flex-direction: column; gap: 6px; }
  .request input { padding: 7px 9px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: inherit; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons button:disabled { opacity: 0.5; }
</style>
