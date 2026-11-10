<script lang="ts" module>
  import type { IconName } from "./Icon.svelte";

  const SECTIONS = [
    { id: "agents", label: "Agents", icon: "agent" },
    { id: "ai", label: "IA locale", icon: "cpu" },
    { id: "workshop", label: "Conteneur", icon: "box" },
    { id: "permissions", label: "Permissions", icon: "key" },
    { id: "data", label: "Données", icon: "database" },
    { id: "privacy", label: "Vie privée", icon: "lock" },
    { id: "about", label: "À propos", icon: "info" },
  ] as const satisfies readonly { id: string; label: string; icon: IconName }[];
  type SectionId = (typeof SECTIONS)[number]["id"];
  // Module-level: the page is remounted on each tab switch and comes back to the last section seen.
  let current = $state<SectionId>("agents");
</script>

<script lang="ts">
  import type { LocalAiStateShown, SettingsApi } from "../../shared/api";
  import { TELEMETRY_NOTICE, type AgentAccount, type DecisionModel, type WorkshopOperation } from "../../shared/settings";
  import { api, appState } from "../state.svelte";
  import Icon from "./Icon.svelte";
  import SettingsData from "./SettingsData.svelte";
  import SettingsPermissions from "./SettingsPermissions.svelte";

  // Each section loads on its own: a slow Docker never holds the version or the data folder.
  const s = api.settings;
  type WorkshopState = NonNullable<Awaited<ReturnType<SettingsApi["workshop"]>>>;

  let agents = $state<AgentAccount[] | null>(null);
  const loadAgents = async () => (agents = await s.agents());
  $effect(() => void loadAgents());
  // Signing in happens in the agent panel (which builds the workshop if needed): while an account waits for it, re-read it.
  const signIn = (a: AgentAccount) => a.state === "logged-out" || a.state === "no-container";
  $effect(() => {
    if (!agents?.some(signIn)) return;
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
    agents = await s.logout(id);
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
    rebuild: "La reconstruction réinstalle Claude Code et prend quelques minutes. Les agents et les applis en cours s'arrêtent ; vos projets et la connexion de Claude restent.",
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
                    <span class="muted">Claude Code vous demande de vous connecter dans le panneau de l'agent ; sinon, tapez /login.</span>
                  {:else if a.state === "logged-in"}
                    <span class="muted">Les conversations déjà ouvertes continuent jusqu'à leur relance.</span>
                  {/if}
                </div>
                <span class="pill" data-tone={agentTone(a)}>{agentText(a)}</span>
                {#if signIn(a)}
                  <button class="primary" data-testid="agent-login" onclick={() => s.login(a.id)}>Se connecter</button>
                {:else if a.state === "logged-in"}
                  <button data-testid="agent-logout" onclick={() => void logout(a.id)}>Se déconnecter</button>
                {/if}
              </div>
            {:else}
              <div class="row"><span class="pill" data-tone="error">L'agent ne répond pas.</span></div>
            {/each}
          </div>
        {/if}
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
              <div class="grow"><b>Gemma</b><span class="muted">Widgets et veille : Gemma (gemma4:e4b-mlx)</span></div>
              <span class="pill" data-tone={v?.gemma ? "ok" : "off"}>{v?.gemma ? "installé" : "absent"}</span>
            </div>
            <div class="row">
              <label class="grow" for="decision-model"><b>Modèle de décision</b></label>
              <select id="decision-model" data-testid="ai-decision-model" value={model} onchange={(e) => s.chooseDecisionModel(e.currentTarget.value as DecisionModel)}>
                <option value="pplx-decider-flash">pplx-decider-flash (Ollama)</option>
                <option value="kev" disabled={!kevReady}>Kev (local)</option>
              </select>
              {#if (model === "kev" ? kevReady : v?.decision)}
                <span class="pill" data-tone="ok">installé</span>
              {:else}
                <span class="pill" data-tone="off">absent</span>
              {/if}
            </div>
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
                <button class="primary" onclick={() => s.openUrl("https://orbstack.dev")}>Installer OrbStack</button>
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
      </section>
    {:else}
      <section data-testid="settings-about">
        <h2>À propos</h2>
        <div class="panel">
          <div class="row">
            <b class="grow" data-testid="app-version">{version === null ? "" : `WebAiOs ${version}`}</b>
            <button data-testid="open-advanced" onclick={() => s.openAdvanced()}>Réglages avancés du navigateur</button>
          </div>
        </div>
      </section>
    {/if}
  </div>
</section>

<style>
  .settings { display: grid; grid-template-columns: 200px 1fr; height: 100%; color: var(--text); font-size: 13px; }
  nav { display: flex; flex-direction: column; gap: 2px; padding: 20px 10px; background: var(--bg-bar); border-right: 1px solid var(--border); overflow-y: auto; }
  nav h1 { margin: 0 8px 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
  nav button { all: unset; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; color: var(--text-muted); cursor: default; }
  nav button :global(svg) { color: var(--text-muted); }
  nav button:hover { background: var(--bg-hover); color: var(--text); }
  nav button[aria-current="page"] { background: var(--bg-active); color: var(--text); }
  nav button[aria-current="page"] :global(svg) { color: var(--accent); }
  .settings :global(:is(button, input, select):focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .content { min-width: 0; overflow-y: auto; padding: 24px 32px; }
  .content > :global(section) { max-width: 720px; }
  .settings :global(h2) { margin: 0 0 16px; font-size: 20px; font-weight: 600; }
  .settings :global(h3) { margin: 22px 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
  .settings :global(p) { margin: 10px 4px; overflow-wrap: anywhere; }
  .settings :global(code) { font: 12px ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
  .settings :global(.muted) { color: var(--text-muted); }
  .settings :global(.alert) { color: var(--in-error); }
  .settings :global(.panel) { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-bar); overflow: hidden; }
  .settings :global(.panel > * + *) { border-top: 1px solid var(--border); }
  .settings :global(.row) { display: flex; align-items: center; gap: 10px; padding: 11px 14px; }
  .settings :global(.grow) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .settings :global(.grow b), .settings :global(b.grow) { font-weight: 600; }
  .settings :global(.grow .muted) { font-size: 12px; }
  /* A state: a dot of its tone and the text. */
  .settings :global(.pill) { --tone: var(--stopped); display: inline-flex; align-items: center; gap: 6px; max-width: 300px; padding: 3px 9px; border-radius: 10px; background: color-mix(in srgb, var(--tone) 16%, transparent); font-size: 12px; line-height: 1.35; flex: none; }
  .settings :global(.pill::before) { content: ""; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--tone); }
  .settings :global(.pill[data-tone="ok"]) { --tone: var(--running); }
  .settings :global(.pill[data-tone="warn"]) { --tone: var(--in-progress); }
  .settings :global(.pill[data-tone="error"]) { --tone: var(--in-error); }
  .content :global(button) { flex: none; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; }
  .content :global(button:hover:not(:disabled)) { background: var(--bg-hover); }
  .content :global(button:disabled) { opacity: 0.5; }
  .content :global(button.primary) { background: var(--accent); border-color: var(--accent); color: white; }
  .content :global(button.primary:hover:not(:disabled)) { background: color-mix(in srgb, var(--accent) 85%, black); }
  .content :global(button.danger) { color: var(--in-error); }
  .settings :global(.buttons) { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .settings :global(.buttons.start) { justify-content: flex-start; margin-top: 14px; }
  .settings :global(.confirmation) { margin: 12px 0; padding: 12px 14px; border-radius: 10px; background: var(--bg-bar); border: 1px solid var(--border); }
  .settings :global(.confirmation p) { margin: 0 0 12px; }
  .settings :global(.panel .confirmation) { margin: 0 14px 12px; background: var(--bg); }
  select { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; }
  .switch { appearance: none; position: relative; width: 34px; height: 20px; margin: 0; flex: none; border-radius: 10px; background: var(--bg-active); transition: background 0.15s; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: white; box-shadow: 0 1px 2px rgb(0 0 0 / 0.3); transition: left 0.15s; }
  .switch:checked { background: var(--accent); }
  .switch:checked::after { left: 16px; }
  .switch:disabled { opacity: 0.5; }
</style>
