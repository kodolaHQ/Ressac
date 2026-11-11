<script lang="ts">
  import { untrack } from "svelte";
  import { AURA_IDS, AURAS, auraVariables, type AuraId } from "../../shared/aura";
  import type { SettingsApi } from "../../shared/api";
  import type { WindowState } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import AuraDot from "./AuraDot.svelte";
  import SidebarSketch from "./SidebarSketch.svelte";
  import { welcomeStep as step } from "./welcome-step.svelte";

  /**
   * The first-launch welcome: five pages on the aura, then the browser. Nothing is done before « Ouvrir le navigateur ».
   * An install link steps it aside (unmounted, its page kept in `step`): coming back checks Docker and Ollama again.
   */
  let { window: win }: { window: WindowState } = $props();

  const PAGES = 5;
  const AGENTS = [["claude", "Claude Code"], ["codex", "Codex"]] as const;
  const space = $derived(appState.value?.spaces.find((s) => s.id === win.activeSpace));
  const profile = $derived(appState.value?.settings.agentProfile);
  let name = $state(untrack(() => space?.name ?? ""));
  let aura = $state<AuraId>(untrack(() => space?.aura ?? "aube"));

  /** undefined: checking; null: the host does not answer. */
  let docker = $state<Awaited<ReturnType<SettingsApi["workshop"]>> | undefined>(undefined);
  let ollama = $state<boolean | undefined>(undefined);
  async function checkDocker() {
    docker = undefined;
    docker = await api.settings.workshop();
  }
  async function checkOllama() {
    ollama = undefined;
    ollama = await api.ai.state().then((s) => !!s.verification?.ollama, () => false);
  }
  $effect(() => {
    void checkDocker();
    void checkOllama();
  });

  const next = () => (step.page = Math.min(PAGES, step.page + 1));
  const back = () => (step.page = Math.max(1, step.page - 1));
  /** The download page opens in a tab, and the welcome steps aside so that it shows. */
  function install(url: string) {
    api.settings.openUrl(url);
    step.aside = true;
  }
  /** Each page's main button takes the keyboard as it appears. */
  const focus = (el: HTMLElement) => el.focus({ preventScroll: true });

  function finish(e: SubmitEvent) {
    e.preventDefault();
    const s = space;
    const n = name.trim();
    if (s && ((n && n !== s.name) || aura !== s.aura)) api.dispatch({ type: "updateSpace", id: s.id, name: n || s.name, icon: s.icon, private: s.private, profile: s.profile, aura });
    api.dispatch({ type: "finishOnboarding" });
  }
</script>

{#snippet actions(label: string, later: boolean)}
  <div class="actions">
    {#if step.page > 1}<button type="button" class="quiet" data-testid="welcome-back" onclick={back}>Retour</button>{/if}
    <span class="grow"></span>
    {#if later}<button type="button" class="quiet" data-testid="welcome-later" onclick={next}>Plus tard</button>{/if}
    <button type="button" class="primary" data-testid="welcome-next" use:focus onclick={next}>{label}</button>
  </div>
{/snippet}

{#snippet status(id: string, tone: string, text: string)}
  <p class="status" data-testid={id} data-tone={tone} role="status">{text}</p>
{/snippet}

<div class="welcome" style={Object.entries(auraVariables(aura)).map(([k, v]) => `${k}:${v}`).join(";")}>
  <div class="aura" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="panel" role="dialog" aria-modal="true" aria-label="Bienvenue dans WebAiOs">
    {#key step.page}
      <section class="page" data-testid="welcome-{step.page}">
        {#if step.page === 1}
          <div class="hero">
            <img src="chrome://branding/content/about-logo.svg" alt="" width="96" height="96" />
            <h1 class="brand">webaios</h1>
            <p class="lead">Un navigateur calme, avec un agent quand vous le voulez.</p>
          </div>
          {@render actions("Commencer", false)}
        {:else if step.page === 2}
          <h2>Vos onglets vivent à gauche</h2>
          <div class="sidebar">
            <SidebarSketch />
            <ul>
              <li>Les onglets de l'espace en cours, en liste.</li>
              <li>Les espaces en bas : un par sujet, chacun avec son aura.</li>
              <li><kbd>⌘T</kbd> ouvre un onglet ou cherche partout.</li>
            </ul>
          </div>
          {@render actions("Suivant", false)}
        {:else if step.page === 3}
          <h2>Brancher un agent</h2>
          <p>Claude Code et Codex travaillent dans un conteneur à part, sur votre Mac. Il leur faut OrbStack (ou Docker Desktop).</p>
          <div class="check">
            {#if docker === undefined}
              {@render status("welcome-docker", "warn", "Vérification…")}
            {:else if docker === "docker-absent"}
              {@render status("welcome-docker", "warn", "OrbStack n'est pas lancé ou pas installé.")}
              <button type="button" data-testid="welcome-install-docker" onclick={() => install("https://orbstack.dev/download")}>Installer OrbStack</button>
              <button type="button" data-testid="welcome-recheck" onclick={() => void checkDocker()}>Vérifier à nouveau</button>
            {:else if docker === null}
              {@render status("welcome-docker", "off", "Impossible de vérifier pour l'instant.")}
              <button type="button" data-testid="welcome-recheck" onclick={() => void checkDocker()}>Vérifier à nouveau</button>
            {:else}
              {@render status("welcome-docker", "ok", "Docker est prêt.")}
            {/if}
          </div>
          <div class="agents" role="radiogroup" aria-label="Agent">
            {#each AGENTS as [id, label] (id)}
              <label class="agent">
                <input type="radio" name="welcome-agent" data-testid="welcome-agent-{id}" checked={profile === id} onchange={() => void api.agent.switch(id)} />
                {label}
              </label>
            {/each}
          </div>
          {#if docker && docker !== "docker-absent"}<p class="note">Vous vous connecterez la première fois que vous ouvrirez l'agent (<kbd>⌘J</kbd>).</p>{/if}
          {@render actions("Continuer", true)}
        {:else if step.page === 4}
          <h2>L'IA locale</h2>
          <p>Avec Ollama, la veille et les décisions tournent sur votre Mac : rien ne part sur Internet.</p>
          <div class="check">
            {#if ollama === undefined}
              {@render status("welcome-ollama", "warn", "Vérification…")}
            {:else if ollama}
              {@render status("welcome-ollama", "ok", "Ollama est prêt.")}
            {:else}
              {@render status("welcome-ollama", "warn", "Ollama n'est pas installé ou pas lancé.")}
              <button type="button" data-testid="welcome-install-ollama" onclick={() => install("https://ollama.com/download")}>Installer Ollama</button>
              <button type="button" data-testid="welcome-recheck" onclick={() => void checkOllama()}>Vérifier à nouveau</button>
            {/if}
          </div>
          {@render actions("Continuer", true)}
        {:else}
          <form onsubmit={finish}>
            <h2>C'est prêt</h2>
            <label class="label" for="welcome-space-name">Votre premier espace</label>
            <input id="welcome-space-name" data-testid="welcome-space-name" bind:value={name} placeholder={space?.name} />
            <div class="auras" role="radiogroup" aria-label="Aura">
              {#each AURA_IDS as id (id)}
                <button type="button" class="aura-choice" role="radio" aria-checked={aura === id} aria-label="Aura {AURAS[id].name}" title={AURAS[id].name} data-testid="welcome-aura-{id}" onclick={() => (aura = id)}>
                  <AuraDot aura={id} size={22} />
                </button>
              {/each}
            </div>
            <div class="check">
              <p class="note">Pour recevoir les alertes des sites et de la veille, autorisez les notifications de WebAiOs dans les Réglages Système.</p>
              <button type="button" data-testid="welcome-notifications" onclick={() => api.settings.openNotificationSettings()}>Ouvrir les réglages de notifications</button>
            </div>
            <div class="actions">
              <button type="button" class="quiet" data-testid="welcome-back" onclick={back}>Retour</button>
              <span class="grow"></span>
              <button type="submit" class="primary" data-testid="welcome-finish" use:focus>Ouvrir le navigateur</button>
            </div>
          </form>
        {/if}
      </section>
    {/key}
    <ol class="dots" aria-label="Page {step.page} sur {PAGES}">
      {#each { length: PAGES } as _, i (i)}<li aria-hidden="true" class:current={i + 1 === step.page}></li>{/each}
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
    animation: webaios-drop var(--spring-d) var(--spring) backwards;
  }
  .page { display: flex; flex-direction: column; gap: 14px; min-height: 352px; animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  form { display: contents; }
  h2 { margin: 0; font: 600 26px/1.15 var(--font-display); letter-spacing: -0.02em; }
  p { margin: 0; }
  .note { color: var(--text-muted); font-size: 13px; }

  .hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 8px 0 4px; }
  .hero img { width: 96px; height: 96px; filter: drop-shadow(var(--modal-shadow)); }
  .brand { margin: 6px 0 0; font: 600 44px/1 var(--font-display); letter-spacing: -0.03em; }
  .lead { max-width: 30ch; color: var(--text-muted); font-size: 15px; }

  .sidebar { display: flex; align-items: center; gap: 22px; }
  .sidebar ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 12px; }
  .sidebar li { padding-left: 14px; border-left: 2px solid color-mix(in oklab, var(--accent) 60%, transparent); }

  .check { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 16px; background: var(--glass-hi); border: 1px solid var(--glass-edge); }
  /* A state: a dot of its tone and the text. */
  /* The state on its own line, its buttons under it. */
  .status { --tone: var(--stopped); flex-basis: 100%; display: inline-flex; align-items: center; gap: 8px; }
  .status::before { content: ""; width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--tone); }
  .status[data-tone="ok"] { --tone: var(--running); }
  .status[data-tone="warn"] { --tone: var(--in-progress); }
  .grow { flex: 1; }

  .agents { display: flex; gap: 8px; }
  .agent { flex: 1; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--glass-hi); font-weight: 600; transition: border-color var(--tap), transform var(--tap); }
  .agent:has(:checked) { border-color: var(--accent); }
  .agent:active { transform: scale(0.97); }
  /* macOS draws native radios in the system blue: ours, in the accent. */
  .agent input { appearance: none; width: 15px; height: 15px; margin: 0; flex: none; border-radius: 50%; border: 1px solid var(--border); background: var(--glass-hi); transition: border-width var(--tap); }
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
  button:hover { background: var(--bg-active); }
  button:active { transform: scale(0.97); }
  button.quiet { border-color: transparent; background: none; color: var(--text-muted); }
  button.quiet:hover { background: var(--bg-hover); color: var(--text); }
  button.primary { padding-inline: 18px; background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.primary:hover { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
  .aura-choice:hover, .aura-choice:active { background: none; }
  :is(button, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .dots { display: flex; justify-content: center; gap: 6px; margin: 16px 0 0; padding: 0; list-style: none; }
  .dots li { width: 6px; height: 6px; border-radius: 3px; background: color-mix(in oklab, var(--text) 22%, transparent); transition: width var(--spring-d) var(--spring), background var(--tap); }
  .dots li.current { width: 18px; background: var(--accent); }
</style>
