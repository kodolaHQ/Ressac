<script lang="ts">
  import type { Execution, ResumeExecution } from "@ressac/kernel";
  import { t } from "../i18n.svelte";
  import { appState } from "../state.svelte";

  /**
   * An action page's header: its name, its input, « Relancer » (« Lancer » when there is no result yet), « Voir le
   * workflow », the time of the shown result and the menu of previous results. Nothing is launched without a click (or Enter).
   */
  let {
    name: name,
    input: input = $bindable(""),
    inputLabel: inputLabel,
    start: start,
    busy: busy,
    alreadyLaunched: alreadyLaunched,
    previous: previous,
    launch: launch,
    viewWorkflow: seeWorkflow,
    choose: choose,
  }: {
    name: string;
    /** The field's text, pre-filled with the shown result's input. */
    input?: string;
    /** Label of the declared input; null: the action has none. */
    inputLabel: string | null;
    /** Start of the shown run; null: none. */
    start: string | null;
    /** A run of the action is running or waiting: no second launch. */
    busy: boolean;
    alreadyLaunched: boolean;
    /** Kept runs (not the trials), most recent first; null until read. */
    previous: ResumeExecution[] | null;
    launch: () => void;
    viewWorkflow: () => void;
    choose: (execution: string) => void;
  } = $props();

  let menuOpen = $state(false);
  const missingInput = $derived(inputLabel !== null && input.trim() === "");

  const hour = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(appState.value?.locale ?? "fr", { dateStyle: "medium", timeStyle: "short" }).format(d);
  };
  const status = (s: Execution["status"]) => t(`builder-status-lower-${s}`);

  function validate() {
    if (!busy && !missingInput) launch();
  }

  // The menu closes on a click elsewhere and on Escape.
  $effect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element | null)?.closest?.(".previous")) menuOpen = false;
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  });
</script>

<header class="header">
  <h1 data-testid="action-title">{name}</h1>
  <div class="commands">
    {#if inputLabel !== null}
      <label class="input">
        <span>{inputLabel}</span>
        <input
          data-testid="action-input-box"
          bind:value={input}
          maxlength="200"
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              validate();
            }
          }}
        />
      </label>
    {/if}
    <button class="main" data-testid="relaunch-action" disabled={busy || missingInput} onclick={validate}>
      {t(alreadyLaunched ? "action-relaunch" : "action-launch")}
    </button>
    <button data-testid="show-workflow" onclick={seeWorkflow}>{t("action-show-workflow")}</button>
    {#if start}<span class="time" data-testid="result-time">{hour(start)}</span>{/if}
    {#if previous && previous.length > 0}
      <div class="previous">
        <button data-testid="previous-results" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
          {t("action-previous")}
        </button>
        {#if menuOpen}
          <div class="menu" role="menu">
            {#each previous as e (e.id)}
              <button
                role="menuitem"
                data-testid="result-{e.id}"
                onclick={() => {
                  menuOpen = false;
                  choose(e.id);
                }}
              >
                <span>{hour(e.start)}</span>
                {#if e.input}<span class="muted">{e.input}</span>{/if}
                <span class="status {e.status}">{status(e.status)}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</header>

<style>
  .header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; max-width: 960px; margin: 0 auto; padding: 20px 24px 0; color: var(--text); }
  h1 { margin: 0; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; min-width: 0; overflow-wrap: anywhere; }
  .commands { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
  .input { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .input input { width: 180px; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: inherit; }
  .input input:focus { outline: none; border-color: var(--accent); }
  button { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  .main { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .main:hover:not(:disabled) { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
  .time { color: var(--text-muted); font-size: 12px; }
  .previous { position: relative; }
  .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; display: flex; flex-direction: column; min-width: 260px; max-height: 320px; overflow-y: auto; padding: 4px; border: 1px solid var(--glass-edge); border-radius: 12px; background: var(--glass-dense); box-shadow: var(--modal-shadow); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .menu button { display: flex; gap: 8px; align-items: baseline; border: none; background: none; text-align: left; white-space: nowrap; }
  .menu button:hover { background: var(--bg-hover); }
  .muted { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
  .status { margin-left: auto; font-size: 12px; color: var(--text-muted); }
  .status.failed, .status.interrupted, .status.grant-required { color: var(--in-error); }
</style>
