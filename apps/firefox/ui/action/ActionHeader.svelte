<script lang="ts">
  import type { Execution, ResumeExecution } from "@webaios/kernel";

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

  const FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const hour = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : FORMAT.format(d);
  };
  const STATUSES: Record<Execution["status"], string> = {
    succeeded: "réussie",
    partial: "partielle",
    failed: "échouée",
    interrupted: "interrompue",
    "grant-required": "accord requis",
  };

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
      {alreadyLaunched ? "Relancer" : "Lancer"}
    </button>
    <button data-testid="show-workflow" onclick={seeWorkflow}>Voir le workflow</button>
    {#if start}<span class="time" data-testid="result-time">{hour(start)}</span>{/if}
    {#if previous && previous.length > 0}
      <div class="previous">
        <button data-testid="previous-results" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
          Résultats précédents
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
                <span class="status {e.status}">{STATUSES[e.status]}</span>
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
  h1 { margin: 0; font-size: 18px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .commands { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
  .input { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .input input { width: 180px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-bar); color: var(--text); font: inherit; }
  .input input:focus { outline: none; border-color: var(--accent); }
  button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-bar); color: var(--text); font: inherit; }
  button:hover:not(:disabled) { background: var(--bg-hover); }
  button:disabled { opacity: 0.5; }
  .main { background: var(--accent); border-color: var(--accent); color: white; }
  .main:hover:not(:disabled) { background: var(--accent); filter: brightness(1.1); }
  .time { color: var(--text-muted); font-size: 12px; }
  .previous { position: relative; }
  .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; display: flex; flex-direction: column; min-width: 260px; max-height: 320px; overflow-y: auto; padding: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-bar); box-shadow: var(--modal-shadow); }
  .menu button { display: flex; gap: 8px; align-items: baseline; border: none; background: none; text-align: left; white-space: nowrap; }
  .menu button:hover { background: var(--bg-hover); }
  .muted { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
  .status { margin-left: auto; font-size: 12px; color: var(--text-muted); }
  .status.failed, .status.interrupted, .status.grant-required { color: var(--in-error); }
</style>
