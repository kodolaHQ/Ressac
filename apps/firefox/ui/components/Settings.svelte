<script lang="ts" module>
  import type { IconName } from "./Icon.svelte";

  const SECTIONS = [
    { id: "agents", icon: "agent" },
    { id: "ai", icon: "cpu" },
    { id: "workshop", icon: "box" },
    { id: "permissions", icon: "key" },
    { id: "data", icon: "database" },
    { id: "privacy", icon: "lock" },
    { id: "shortcuts", icon: "keyboard" },
    { id: "about", icon: "info" },
  ] as const satisfies readonly { id: string; icon: IconName }[];
  type SectionId = (typeof SECTIONS)[number]["id"];
  // Module-level: the page is remounted on each tab switch and comes back to the last section seen.
  let current = $state<SectionId>("agents");
  /** Called before opening Réglages from elsewhere (the Extensions page): it lands on Agents. */
  export const showAgentsSection = () => (current = "agents");
</script>

<script lang="ts">
  import type { LocalAiStateShown, SettingsApi } from "../../shared/api";
  import { OLLAMA_ITSELF, type DockerStatus, type AgentAccount, type DecisionModel, type LoginResult, type PullProgress, type WorkshopOperation } from "../../shared/settings";
  import { updateStatusText } from "../../core/update";
  import { aiOn, api, appState } from "../state.svelte";
  import AiAsleep from "./AiAsleep.svelte";
  import { t } from "../i18n.svelte";
  import { LOCALES, languageName } from "../../shared/i18n";
  import { SEARCH_ENGINES, customEngineError, type SearchEngine } from "../../shared/search";
  import { APPEARANCES } from "../../shared/model";
  import Icon from "./Icon.svelte";
  import SettingsMozilla from "./SettingsMozilla.svelte";
  import SettingsEngine from "./SettingsEngine.svelte";
  import SettingsData from "./SettingsData.svelte";
  import SettingsPermissions from "./SettingsPermissions.svelte";
  import SettingsShortcuts from "./SettingsShortcuts.svelte";

  let languageChanged = $state(false);
  // Each section loads on its own: a slow Docker never holds the version or the data folder.
  const s = api.settings;
  const update = $derived(appState.value?.update ?? null);
  type WorkshopState = NonNullable<Awaited<ReturnType<SettingsApi["workshop"]>>>;

  let agents = $state<AgentAccount[] | null>(null);
  /** Each account's sign-in in progress: null while the host starts it, then its code or its error. */
  let logins = $state<Record<string, LoginResult | null>>({});
  const loadAgents = async () => {
    agents = await s.agents();
    // A finished sign-in forgets its code: after a logout, the row offers Se connecter again.
    for (const a of agents) if (a.state === "logged-in") delete logins[a.id];
  };
  // AI off: Agents, IA locale and Atelier show the asleep card and ask nothing of the host.
  $effect(() => void (aiOn() && loadAgents()));
  // Claude signs in in the agent panel (which builds the workshop if needed), Codex by a code on OpenAI's site: re-read only while one is awaited (a Codex code shown, or Claude signed out).
  const signIn = (a: AgentAccount) => a.state === "logged-out" || a.state === "no-container";
  $effect(() => {
    if (!aiOn() || !agents?.some((a) => signIn(a) && (a.login === "panel" || logins[a.id] !== undefined))) return;
    const t = setInterval(() => void loadAgents(), 5_000);
    return () => clearInterval(t);
  });
  function agentText(a: AgentAccount): string {
    switch (a.state) {
      case "logged-in":
        return a.account ? t("settings-agent-logged-in-account", { account: a.account }) : t("settings-agent-logged-in");
      case "logged-out":
        return t("settings-agent-logged-out");
      case "docker-absent":
        return t("settings-agent-docker-absent");
      case "no-container":
        return t("settings-agent-no-container");
      case "error":
        return t("settings-error", { error: a.error ?? "" });
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
    if (aiOn()) void api.ai.state().then((r) => (ai = r));
  });

  // Model downloads: the host runs one at a time and reports it; polled like the workshop operation.
  let pulling = $state<PullProgress | null>(null);
  let pullError = $state<string | null>(null);
  const reloadAi = () => void api.ai.state().then((r) => (ai = r));
  const ollama = $derived(ai?.ollama);
  let startingOllama = $state(false);
  async function startOllama() {
    startingOllama = true;
    const r = await s.startOllama();
    startingOllama = false;
    pullError = r.ok ? null : r.error;
    reloadAi();
  }
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
    if (!aiOn()) return;
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
  const pullLabel = (p: PullProgress) => (p.percent === null ? t("settings-pull-progress-unknown") : t("settings-pull-progress", { percent: p.percent }));

  /** undefined: loading; null: the host does not answer. */
  let workshop = $state<WorkshopState | null | undefined>(undefined);
  let operation = $state<WorkshopOperation>(null);
  let asking = $state<"restart" | "rebuild" | null>(null);
  let workshopError = $state<string | null>(null);
  // The host runs one operation at a time: a remounted page or another window sees it and waits for its end.
  /** Set while Docker is missing: tells an installed app that is stopped from none at all. */
  let docker = $state<DockerStatus | null>(null);
  let startingDocker = $state(false);
  const loadWorkshop = async () => {
    [workshop, operation] = await Promise.all([s.workshop(), s.workshopOperation()]);
    docker = workshop === "docker-absent" ? await s.docker() : null;
  };
  async function startDocker() {
    startingDocker = true;
    const r = await s.startDocker();
    startingDocker = false;
    workshopError = r.ok ? null : r.error;
    await loadWorkshop();
  }
  $effect(() => void (aiOn() && loadWorkshop()));
  $effect(() => {
    if (!operation) return;
    const t = setInterval(() => void loadWorkshop(), 2_000);
    return () => clearInterval(t);
  });
  const WORKSHOP: Record<WorkshopState, string> = {
    demarre: "settings-workshop-started",
    arrete: "settings-workshop-stopped",
    absent: "settings-workshop-absent",
    "docker-absent": "settings-workshop-docker-absent",
  };
  const WORKSHOP_TONE: Record<WorkshopState, string> = { demarre: "ok", arrete: "off", absent: "off", "docker-absent": "warn" };
  const CONFIRM = { restart: "settings-workshop-confirm-restart", rebuild: "settings-workshop-confirm-rebuild" };
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
  let isDefault = $state<boolean | null>(null);
  /** Set by « Définir par défaut »: macOS asks in its own dialog, so the answer is awaited. */
  let askedDefault = $state(false);
  const loadDefault = () => s.defaultBrowser().then((d) => (isDefault = d));
  $effect(() => void loadDefault());
  $effect(() => {
    if (!askedDefault || isDefault) return;
    const t = setInterval(() => void loadDefault(), 1_000);
    return () => clearInterval(t);
  });
  let version = $state<string | null>(null);
  $effect(() => void s.version().then((t) => (version = t)));

  // « Autre… » shows its field before any valid address: the engine only changes once the address is accepted.
  let customOpen = $state(false);
  let engineError = $state<string | null>(null);
  const shownEngine = $derived<SearchEngine>(customOpen ? "custom" : (appState.value?.settings.engine ?? "google"));
  function pickEngine(engine: SearchEngine) {
    engineError = null;
    const kept = appState.value?.settings.customEngine;
    customOpen = engine === "custom" && (!kept || !!customEngineError(kept));
    if (!customOpen) api.dispatch({ type: "chooseEngine", engine });
  }
  function saveCustomEngine(url: string) {
    engineError = customEngineError(url);
    if (engineError) return;
    customOpen = false;
    api.dispatch({ type: "chooseEngine", engine: "custom", custom: url.trim() });
  }
  const focusField = (node: HTMLInputElement) => {
    if (customOpen) node.focus();
  };
</script>

<!-- The pill of a local model: « installé », or « absent » with a download button once Ollama answers. -->
{#snippet pullPill(name: string, installed: boolean, id: string, action = "settings-pull-download")}
  {#if installed}
    <span class="pill" data-tone="ok">{t("settings-pill-installed")}</span>
  {:else if pulling?.name === name}
    <span class="pill" data-tone="warn" data-testid="pull-progress-{id}">{pullLabel(pulling)}</span>
  {:else}
    <span class="pill" data-tone="off">{t("settings-pill-absent")}</span>
    {#if v?.ollama || name === OLLAMA_ITSELF}<button data-testid="pull-{id}" disabled={!!pulling} onclick={() => void pullModel(name)}>{t(action)}</button>{/if}
  {/if}
{/snippet}

<section class="settings" data-testid="settings-page" aria-label={t("settings-title")}>
  <nav aria-label={t("settings-nav-label")}>
    <h1>{t("settings-title")}</h1>
    {#each SECTIONS as sec (sec.id)}
      <button data-testid="settings-nav-{sec.id}" aria-current={current === sec.id ? "page" : undefined} onclick={() => (current = sec.id)}>
        <Icon name={sec.icon} />{t(`settings-section-${sec.id}`)}
      </button>
    {/each}
  </nav>

  <div class="content">
    {#if current === "agents"}
      <section data-testid="settings-agents">
        <h2>{t("settings-section-agents")}</h2>
        <div class="panel">
          <div class="row">
            <div class="grow">
              <label for="ai-switch"><b>{t("settings-ai-switch")}</b></label>
              <span class="muted" id="ai-switch-note">{t("settings-ai-switch-note")}</span>
            </div>
            <input
              id="ai-switch"
              class="switch"
              type="checkbox"
              role="switch"
              data-testid="settings-ai-switch"
              aria-describedby="ai-switch-note"
              checked={aiOn()}
              onchange={(e) => api.dispatch({ type: e.currentTarget.checked ? "enableAi" : "disableAi" })}
            />
          </div>
        </div>
        {#if !aiOn()}
          <AiAsleep feature="settings" />
        {:else if !agents}
          <p><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
        {:else}
          <div class="panel">
            {#each agents as a (a.id)}
              <div class="row" data-testid="agent-{a.id}">
                <div class="grow">
                  <b>{a.name}</b>
                  {#if signIn(a)}
                    {@const l = logins[a.id]}
                    {#if l?.kind === "device"}
                      <span class="muted">{t("settings-agent-device-code")} <code data-testid="device-code">{l.code}</code></span>
                      <span class="muted">{t("settings-agent-device-waiting")}</span>
                    {:else if l?.kind === "error"}
                      <span class="alert">{t("settings-error", { error: l.error })}</span>
                    {:else if a.login === "panel"}
                      <!-- Claude on Ollama or an API starts without its subscription: no nudge to sign in. -->
                      {#if (appState.value?.settings.claudeEngine.kind ?? "subscription") === "subscription"}
                        <span class="muted">{t("settings-agent-panel-login")}</span>
                      {/if}
                    {:else}
                      <span class="muted">{t("settings-agent-codex-login")}</span>
                    {/if}
                  {:else if a.state === "logged-in"}
                    <span class="muted">{t("settings-agent-open-chats")}</span>
                  {/if}
                </div>
                <span class="pill" data-tone={agentTone(a)}>{agentText(a)}</span>
                {#if signIn(a)}
                  {@const l = logins[a.id]}
                  {#if l?.kind === "device"}
                    <button class="primary" data-testid="device-open" onclick={() => s.openUrl(l.url)}>{t("settings-agent-device-open")}</button>
                  {:else}
                    <button class:primary={a.id !== "claude" || (appState.value?.settings.claudeEngine.kind ?? "subscription") === "subscription"} data-testid="agent-login" disabled={l === null} onclick={() => void login(a.id)}>{t("settings-agent-login")}</button>
                  {/if}
                {:else if a.state === "logged-in"}
                  <button data-testid="agent-logout" onclick={() => void logout(a.id)}>{t("settings-agent-logout")}</button>
                {/if}
              </div>
              {#if a.id === "claude" || a.id === "codex"}<SettingsEngine agent={a.id} />{/if}
            {:else}
              <div class="row"><span class="pill" data-tone="error">{t("settings-agent-silent-sentence")}</span></div>
            {/each}
          </div>
        {/if}
        {#if aiOn()}<SettingsMozilla />{/if}
      </section>
    {:else if current === "ai"}
      <section data-testid="settings-ai">
        <h2>{t("settings-section-ai")}</h2>
        <p class="muted">{t("settings-ai-intro")}</p>
        {#if !aiOn()}
          <AiAsleep feature="settings" />
        {:else if !ai}
          <p><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
        {:else if !ai.ollamaUrl}
          <!-- Only the silent host gives no address; a failed check still shows Ollama as unreachable. -->
          <p><span class="pill" data-tone="error" data-testid="ai-error">{ai.error ?? t("settings-agent-silent")}</span></p>
        {:else}
          <div class="panel">
            <div class="row" data-testid="ai-ollama">
              <div class="grow"><b>Ollama</b><code class="muted">{ai.ollamaUrl}</code></div>
              {#if ollama?.kind === "outdated"}
                <span class="pill" data-tone="warn">{t("settings-ai-ollama-outdated", { version: ollama.version, min: ollama.min })}</span>
                <button data-testid="ollama-update" onclick={() => s.openUrl("https://ollama.com/download")}>{t("settings-ai-ollama-update")}</button>
              {:else if ollama?.kind === "stopped"}
                <span class="pill" data-tone="warn">{t("settings-ai-ollama-stopped")}</span>
                <button data-testid="ollama-start" disabled={startingOllama} onclick={() => void startOllama()}>{startingOllama ? t("settings-ai-ollama-starting") : t("settings-ai-ollama-start")}</button>
              {:else if ollama?.kind === "absent"}
                {@render pullPill(OLLAMA_ITSELF, false, "ollama", "settings-ai-ollama-download")}
              {:else}
                <span class="pill" data-tone={v?.ollama ? "ok" : "warn"}>{v?.ollama ? t("settings-ai-ollama-reachable") : t("settings-ai-ollama-unreachable")}</span>
              {/if}
            </div>
            <div class="row" data-testid="ai-gemma">
              <div class="grow"><b>Gemma</b><span class="muted">{v?.gemmaModel ? t("settings-ai-gemma-present", { model: v.gemmaModel }) : t("settings-ai-gemma-absent")}</span></div>
              {@render pullPill("gemma4:e4b-mlx", !!v?.gemma, "gemma")}
            </div>
            <div class="row">
              <label class="grow" for="decision-model"><b>{t("settings-ai-decision-model")}</b></label>
              <select id="decision-model" data-testid="ai-decision-model" value={model} onchange={(e) => s.chooseDecisionModel(e.currentTarget.value as DecisionModel)}>
                <option value="pplx-decider-flash">pplx-decider-flash (Ollama)</option>
                <option value="kev" disabled={!kevReady}>Kev (local)</option>
              </select>
              {#if model === "kev"}
                <span class="pill" data-tone={kevReady ? "ok" : "off"}>{kevReady ? t("settings-pill-installed") : t("settings-pill-absent")}</span>
              {:else}
                {@render pullPill("pplx-decider-flash", !!v?.decision, "decision")}
              {/if}
            </div>
            {#if pullError}<div class="row"><span class="pill" data-tone="error" data-testid="pull-error">{pullError}</span></div>{/if}
            {#if v?.ollama && (!v.gemma || (model !== "kev" && !v.decision))}
              <div class="row"><span class="muted">{t("settings-ai-large-download")}</span></div>
            {/if}
          </div>
        {/if}
      </section>
    {:else if current === "workshop"}
      <section data-testid="settings-workshop">
        <h2>{t("settings-section-workshop")}</h2>
        {#if !aiOn()}
          <AiAsleep feature="settings" />
        {:else if workshop === undefined}
          <p><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
        {:else}
          <div class="panel">
            <div class="row">
              <div class="grow"><b>{t("settings-workshop-name")}</b></div>
              <span class="pill" data-tone={operation ? "warn" : workshop ? WORKSHOP_TONE[workshop] : "error"} data-testid="workshop-state">
                {operation === "restart" ? t("settings-workshop-restarting") : operation === "rebuild" ? t("settings-workshop-rebuilding") : workshop ? t(WORKSHOP[workshop]) : t("settings-agent-silent")}
              </span>
              {#if workshop === "docker-absent" && docker?.kind === "stopped"}
                <button class="primary" data-testid="docker-start" disabled={startingDocker} onclick={() => void startDocker()}>{startingDocker ? t("settings-ai-ollama-starting") : t("settings-docker-start", { app: docker.app })}</button>
              {:else if workshop === "docker-absent"}
                <button class="primary" onclick={() => s.openUrl("https://orbstack.dev/download")}>{t("settings-docker-install")}</button>
              {/if}
              <button data-testid="workshop-restart" disabled={!!operation} onclick={() => (asking = "restart")}>{t("settings-restart")}</button>
              <button data-testid="workshop-rebuild" disabled={!!operation} onclick={() => (asking = "rebuild")}>{t("settings-rebuild")}</button>
            </div>
          </div>
          {#if workshopError}<p class="alert" role="status">{workshopError}</p>{/if}
          {#if asking && !operation}
            {@const kind = asking}
            <div class="confirmation" role="alertdialog" aria-label={kind === "restart" ? t("settings-restart") : t("settings-rebuild")}>
              <p>{t(CONFIRM[kind])}</p>
              <div class="buttons">
                <button onclick={() => (asking = null)}>{t("settings-cancel")}</button>
                <button class="primary" data-testid="confirm-workshop" onclick={() => void operate(kind)}>{kind === "restart" ? t("settings-restart") : t("settings-rebuild")}</button>
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
        <h2>{t("settings-section-privacy")}</h2>
        {#if !telemetry}
          <p><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
        {:else}
          <div class="panel">
            <div class="row">
              <div class="grow">
                <label for="telemetry-switch"><b>{t("settings-telemetry-label")}</b></label>
                <span class="muted" id="telemetry-notice">{t("agent-telemetry-notice")}</span>
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
          {#if !telemetry.available}<p class="muted">{t("settings-telemetry-unavailable")}</p>{/if}
        {/if}
        <h2>{t("settings-interface")}</h2>
        <div class="panel">
          <div class="row">
            <label class="grow" for="settings-language"><b>{t("settings-language-label")}</b></label>
            <select id="settings-language" data-testid="settings-language" value={appState.value?.settings.language ?? "system"} onchange={(e) => { languageChanged = true; api.dispatch({ type: "chooseLanguage", language: e.currentTarget.value }); }}>
              <option value="system">{appState.value?.settings.language === "system" ? t("settings-language-system-named", { name: languageName(appState.value.locale) }) : t("settings-language-system")}</option>
              {#each LOCALES as code (code)}<option value={code}>{languageName(code)}</option>{/each}
            </select>
          </div>
          {#if languageChanged && appState.value}
            <p class="muted language-note" data-testid="settings-language-note">{t("settings-language-agent-note", { language: new Intl.DisplayNames([appState.value.locale], { type: "language" }).of(appState.value.locale) ?? appState.value.locale })}</p>
          {/if}
          <div class="row" data-testid="settings-search">
            <div class="grow">
              <label for="settings-engine"><b>{t("settings-engine-label")}</b></label>
              <span class="muted" id="engine-help">{t("settings-engine-help")}</span>
            </div>
            <select id="settings-engine" data-testid="settings-engine" aria-describedby="engine-help" value={shownEngine} onchange={(e) => pickEngine(e.currentTarget.value as SearchEngine)}>
              {#each Object.entries(SEARCH_ENGINES) as [id, e] (id)}<option value={id}>{e.label}</option>{/each}
              <option value="custom">{t("settings-engine-other")}</option>
            </select>
          </div>
          {#if shownEngine === "custom"}
            <div class="row custom-engine">
              <div class="grow">
                <label for="settings-engine-custom"><b>{t("settings-engine-custom-label")}</b></label>
                <input
                  id="settings-engine-custom"
                  data-testid="settings-engine-custom"
                  placeholder="https://kagi.com/search?q=%s"
                  spellcheck="false"
                  value={appState.value?.settings.customEngine ?? ""}
                  use:focusField
                  onchange={(e) => saveCustomEngine(e.currentTarget.value)}
                  onkeydown={(e) => e.key === "Enter" && saveCustomEngine(e.currentTarget.value)}
                />
                {#if engineError}<span class="pill" data-tone="error" data-testid="settings-engine-error">{t(engineError)}</span>{/if}
              </div>
            </div>
          {/if}
          <div class="row">
            <div class="grow">
              <label for="hints-switch"><b>{t("settings-hints-label")}</b></label>
              <span class="muted" id="hints-help">{t("settings-hints-help")}</span>
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
            <div class="grow">
              <label for="start-home-switch"><b>{t("settings-start-home-label")}</b></label>
              <span class="muted" id="start-home-help">{t("settings-start-home-help")}</span>
            </div>
            <input
              id="start-home-switch"
              class="switch"
              type="checkbox"
              role="switch"
              data-testid="settings-start-home"
              aria-describedby="start-home-help"
              checked={appState.value?.settings.startOnHome ?? true}
              onchange={(e) => api.dispatch({ type: "setStartOnHome", enabled: e.currentTarget.checked })}
            />
          </div>
          <div class="row" data-testid="settings-default-browser">
            <div class="grow">
              <b>{t("settings-default-browser-label")}</b>
              <span class="muted">{t("settings-default-browser-help")}</span>
            </div>
            {#if isDefault}
              <span class="pill" data-tone="ok" data-testid="default-browser-state">{t("settings-default-browser-is")}</span>
            {:else if isDefault === false}
              <button data-testid="default-browser-set" onclick={() => (s.setDefaultBrowser(), (askedDefault = true))}>{t("settings-default-browser-set")}</button>
            {/if}
          </div>
          <div class="row">
            <b class="grow" id="sidebar-side-label">{t("settings-sidebar-label")}</b>
            <div role="radiogroup" aria-labelledby="sidebar-side-label" class="kinds">
              {#each [["left", "settings-sidebar-left"], ["right", "settings-sidebar-right"]] as const as [side, name]}
                <label>
                  <input
                    type="radio"
                    name="sidebar-side"
                    data-testid="settings-sidebar-{side}"
                    checked={(appState.value?.settings.sidebarSide ?? "left") === side}
                    onchange={() => api.dispatch({ type: "setSidebarSide", side })}
                  />{t(name)}
                </label>
              {/each}
            </div>
          </div>
          <div class="row">
            <b class="grow" id="appearance-label">{t("settings-appearance-label")}</b>
            <div role="radiogroup" aria-labelledby="appearance-label" class="kinds">
              {#each APPEARANCES as appearance (appearance)}
                <label>
                  <input
                    type="radio"
                    name="appearance"
                    data-testid="settings-appearance-{appearance}"
                    checked={(appState.value?.settings.appearance ?? "system") === appearance}
                    onchange={() => api.dispatch({ type: "chooseAppearance", appearance })}
                  />{t(`settings-appearance-${appearance}`)}
                </label>
              {/each}
            </div>
          </div>
        </div>
      </section>
    {:else}
      <section data-testid="settings-about">
        <h2>{t("settings-section-about")}</h2>
        <div class="panel">
          <div class="row about-head">
            <b class="grow version" data-testid="app-version">{version === null ? "" : `Ressac ${version}`}</b>
            <button data-testid="settings-release-notes" onclick={() => api.dispatch({ type: "openReleaseNotes", windowId: api.windowId })}>{t("settings-about-release-notes")}</button>
            <button data-testid="settings-replay-welcome" onclick={() => api.dispatch({ type: "replayOnboarding" })}>{t("settings-about-replay-welcome")}</button>
            <button data-testid="open-advanced" onclick={() => s.openAdvanced()}>{t("settings-about-advanced")}</button>
          </div>
          {#if update && update.phase !== "disabled"}
            <div class="row">
              <span class="grow" data-testid="update-status" aria-live="polite">{updateStatusText(update, appState.value?.locale ?? "fr")}</span>
              {#if update.phase === "idle" || update.phase === "unreachable"}
                <button data-testid="update-check" onclick={() => s.checkForUpdate()}>{t("settings-about-update-check")}</button>
              {:else if update.phase === "ready"}
                <button class="primary" data-testid="update-restart" onclick={() => s.restartToUpdate()}>{t("settings-about-update-restart")}</button>
              {:else if update.phase === "failed" || update.phase === "unwritable"}
                <button data-testid="update-download" onclick={() => s.downloadUpdate()}>{t("settings-about-update-download")}</button>
              {/if}
            </div>
          {/if}
        </div>
        <h3>{t("settings-credits")}</h3>
        <div class="panel" data-testid="settings-credits">
          <p>{t("settings-credits-built-on-before")} <b>Firefox</b> {t("settings-credits-built-on-after")}</p>
          <p class="muted">{t("settings-credits-licenses-before")} <code>Contents/Resources/ressac-host/LICENSES</code>.</p>
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
  .settings :global(.about-head) { flex-wrap: wrap; }
  .settings :global(b.version) { flex: 1 0 auto; white-space: nowrap; }
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
  .settings :global(.confirmation) { margin: 12px 0; padding: 14px 16px; border-radius: 16px; background: var(--sheet); border: 1px solid var(--border); box-shadow: var(--lift); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .settings :global(.confirmation p) { margin: 0 0 12px; }
  .settings :global(.panel .confirmation) { margin: 0 14px 12px; background: var(--glass-hi); box-shadow: none; }
  select { padding: 5px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 12px var(--font-ui); }
  .switch { appearance: none; position: relative; width: 34px; height: 20px; margin: 0; flex: none; border-radius: 10px; background: var(--bg-active); transition: background var(--tap); }
  .language-note { margin: 0; padding: 0 16px 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .custom-engine { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .custom-engine input { display: block; box-sizing: border-box; width: 100%; margin: 6px 0; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--on-color); box-shadow: var(--float); transition: left var(--spring-d) var(--spring); }
  .switch:checked { background: var(--accent); }
  .switch:checked::after { left: 16px; }
  .switch:disabled { opacity: 0.5; }
</style>
