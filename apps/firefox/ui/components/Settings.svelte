<script lang="ts" module>
  import type { IconName } from "./Icon.svelte";

  const SECTIONS = [
    { id: "agents", label: "Agents", icon: "agent" },
    { id: "ai", label: "IA locale", icon: "cpu" },
    { id: "workshop", label: "Conteneur", icon: "box" },
    { id: "permissions", label: "Permissions", icon: "key" },
    { id: "data", label: "Données", icon: "database" },
    { id: "privacy", label: "Vie privée", icon: "lock" },
    { id: "shortcuts", label: "Raccourcis", icon: "keyboard" },
    { id: "about", label: "À propos", icon: "info" },
  ] as const satisfies readonly { id: string; label: string; icon: IconName }[];
  type SectionId = (typeof SECTIONS)[number]["id"];
  // Module-level: the page is remounted on each tab switch and comes back to the last section seen.
  let current = $state<SectionId>("agents");
  /** Called before opening Réglages from elsewhere (the Extensions page): it lands on Agents. */
  export const showAgentsSection = () => (current = "agents");
</script>

<script lang="ts">
  import type { LocalAiStateShown, SettingsApi } from "../../shared/api";
  import { TELEMETRY_NOTICE, type AgentAccount, type DecisionModel, type LoginResult, type PullProgress, type WorkshopOperation } from "../../shared/settings";
  import { api, appState } from "../state.svelte";
  import Icon from "./Icon.svelte";
  import SettingsMozilla from "./SettingsMozilla.svelte";
  import SettingsEngine from "./SettingsEngine.svelte";
  import SettingsData from "./SettingsData.svelte";
  import SettingsPermissions from "./SettingsPermissions.svelte";
  import SettingsShortcuts from "./SettingsShortcuts.svelte";

  // Each section loads on its own: a slow Docker never holds the version or the data folder.
  const s = api.settings;
  type WorkshopState = NonNullable<Awaited<ReturnType<SettingsApi["workshop"]>>>;

  let agents = $state<AgentAccount[] | null>(null);
  /** Each account's sign-in in progress: null while the host starts it, then its code or its error. */
  let logins = $state<Record<string, LoginResult | null>>({});
  const loadAgents = async () => {
    agents = await s.agents();
    // A finished sign-in forgets its code: after a logout, the row offers Se connecter again.
    for (const a of agents) if (a.state === "logged-in") delete logins[a.id];
  };
  $effect(() => void loadAgents());
  // Claude signs in in the agent panel (which builds the workshop if needed), Codex by a code on OpenAI's site: re-read only while one is awaited (a Codex code shown, or Claude signed out).
  const signIn = (a: AgentAccount) => a.state === "logged-out" || a.state === "no-container";
  $effect(() => {
    if (!agents?.some((a) => signIn(a) && (a.login === "panel" || logins[a.id] !== undefined))) return;
    const t = setInterval(() => void loadAgents(), 5_000);
    return () => clearInterval(t);
  });
  function agentText(a: AgentAccount): string {
    switch (a.state) {
      case "logged-in":
        return a.account ? `Connecté (${a.account})` : "Connecté";
      case "logged-out":
        return "Non connecté";
      case "docker-absent":
        return "Docker n'est pas lancé : voir Conteneur.";
      case "no-container":
        return "L'atelier de l'agent n'est pas démarré : voir Conteneur.";
      case "error":
        return `Erreur : ${a.error ?? ""}`;
    }
  }
  function agentTone(a: AgentAccount): string {
    return a.state === "logged-in" ? "ok" : a.state === "logged-out" ? "off" : a.state === "error" ? "error" : "warn";
  }
  async function logout(id: string) {
    delete logins[id];
    agents = await s.logout(id);
  }
  async function login(id: string) {
    logins[id] = null;
    logins[id] = await s.login(id);
  }

  let ai = $state<LocalAiStateShown | null>(null);
  const model = $derived<DecisionModel>(appState.value?.settings.decisionModel ?? "pplx-decider-flash");
  const v = $derived(ai?.verification);
  const kevReady = $derived(!!v?.kev && !!v?.uv);
  // Re-read on a model change too: the host checks the model it was told to use.
  $effect(() => {
    void model;
    void api.ai.state().then((r) => (ai = r));
  });

  // Model downloads: the host runs one at a time and reports it; polled like the workshop operation.
  let pulling = $state<PullProgress | null>(null);
  let pullError = $state<string | null>(null);
  const reloadAi = () => void api.ai.state().then((r) => (ai = r));
  async function pullModel(name: string) {
    pullError = null;
    pulling = { name, percent: null, status: "" };
    const timer = setInterval(() => void s.pullProgress().then((p) => p && (pulling = p)), 700);
    const r = await s.pullModel(name);
    clearInterval(timer);
    pulling = null;
    if (!r.ok) pullError = r.error;
    reloadAi();
  }
  // A pull started elsewhere (the welcome, another window) shows here until it ends.
  $effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    void s.pullProgress().then((p) => {
      if (!p || pulling) return;
      pulling = p;
      timer = setInterval(() => void s.pullProgress().then((q) => {
        if (q) return void (pulling = q);
        clearInterval(timer);
        pulling = null;
        reloadAi();
      }), 700);
    });
    return () => clearInterval(timer);
  });
  const pullLabel = (p: PullProgress) => (p.percent === null ? "Téléchargement…" : `Téléchargement ${p.percent} %`);

  /** undefined: loading; null: the host does not answer. */
  let workshop = $state<WorkshopState | null | undefined>(undefined);
  let operation = $state<WorkshopOperation>(null);
  let asking = $state<"restart" | "rebuild" | null>(null);
  let workshopError = $state<string | null>(null);
  // The host runs one operation at a time: a remounted page or another window sees it and waits for its end.
  const loadWorkshop = async () => ([workshop, operation] = await Promise.all([s.workshop(), s.workshopOperation()]));
  $effect(() => void loadWorkshop());
  $effect(() => {
    if (!operation) return;
    const t = setInterval(() => void loadWorkshop(), 2_000);
    return () => clearInterval(t);
  });
  const WORKSHOP: Record<WorkshopState, string> = {
    demarre: "Atelier démarré",
    arrete: "Atelier arrêté",
    absent: "Atelier pas encore créé : il se construit à la première ouverture de l'agent.",
    "docker-absent": "Docker (OrbStack) n'est pas lancé ou pas installé.",
  };
  const WORKSHOP_TONE: Record<WorkshopState, string> = { demarre: "ok", arrete: "off", absent: "off", "docker-absent": "warn" };
  const CONFIRM = {
    restart: "Les agents et les applis en cours s'arrêtent, puis les agents se relancent.",
    rebuild: "La reconstruction réinstalle Claude Code et Codex et prend quelques minutes. Les agents et les applis en cours s'arrêtent ; vos projets et les connexions de Claude et de Codex restent.",
  };
  async function operate(kind: "restart" | "rebuild") {
    asking = null;
    workshopError = null;
    operation = kind;
    const r = await s.restartWorkshop(kind === "rebuild");
    operation = null;
    if (!r.ok) workshopError = r.error;
    void loadWorkshop();
    void loadAgents();
  }

  let telemetry = $state<{ available: boolean; enabled: boolean } | null>(null);
  $effect(() => void s.telemetry().then((t) => (telemetry = t)));
  let version = $state<string | null>(null);
  $effect(() => void s.version().then((t) => (version = t)));
</script>

<!-- The pill of a local model: « installé », or « absent » with a download button once Ollama answers. -->
{#snippet pullPill(name: string, installed: boolean, id: string)}
  {#if installed}
    <span class="pill" data-tone="ok">installé</span>
  {:else if pulling?.name === name}
    <span class="pill" data-tone="warn" data-testid="pull-progress-{id}">{pullLabel(pulling)}</span>
  {:else}
    <span class="pill" data-tone="off">absent</span>
    {#if v?.ollama}<button data-testid="pull-{id}" disabled={!!pulling} onclick={() => void pullModel(name)}>Télécharger</button>{/if}
  {/if}
{/snippet}

<section class="settings" data-testid="settings-page" aria-label="Réglages">
  <nav aria-label="Sections des réglages">
    <h1>Réglages</h1>
    {#each SECTIONS as sec (sec.id)}
      <button data-testid="settings-nav-{sec.id}" aria-current={current === sec.id ? "page" : undefined} onclick={() => (current = sec.id)}>
        <Icon name={sec.icon} />{sec.label}
      </button>
    {/each}
  </nav>

  <div class="content">
    {#if current === "agents"}
      <section data-testid="settings-agents">
        <h2>Agents</h2>
        {#if !agents}
          <p><span class="pill" data-tone="warn">Vérification…</span></p>
        {:else}
          <div class="panel">
            {#each agents as a (a.id)}
              <div class="row" data-testid="agent-{a.id}">
                <div class="grow">
                  <b>{a.name}</b>
                  {#if signIn(a)}
                    {@const l = logins[a.id]}
                    {#if l?.kind === "device"}
                      <span class="muted">Ouvrez la page de connexion et saisissez le code <code data-testid="device-code">{l.code}</code></span>
                      <span class="muted">En attente de la connexion…</span>
                    {:else if l?.kind === "error"}
                      <span class="alert">Erreur : {l.error}</span>
                    {:else if a.login === "panel"}
                      <!-- Claude on Ollama or an API starts without its subscription: no nudge to sign in. -->
                      {#if (appState.value?.settings.claudeEngine.kind ?? "subscription") === "subscription"}
                        <span class="muted">Claude Code vous demande de vous connecter dans le panneau de l'agent ; sinon, tapez /login.</span>
                      {/if}
                    {:else}
                      <span class="muted">Connexion avec votre abonnement ChatGPT : un code à saisir sur le site d'OpenAI.</span>
                    {/if}
                  {:else if a.state === "logged-in"}
                    <span class="muted">Les conversations déjà ouvertes continuent jusqu'à leur relance.</span>
                  {/if}
                </div>
                <span class="pill" data-tone={agentTone(a)}>{agentText(a)}</span>
                {#if signIn(a)}
                  {@const l = logins[a.id]}
                  {#if l?.kind === "device"}
                    <button class="primary" data-testid="device-open" onclick={() => s.openUrl(l.url)}>Ouvrir la page de connexion</button>
                  {:else}
                    <button class:primary={a.id !== "claude" || (appState.value?.settings.claudeEngine.kind ?? "subscription") === "subscription"} data-testid="agent-login" disabled={l === null} onclick={() => void login(a.id)}>Se connecter</button>
                  {/if}
                {:else if a.state === "logged-in"}
                  <button data-testid="agent-logout" onclick={() => void logout(a.id)}>Se déconnecter</button>
                {/if}
              </div>
              {#if a.id === "claude" || a.id === "codex"}<SettingsEngine agent={a.id} />{/if}
            {:else}
              <div class="row"><span class="pill" data-tone="error">L'agent ne répond pas.</span></div>
            {/each}
          </div>
        {/if}
        <SettingsMozilla />
      </section>
    {:else if current === "ai"}
      <section data-testid="settings-ai">
        <h2>IA locale</h2>
        {#if !ai}
          <p><span class="pill" data-tone="warn">Vérification…</span></p>
        {:else if !ai.ollamaUrl}
          <!-- Only the silent host gives no address; a failed check still shows Ollama as unreachable. -->
          <p><span class="pill" data-tone="error" data-testid="ai-error">{ai.error ?? "L'agent ne répond pas"}</span></p>
        {:else}
          <div class="panel">
            <div class="row" data-testid="ai-ollama">
              <div class="grow"><b>Ollama</b><code class="muted">{ai.ollamaUrl}</code></div>
              <span class="pill" data-tone={v?.ollama ? "ok" : "warn"}>{v?.ollama ? "joignable" : "injoignable"}</span>
            </div>
            <div class="row" data-testid="ai-gemma">
              <div class="grow"><b>Gemma</b><span class="muted">Widgets et veille : {v?.gemmaModel ? `Gemma (${v.gemmaModel})` : "Gemma absent"}</span></div>
              {@render pullPill("gemma4:e4b-mlx", !!v?.gemma, "gemma")}
            </div>
            <div class="row">
              <label class="grow" for="decision-model"><b>Modèle de décision</b></label>
              <select id="decision-model" data-testid="ai-decision-model" value={model} onchange={(e) => s.chooseDecisionModel(e.currentTarget.value as DecisionModel)}>
                <option value="pplx-decider-flash">pplx-decider-flash (Ollama)</option>
                <option value="kev" disabled={!kevReady}>Kev (local)</option>
              </select>
              {#if model === "kev"}
                <span class="pill" data-tone={kevReady ? "ok" : "off"}>{kevReady ? "installé" : "absent"}</span>
              {:else}
                {@render pullPill("pplx-decider-flash", !!v?.decision, "decision")}
              {/if}
            </div>
            {#if pullError}<div class="row"><span class="pill" data-tone="error" data-testid="pull-error">{pullError}</span></div>{/if}
            {#if v?.ollama && (!v.gemma || (model !== "kev" && !v.decision))}
              <div class="row"><span class="muted">Plusieurs Go : le téléchargement peut prendre un moment.</span></div>
            {/if}
          </div>
        {/if}
      </section>
    {:else if current === "workshop"}
      <section data-testid="settings-workshop">
        <h2>Conteneur</h2>
        {#if workshop === undefined}
          <p><span class="pill" data-tone="warn">Vérification…</span></p>
        {:else}
          <div class="panel">
            <div class="row">
              <div class="grow"><b>Atelier de l'agent</b></div>
              <span class="pill" data-tone={operation ? "warn" : workshop ? WORKSHOP_TONE[workshop] : "error"} data-testid="workshop-state">
                {operation === "restart" ? "Redémarrage…" : operation === "rebuild" ? "Reconstruction… (quelques minutes)" : workshop ? WORKSHOP[workshop] : "L'agent ne répond pas"}
              </span>
              {#if workshop === "docker-absent"}
                <button class="primary" onclick={() => s.openUrl("https://orbstack.dev/download")}>Installer OrbStack</button>
              {/if}
              <button data-testid="workshop-restart" disabled={!!operation} onclick={() => (asking = "restart")}>Redémarrer</button>
              <button data-testid="workshop-rebuild" disabled={!!operation} onclick={() => (asking = "rebuild")}>Reconstruire</button>
            </div>
          </div>
          {#if workshopError}<p class="alert" role="status">{workshopError}</p>{/if}
          {#if asking && !operation}
            {@const kind = asking}
            <div class="confirmation" role="alertdialog" aria-label={kind === "restart" ? "Redémarrer" : "Reconstruire"}>
              <p>{CONFIRM[kind]}</p>
              <div class="buttons">
                <button onclick={() => (asking = null)}>Annuler</button>
                <button class="primary" data-testid="confirm-workshop" onclick={() => void operate(kind)}>{kind === "restart" ? "Redémarrer" : "Reconstruire"}</button>
              </div>
            </div>
          {/if}
        {/if}
      </section>
    {:else if current === "permissions"}
      <SettingsPermissions />
    {:else if current === "data"}
      <SettingsData />
    {:else if current === "shortcuts"}
      <SettingsShortcuts />
    {:else if current === "privacy"}
      <section data-testid="settings-privacy">
        <h2>Vie privée</h2>
        {#if !telemetry}
          <p><span class="pill" data-tone="warn">Vérification…</span></p>
        {:else}
          <div class="panel">
            <div class="row">
              <div class="grow">
                <label for="telemetry-switch"><b>Envoyer les plantages et les erreurs</b></label>
                <span class="muted" id="telemetry-notice">{TELEMETRY_NOTICE}</span>
              </div>
              <input
                id="telemetry-switch"
                class="switch"
                type="checkbox"
                role="switch"
                data-testid="telemetry-switch"
                aria-describedby="telemetry-notice"
                disabled={!telemetry.available}
                checked={telemetry.enabled}
                onchange={(e) => {
                  telemetry!.enabled = e.currentTarget.checked;
                  s.setTelemetry(telemetry!.enabled);
                }}
              />
            </div>
          </div>
          {#if !telemetry.available}<p class="muted">Cette version n'envoie rien.</p>{/if}
        {/if}
        <h2>Interface</h2>
        <div class="panel">
          <div class="row">
            <div class="grow">
              <label for="hints-switch"><b>Astuces</b></label>
              <span class="muted" id="hints-help">Des conseils sur la page d'accueil et à la première ouverture de l'agent, du mode design et des actions.</span>
            </div>
            <input
              id="hints-switch"
              class="switch"
              type="checkbox"
              role="switch"
              data-testid="settings-hints"
              aria-describedby="hints-help"
              checked={appState.value?.settings.hints.enabled ?? true}
              onchange={(e) => api.dispatch({ type: "setHintsEnabled", enabled: e.currentTarget.checked })}
            />
          </div>
          <div class="row">
            <b class="grow" id="sidebar-side-label">Barre de navigation</b>
            <div role="radiogroup" aria-labelledby="sidebar-side-label" class="kinds">
              {#each [["left", "À gauche"], ["right", "À droite"]] as const as [side, name]}
                <label>
                  <input
                    type="radio"
                    name="sidebar-side"
                    data-testid="settings-sidebar-{side}"
                    checked={(appState.value?.settings.sidebarSide ?? "left") === side}
                    onchange={() => api.dispatch({ type: "setSidebarSide", side })}
                  />{name}
                </label>
              {/each}
            </div>
          </div>
        </div>
      </section>
    {:else}
      <section data-testid="settings-about">
        <h2>À propos</h2>
        <div class="panel">
          <div class="row">
            <b class="grow" data-testid="app-version">{version === null ? "" : `WebAiOs ${version}`}</b>
            <button data-testid="settings-release-notes" onclick={() => api.dispatch({ type: "openReleaseNotes", windowId: api.windowId })}>Nouveautés</button>
            <button data-testid="settings-replay-welcome" onclick={() => api.dispatch({ type: "replayOnboarding" })}>Revoir l'accueil</button>
            <button data-testid="open-advanced" onclick={() => s.openAdvanced()}>Réglages avancés du navigateur</button>
          </div>
        </div>
      </section>
    {/if}
  </div>
</section>

<style>
  .settings { display: grid; grid-template-columns: 200px 1fr; height: 100%; color: var(--text); font-size: 13px; }
  nav { display: flex; flex-direction: column; gap: 2px; padding: 22px 10px; border-right: 1px solid var(--border); overflow-y: auto; }
  nav h1 { margin: 0 10px 14px; font: 650 22px/1.1 var(--font-display); letter-spacing: -0.02em; color: var(--text); }
  nav button { all: unset; display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border-radius: 10px; color: var(--text-muted); cursor: default; transition: transform var(--tap), background var(--tap); }
  nav button :global(svg) { color: var(--text-muted); }
  nav button:hover { background: var(--bg-hover); color: var(--text); }
  nav button:active { transform: scale(0.97); }
  nav button[aria-current="page"] { background: var(--glass-hi); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); color: var(--text); }
  nav button[aria-current="page"] :global(svg) { color: var(--accent); }
  .settings :global(:is(button, input, select):focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .content { min-width: 0; overflow-y: auto; padding: 26px 32px; }
  .content > :global(section) { max-width: 720px; }
  .settings :global(h2) { margin: 0 0 18px; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  .settings :global(h3) { margin: 22px 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
  .settings :global(p) { margin: 10px 4px; overflow-wrap: anywhere; }
  .settings :global(code) { font: 12px var(--font-mono); overflow-wrap: anywhere; }
  /* macOS draws native radios in the system blue: ours, in the accent. */
  .settings :global(input[type="radio"]) { appearance: none; width: 15px; height: 15px; margin: 0; flex: none; border-radius: 50%; border: 1px solid var(--border); background: var(--glass-hi); transition: border-width var(--tap); }
  .settings :global(input[type="radio"]:checked) { border: 4.5px solid var(--accent); background: var(--accent-ink); }
  .settings :global(.muted) { color: var(--text-muted); }
  .settings :global(.alert) { color: var(--in-error); }
  .settings :global(.panel) { border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  .settings :global(.panel > * + *) { border-top: 1px solid var(--border); }
  .settings :global(.row) { display: flex; align-items: center; gap: 10px; padding: 11px 14px; }
  .kinds { display: flex; gap: 16px; }
  .kinds label { display: inline-flex; align-items: center; gap: 6px; }
  .settings :global(.grow) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .settings :global(.grow b), .settings :global(b.grow) { font-weight: 600; }
  .settings :global(.grow .muted) { font-size: 12px; }
  /* A state: a dot of its tone and the text. */
  .settings :global(.pill) { --tone: var(--stopped); display: inline-flex; align-items: center; gap: 6px; max-width: 300px; padding: 3px 9px; border-radius: 10px; background: color-mix(in srgb, var(--tone) 16%, transparent); font-size: 12px; line-height: 1.35; flex: none; }
  .settings :global(.pill::before) { content: ""; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--tone); }
  .settings :global(.pill[data-tone="ok"]) { --tone: var(--running); }
  .settings :global(.pill[data-tone="warn"]) { --tone: var(--in-progress); }
  .settings :global(.pill[data-tone="error"]) { --tone: var(--in-error); }
  .content :global(button) { flex: none; padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  .content :global(button:hover:not(:disabled)) { background: var(--bg-active); }
  .content :global(button:active:not(:disabled)) { transform: scale(0.97); }
  .content :global(button:disabled) { opacity: 0.5; }
  .content :global(button.primary) { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .content :global(button.primary:hover:not(:disabled)) { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
  .content :global(button.danger) { color: var(--in-error); }
  .settings :global(.buttons) { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .settings :global(.buttons.start) { justify-content: flex-start; margin-top: 14px; }
  .settings :global(.confirmation) { margin: 12px 0; padding: 14px 16px; border-radius: 16px; background: var(--sheet); border: 1px solid var(--border); box-shadow: var(--lift); animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .settings :global(.confirmation p) { margin: 0 0 12px; }
  .settings :global(.panel .confirmation) { margin: 0 14px 12px; background: var(--glass-hi); box-shadow: none; }
  select { padding: 5px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 12px var(--font-ui); }
  .switch { appearance: none; position: relative; width: 34px; height: 20px; margin: 0; flex: none; border-radius: 10px; background: var(--bg-active); transition: background var(--tap); }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--on-color); box-shadow: var(--float); transition: left var(--spring-d) var(--spring); }
  .switch:checked { background: var(--accent); }
  .switch:checked::after { left: 16px; }
  .switch:disabled { opacity: 0.5; }
</style>
