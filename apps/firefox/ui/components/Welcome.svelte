<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { AURA_IDS, AURAS, auraVariables, type AuraId } from "../../shared/aura";
  import type { ImportSource, SettingsApi } from "../../shared/api";
  import { SEARCH_MODEL, type DockerStatus, type MachineStatus } from "../../shared/settings";
  import { AGENT_CLIS, VM_IMAGE_BYTES, aboutMb } from "../../shared/downloads";
  import { SEARCH_ENGINES, type SearchEngine } from "../../shared/search";
  import { APPEARANCES } from "../../shared/model";
  import { shortcutLabel } from "../../shared/shortcuts";
  import type { WindowState } from "../../shared/model";
  import { aiOn, api, appState } from "../state.svelte";
  import { t, tAround } from "../i18n.svelte";
  import AuraDot from "./AuraDot.svelte";
  import BrowserImport from "./BrowserImport.svelte";
  import SidebarSketch from "./SidebarSketch.svelte";
  import { welcomeStep as step } from "./welcome-step.svelte";

  /**
   * The first-launch welcome: nine pages on the aura, then the browser. Nothing is saved before « Ouvrir le navigateur »,
   * except an import from another browser, started on page 2, the appearance (page 9, shown at once), and the tier chosen on page 4: « IA » turns
   * AI on at once, since the agent and search pages need the host's AI side. The welcome never offers the lab.
   * Mode `ai` (the AI setup, from « Activer l'IA »): the Docker and local AI pages alone, ending on « Terminer ».
   * An install link steps it aside (unmounted, its page kept in `step`): coming back checks the page's state again.
   */
  let { window: win, mode = "full" }: { window: WindowState; mode?: "full" | "ai" } = $props();

  // Only a replay: a first welcome left after « IA » (AI on, nothing finished) asks again at the next launch.
  if (step.aiAtStart === undefined) step.aiAtStart = !!appState.value?.welcomeReplay && aiOn();
  /**
   * Page numbers shown, in order (8 the search engine and 9 the appearance were added after the others): « Navigateur » on page 4, or AI
   * already on at a replay, skips the AI pages 5-6.
   */
  const pages = $derived(mode === "ai" ? [5, 6] : step.aiAtStart ? [1, 2, 3, 8, 9, 7] : aiOn() ? [1, 2, 3, 8, 9, 4, 5, 6, 7] : [1, 2, 3, 8, 9, 4, 7]);
  // A first launch proposes DuckDuckGo; a replay starts on the engine in use.
  step.engine ??= untrack(() => (appState.value?.welcomeReplay ? appState.value.settings.engine : "duckduckgo"));
  const ENGINES = Object.entries(SEARCH_ENGINES) as [Exclude<SearchEngine, "custom">, { label: string }][];
  const page = $derived(pages.includes(step.page) ? step.page : pages[0]!);
  const at = $derived(pages.indexOf(page));
  const AGENTS = [["claude", "Claude Code"], ["codex", "Codex"]] as const;
  const space = $derived(appState.value?.spaces.find((s) => s.id === win.activeSpace));
  const label = (id: "command" | "agent") => shortcutLabel(id, appState.value?.settings);
  const profile = $derived(appState.value?.settings.agentProfile);
  // A replay starts on the tier in use; a first launch on none, so that « Continuer » waits for a choice.
  step.tier ??= untrack(() => (appState.value?.welcomeReplay ? (aiOn() ? "ai" : "browser") : undefined));
  const mb = (bytes: number) => t("agent-size-mb", { n: aboutMb(bytes) });
  // A custom profile shows Claude Code's size: both CLIs weigh about the same.
  const sizes = $derived({ machine: mb(VM_IMAGE_BYTES), agent: mb(AGENT_CLIS[profile === "codex" ? "codex" : "claude"].bytes) });
  let name = $state(untrack(() => space?.name ?? ""));
  let aura = $state<AuraId>(untrack(() => space?.aura ?? "aube"));

  /** undefined: checking; null: the host does not answer. */
  let docker = $state<Awaited<ReturnType<SettingsApi["workshop"]>> | undefined>(undefined);
  /** undefined: checking. */
  let models = $state<boolean | undefined>(undefined);
  /** Ressac's local models still missing; the download runs in the host and goes on after the welcome closes. */
  let missing = $state<string[]>([]);
  let pulling = $state(false);
  let pullError = $state<string | null>(null);
  /** undefined: being read; empty: no other browser, so no « Plus tard ». */
  let sources = $state<ImportSource[] | undefined>(undefined);
  /** Set while Docker is missing: tells an installed app that is stopped from none at all. */
  let dockerApp = $state<DockerStatus | null>(null);
  let dockerError = $state<string | null>(null);
  async function checkDocker() {
    docker = undefined;
    const state = await api.settings.workshop();
    dockerApp = state === "docker-absent" ? await api.settings.docker() : null;
    docker = state;
  }
  async function startDocker() {
    docker = undefined;
    const r = await api.settings.startDocker();
    await checkDocker();
    dockerError = r.ok ? null : r.error;
  }
  /** Ressac's workshop machine; null where it cannot run (or the host is silent): the Docker texts. */
  let machine = $state<MachineStatus | null>(null);
  const loadMachine = async () => {
    const m = await api.settings.machine();
    machine = m && m.kind !== "unsupported" ? m : null;
  };
  $effect(() => void loadMachine());
  // Followed while the agent or AI page shows it on its way.
  $effect(() => {
    if ((page !== 5 && page !== 6) || !machine || machine.kind === "running" || machine.kind === "stopped" || machine.kind === "error") return;
    const timer = setInterval(() => void loadMachine(), 2_000);
    return () => clearInterval(timer);
  });
  async function checkModels() {
    models = undefined;
    const [ai, running] = await Promise.all([api.ai.state().catch(() => undefined), api.settings.pullProgress()]);
    const v = ai?.verification;
    // AI on already starts the missing models' download: shown as started, not offered again.
    pulling = !!running;
    missing = v && !running ? v.embed ? [] : [SEARCH_MODEL] : [];
    models = !!v;
  }
  async function pullInBackground(names = missing) {
    if (profile) api.agent.prepareCli(profile);
    const r = await api.settings.pullInBackground(names);
    pulling = r.ok;
    pullError = r.ok ? null : r.error;
  }
  // Each state is checked when its page first shows (only after « Oui »: no Docker or AI call while AI is off).
  let checked = { docker: false, models: false };
  // Each show of the search page starts the chosen agent's CLI too: one shared download in the host, so a repeat is free.
  $effect(() => {
    if (page === 6 && profile) api.agent.prepareCli(profile);
  });
  $effect(() => {
    if (page === 5 && !checked.docker) {
      checked.docker = true;
      void checkDocker();
    }
    if (page === 6 && !checked.models) {
      checked.models = true;
      void checkModels();
    }
  });

  const next = () => (step.page = pages[Math.min(pages.length - 1, at + 1)]!);
  const back = () => (step.page = pages[Math.max(0, at - 1)]!);
  function answer(yes: boolean) {
    if (yes !== aiOn()) api.dispatch({ type: yes ? "enableAi" : "disableAi" });
    step.page = yes ? 5 : 7;
  }
  const TIERS = [["browser", "home-welcome-tier-browser"], ["ai", "home-welcome-tier-ai"]] as const;
  /** The download page opens in a tab, and the welcome steps aside so that it shows. */
  function install(url: string) {
    api.settings.openUrl(url);
    step.aside = true;
  }
  /** Each page's main button takes the keyboard as it appears. */
  const focus = (el: HTMLElement) => el.focus({ preventScroll: true });
  /** Page 4 before a choice: « Continuer » is disabled, so the first card takes the keyboard. */
  const focusIf = (el: HTMLElement, on: boolean) => void (on && focus(el));

  function finish(e: SubmitEvent) {
    e.preventDefault();
    const s = space;
    const n = name.trim();
    if (s && ((n && n !== s.name) || aura !== s.aura)) api.dispatch({ type: "updateSpace", id: s.id, name: n || s.name, icon: s.icon, private: s.private, profile: s.profile, aura });
    if (step.engine && step.engine !== appState.value?.settings.engine) api.dispatch({ type: "chooseEngine", engine: step.engine });
    api.dispatch(step.aiAtStart ? { type: "finishOnboarding" } : { type: "finishOnboarding", ai: aiOn() });
  }
</script>

{#snippet actions(label: string, later: boolean, onNext = next, onLater = next, ready = true)}
  <div class="actions">
    {#if at > 0}<button type="button" class="quiet" data-testid="welcome-back" onclick={back}>{t("home-welcome-back")}</button>{/if}
    <span class="grow"></span>
    {#if later}<button type="button" class="quiet" data-testid="welcome-later" onclick={onLater}>{t("home-welcome-later")}</button>{/if}
    <button type="button" class="primary" data-testid="welcome-next" disabled={!ready} use:focus onclick={onNext}>{label}</button>
  </div>
{/snippet}

{#snippet status(id: string, tone: string, text: string)}
  <p class="status" data-testid={id} data-tone={tone} role="status">{text}</p>
{/snippet}

{#snippet machineLine(m: MachineStatus)}
  {@const ready = m.kind === "running" || m.kind === "stopped"}
  <!-- One element whose text follows the status: it rises in once and fades out when the page stops showing it. -->
  <p class="status appear" data-testid="welcome-machine" data-tone={ready ? "ok" : "warn"} role="status" out:fade={{ duration: 150 }}>{m.kind === "error" ? m.message : ready ? t("home-welcome-machine-ready") : m.kind === "downloading" && m.percent !== null ? t("home-welcome-machine-downloading", { percent: m.percent }) : t("home-welcome-machine-preparing")}</p>
{/snippet}

<div class="welcome" style={Object.entries(auraVariables(aura)).map(([k, v]) => `${k}:${v}`).join(";")}>
  <div class="aura" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="panel" role="dialog" aria-modal="true" aria-label={t("home-welcome-label")}>
    {#key page}
      <section class="page" data-testid="welcome-{page}">
        {#if page === 1}
          <div class="hero">
            <img src="chrome://branding/content/about-logo.svg" alt="" width="96" height="96" />
            <h1 class="brand">ressac</h1>
            <p class="lead">{t("home-welcome-tagline")}</p>
          </div>
          {@render actions(t("home-welcome-start"), false)}
        {:else if page === 2}
          <h2>{t("home-welcome-import-title")}</h2>
          <BrowserImport bind:sources />
          {@render actions(t("home-welcome-continue"), !!sources?.length)}
        {:else if page === 3}
          <h2>{t("home-welcome-sidebar-title")}</h2>
          <div class="sidebar">
            <SidebarSketch key={label("command")} />
            <ul>
              <li>{t("home-welcome-sidebar-tabs")}</li>
              <li>{t("home-welcome-sidebar-spaces")}</li>
              <li><kbd>{label("command")}</kbd> {t("home-welcome-sidebar-command")}</li>
            </ul>
          </div>
          {@render actions(t("home-welcome-next"), false)}
        {:else if page === 8}
          <h2>{t("home-welcome-engine-title")}</h2>
          <p>{t("home-welcome-engine-intro")}</p>
          <div class="engines" role="radiogroup" aria-label={t("home-welcome-engine-group")}>
            {#each ENGINES as [id, e] (id)}
              <label class="agent">
                <input type="radio" name="welcome-engine" data-testid="welcome-engine-{id}" checked={step.engine === id} onchange={() => (step.engine = id)} />
                {e.label}
              </label>
            {/each}
          </div>
          <p class="note">{t("home-welcome-engine-later")}</p>
          {@render actions(t("home-welcome-next"), false)}
        {:else if page === 9}
          <h2>{t("home-welcome-appearance-title")}</h2>
          <div class="engines" role="radiogroup" aria-label={t("settings-appearance-label")}>
            {#each APPEARANCES as appearance (appearance)}
              <label class="agent">
                <input type="radio" name="welcome-appearance" data-testid="welcome-appearance-{appearance}" checked={(appState.value?.settings.appearance ?? "system") === appearance} onchange={() => api.dispatch({ type: "chooseAppearance", appearance })} />
                {t(`settings-appearance-${appearance}`)}
              </label>
            {/each}
          </div>
          <p class="note">{t("home-welcome-appearance-later")}</p>
          {@render actions(t("home-welcome-next"), false)}
        {:else if page === 4}
          <h2>{t("home-welcome-tier-title")}</h2>
          <div class="tiers" role="radiogroup" aria-label={t("home-welcome-tier-title")}>
            {#each TIERS as [id, key], i (id)}
              <label class="agent tier" data-testid="welcome-tier-{id}-card">
                <input type="radio" name="welcome-tier" data-testid="welcome-tier-{id}" aria-labelledby="welcome-tier-{id}-title" aria-describedby="welcome-tier-{id}-detail" checked={step.tier === id} onchange={() => (step.tier = id)} use:focusIf={!step.tier && i === 0} />
                <span class="tier-text">
                  <b id="welcome-tier-{id}-title">{t(key)}</b>
                  <span id="welcome-tier-{id}-detail">{t(`${key}-detail`)}{#if id === "ai"}<span class="note">{t(machine ? "home-welcome-tier-ai-needs-machine" : "home-welcome-tier-ai-needs", sizes)}</span>{/if}</span>
                </span>
              </label>
            {/each}
          </div>
          <p class="note" data-testid="welcome-tier-later">{t("home-welcome-tier-later")}</p>
          {@render actions(t("home-welcome-continue"), false, () => answer(step.tier === "ai"), undefined, !!step.tier)}
        {:else if page === 5}
          <h2>{t("home-welcome-agent-title")}</h2>
          <p>{t(machine ? "home-welcome-agent-intro-machine" : "home-welcome-agent-intro", sizes)}</p>
          <div class="check">
            {#if machine}
              {@render machineLine(machine)}
            {:else if docker === undefined}
              {@render status("welcome-docker", "warn", t("home-welcome-checking"))}
            {:else if docker === "docker-absent" && dockerApp?.kind === "stopped"}
              {@render status("welcome-docker", "warn", dockerError ?? t("home-welcome-docker-stopped", { app: dockerApp.app }))}
              <button type="button" data-testid="welcome-start-docker" onclick={() => void startDocker()}>{t("home-welcome-docker-start", { app: dockerApp.app })}</button>
            {:else if docker === "docker-absent"}
              {@render status("welcome-docker", "warn", t("home-welcome-docker-absent"))}
              <button type="button" data-testid="welcome-install-docker" onclick={() => install("https://orbstack.dev/download")}>{t("home-welcome-docker-install")}</button>
              <button type="button" data-testid="welcome-recheck" onclick={() => void checkDocker()}>{t("home-welcome-recheck")}</button>
            {:else if docker === null}
              {@render status("welcome-docker", "off", t("home-welcome-docker-unreachable"))}
              <button type="button" data-testid="welcome-recheck" onclick={() => void checkDocker()}>{t("home-welcome-recheck")}</button>
            {:else}
              {@render status("welcome-docker", "ok", t("home-welcome-docker-ready"))}
            {/if}
          </div>
          <div class="agents" role="radiogroup" aria-label={t("home-welcome-agent-group")}>
            {#each AGENTS as [id, label] (id)}
              <label class="agent">
                <input type="radio" name="welcome-agent" data-testid="welcome-agent-{id}" checked={profile === id} onchange={() => void api.agent.switch(id)} />
                {label}
              </label>
            {/each}
          </div>
          {#if docker && docker !== "docker-absent"}{@const [before, after] = tAround("home-welcome-agent-login", "key")}<p class="note">{before}<kbd>{label("agent")}</kbd>{after}</p>{/if}
          {@render actions(t("home-welcome-continue"), true)}
        {:else if page === 6}
          <h2>{t("home-welcome-ai-title")}</h2>
          <p>{t("home-welcome-ai-intro")}</p>
          <p class="note">{t("home-welcome-ai-triage")}</p>
          <div class="check">
            {#if machine && machine.kind !== "running" && machine.kind !== "stopped"}{@render machineLine(machine)}{/if}
            {#if models === undefined}
              {@render status("welcome-models", "warn", t("home-welcome-checking"))}
            {:else if !models}
              {@render status("welcome-models", "off", t("home-welcome-models-unreachable"))}
              <button type="button" data-testid="welcome-recheck" onclick={() => void checkModels()}>{t("home-welcome-recheck")}</button>
            {:else if pulling}
              {@render status("welcome-models", "ok", t("home-welcome-models-started"))}
            {:else if missing.length}
              {@render status("welcome-models", "warn", pullError ?? t("home-welcome-models-missing"))}
              <button type="button" data-testid="welcome-pull" onclick={() => void pullInBackground()}>{t("home-welcome-models-pull")}</button>
            {:else}
              {@render status("welcome-models", "ok", t("home-welcome-models-ready"))}
            {/if}
          </div>
          {#if mode === "ai"}
            {@render actions(t("home-welcome-done"), false, () => api.dispatch({ type: "finishAiSetup" }))}
          {:else}
            {@render actions(t("home-welcome-continue"), true)}
          {/if}
        {:else}
          <form onsubmit={finish}>
            <h2>{t("home-welcome-ready-title")}</h2>
            <label class="label" for="welcome-space-name">{t("home-welcome-space-label")}</label>
            <input id="welcome-space-name" data-testid="welcome-space-name" bind:value={name} placeholder={space?.name} />
            <div class="auras" role="radiogroup" aria-label={t("home-welcome-aura-group")}>
              {#each AURA_IDS as id (id)}
                <button type="button" class="aura-choice" role="radio" aria-checked={aura === id} aria-label={t("home-welcome-aura-choice", { name: AURAS[id].name })} title={AURAS[id].name} data-testid="welcome-aura-{id}" onclick={() => (aura = id)}>
                  <AuraDot aura={id} size={22} />
                </button>
              {/each}
            </div>
            <div class="check">
              <p class="note">{t("home-welcome-notifications-note")}</p>
              <button type="button" data-testid="welcome-notifications" onclick={() => api.settings.openNotificationSettings()}>{t("home-welcome-notifications-open")}</button>
            </div>
            <div class="actions">
              <button type="button" class="quiet" data-testid="welcome-back" onclick={back}>{t("home-welcome-back")}</button>
              <span class="grow"></span>
              <button type="submit" class="primary" data-testid="welcome-finish" use:focus>{t("home-welcome-finish")}</button>
            </div>
          </form>
        {/if}
      </section>
    {/key}
    <ol class="dots" aria-label={t("home-welcome-page", { page: at + 1, total: pages.length })}>
      {#each pages as p, i (p)}<li aria-hidden="true" class:current={i === at}></li>{/each}
    </ol>
  </div>
</div>

<style>
  /* The accent follows the aura shown here (set inline: the first space's, previewed on the last page). */
  .welcome {
    --accent: var(--aura-accent-dark);
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--bg);
    /* Not a scroll container: the aura's lights overflow it, and a focus would scroll the panel off centre. */
    overflow: clip;
    transition: --a1 var(--aura-d), --a2 var(--aura-d), --a3 var(--aura-d);
    -moz-window-dragging: drag;
  }
  @media (prefers-color-scheme: light) { .welcome { --accent: var(--aura-accent-light); } }
  @media (prefers-reduced-motion: reduce) { .welcome { transition: none; } }
  /* The window's aura (window.css), painted here too: the welcome covers the page and the agent panel. */
  .aura { position: absolute; inset: 0; }
  .aura i { position: absolute; width: 66%; aspect-ratio: 1; border-radius: 50%; filter: blur(70px) saturate(1.15); opacity: 0.95; }
  @media (prefers-color-scheme: dark) { .aura i { filter: blur(80px) saturate(1.45); opacity: 0.55; } }
  .aura i:nth-child(1) { background: var(--a1); left: -8%; top: -16%; }
  .aura i:nth-child(2) { background: var(--a2); right: -20%; top: 2%; }
  .aura i:nth-child(3) { background: var(--a3); left: 14%; bottom: -27%; }

  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(520px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 30px 32px 18px;
    border: 1px solid var(--glass-edge);
    border-radius: 18px;
    background: var(--glass);
    backdrop-filter: blur(30px) saturate(1.6);
    box-shadow: var(--modal-shadow);
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
    -moz-window-dragging: no-drag;
    animation: ressac-drop var(--spring-d) var(--spring) backwards;
  }
  .page { display: flex; flex-direction: column; gap: 14px; min-height: 352px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  form { display: contents; }
  h2 { margin: 0; font: 600 26px/1.15 var(--font-display); letter-spacing: -0.02em; }
  p { margin: 0; }
  .note { color: var(--text-muted); font-size: 13px; }

  .hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 8px 0 4px; }
  .hero img { width: 96px; height: 96px; filter: drop-shadow(var(--modal-shadow)); }
  .brand { margin: 6px 0 0; font: 600 44px/1 var(--font-display); letter-spacing: -0.03em; }
  .lead { max-width: 30ch; color: var(--text-muted); font-size: 15px; }

  .tiers { display: flex; flex-direction: column; gap: 8px; }
  .tier { align-items: flex-start; padding: 12px 14px; border-radius: 16px; font-weight: 400; }
  .tier input { margin-top: 3px; }
  .tier-text { display: flex; flex-direction: column; gap: 4px; }
  .tier b { font-weight: 600; }
  .tier .note { display: block; margin-top: 4px; }

  .sidebar { display: flex; align-items: center; gap: 22px; }
  .sidebar ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 12px; }
  .sidebar li { padding-left: 14px; border-left: 2px solid color-mix(in oklab, var(--accent) 60%, transparent); }

  .check { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 16px; background: var(--glass-hi); border: 1px solid var(--glass-edge); }
  /* A state: a dot of its tone and the text. */
  /* The state on its own line, its buttons under it. */
  .status { --tone: var(--stopped); flex-basis: 100%; display: inline-flex; align-items: center; gap: 8px; }
  .status::before { content: ""; width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--tone); }
  .status[data-tone="ok"] { --tone: var(--running); }
  .appear { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .status[data-tone="warn"] { --tone: var(--in-progress); }
  .grow { flex: 1; }

  .agents { display: flex; gap: 8px; }
  .engines { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .agent { flex: 1; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--glass-hi); font-weight: 600; transition: border-color var(--tap), transform var(--tap); }
  .agent:has(:checked) { border-color: var(--accent); }
  .agent:active { transform: scale(0.97); }
  /* macOS draws native radios in the system blue: ours, in the accent. */
  .agent input { appearance: none; width: 15px; height: 15px; margin: 0; flex: none; border-radius: 50%; border: 1px solid var(--border); background: var(--glass-hi); transition: border-width var(--spring-d) var(--spring); }
  .agent input:checked { border: 4.5px solid var(--accent); background: var(--accent-ink); }

  .label { color: var(--text-muted); font-size: 13px; }
  input:not([type="radio"]) { padding: 9px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 15px var(--font-ui); }
  .auras { display: flex; gap: 10px; }
  .aura-choice { padding: 3px; border-radius: 50%; border: 2px solid transparent; background: none; line-height: 0; transition: transform var(--tap), border-color var(--tap); }
  .aura-choice :global(*) { transition: transform var(--spring-d) var(--spring); }
  .aura-choice:hover :global(*) { transform: scale(1.1); }
  .aura-choice[aria-checked="true"] { border-color: var(--accent); }

  .actions { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 10px; }
  button { padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 13px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  button.quiet { border-color: transparent; background: none; color: var(--text-muted); }
  button.quiet:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  button.primary { padding-inline: 18px; background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.primary:hover:not(:disabled) { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
  .aura-choice:hover, .aura-choice:active { background: none; }
  :is(button, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .dots { display: flex; justify-content: center; gap: 6px; margin: 16px 0 0; padding: 0; list-style: none; }
  .dots li { width: 6px; height: 6px; border-radius: 3px; background: color-mix(in oklab, var(--text) 22%, transparent); transition: width var(--spring-d) var(--spring), background var(--tap); }
  .dots li.current { width: 18px; background: var(--accent); }
</style>
