<script lang="ts">
  import type { LocalAiStateShown, SettingsApi } from "../../shared/api";
  import { TELEMETRY_NOTICE, type AgentAccount, type DecisionModel, type WorkshopOperation } from "../../shared/settings";
  import { api, appState } from "../state.svelte";
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
  <h1>Réglages</h1>

  <section data-testid="settings-agents">
    <h2>Agents</h2>
    {#if !agents}
      <p class="muted">Vérification…</p>
    {:else}
      {#each agents as a (a.id)}
        <div class="row" data-testid="agent-{a.id}">
          <div class="grow">
            <b>{a.name}</b>
            <span class="muted">{agentText(a)}</span>
          </div>
          {#if signIn(a)}
            <div class="with-hint">
              <button data-testid="agent-login" onclick={() => s.login(a.id)}>Se connecter</button>
              <span class="hint">Claude Code vous demande de vous connecter dans le panneau de l'agent ; sinon, tapez /login.</span>
            </div>
          {:else if a.state === "logged-in"}
            <div class="with-hint">
              <button data-testid="agent-logout" onclick={() => void logout(a.id)}>Se déconnecter</button>
              <span class="hint">Les conversations déjà ouvertes continuent jusqu'à leur relance.</span>
            </div>
          {/if}
        </div>
      {:else}
        <p class="alert">L'agent ne répond pas.</p>
      {/each}
    {/if}
  </section>

  <section data-testid="settings-ai">
    <h2>IA locale</h2>
    {#if !ai}
      <p class="muted">Vérification…</p>
    {:else if !ai.ollamaUrl}
      <!-- Only the silent host gives no address; a failed check still shows Ollama as unreachable. -->
      <p class="alert" data-testid="ai-error">{ai.error ?? "L'agent ne répond pas"}</p>
    {:else}
      <p data-testid="ai-ollama">Ollama : {v?.ollama ? "joignable" : "injoignable"} ({ai.ollamaUrl})</p>
      <p data-testid="ai-gemma">Gemma : {v?.gemma ? "installé" : "absent"} <span class="muted">— Widgets et veille : Gemma (gemma4:e4b-mlx)</span></p>
      <p class="model">
        <label>
          Modèle de décision
          <select data-testid="ai-decision-model" value={model} onchange={(e) => s.chooseDecisionModel(e.currentTarget.value as DecisionModel)}>
            <option value="pplx-decider-flash">pplx-decider-flash (Ollama)</option>
            <option value="kev" disabled={!kevReady}>Kev (local)</option>
          </select>
        </label>
        <span class="muted">{(model === "kev" ? kevReady : v?.decision) ? "installé" : "absent"}</span>
      </p>
    {/if}
  </section>

  <section data-testid="settings-workshop">
    <h2>Conteneur</h2>
    {#if workshop === undefined}
      <p class="muted">Vérification…</p>
    {:else}
      <p data-testid="workshop-state">
        {operation === "restart" ? "Redémarrage…" : operation === "rebuild" ? "Reconstruction… (quelques minutes)" : workshop ? WORKSHOP[workshop] : "L'agent ne répond pas"}
      </p>
      {#if workshop === "docker-absent"}
        <button onclick={() => s.openUrl("https://orbstack.dev")}>Installer OrbStack</button>
      {/if}
      {#if workshopError}<p class="alert" role="status">{workshopError}</p>{/if}
      <div class="buttons">
        <button data-testid="workshop-restart" disabled={!!operation} onclick={() => (asking = "restart")}>Redémarrer</button>
        <button data-testid="workshop-rebuild" disabled={!!operation} onclick={() => (asking = "rebuild")}>Reconstruire</button>
      </div>
      {#if asking && !operation}
        {@const kind = asking}
        <div class="confirmation" role="alertdialog" aria-label={kind === "restart" ? "Redémarrer" : "Reconstruire"}>
          <p>{CONFIRM[kind]}</p>
          <div class="buttons">
            <button onclick={() => (asking = null)}>Annuler</button>
            <button class="confirm" data-testid="confirm-workshop" onclick={() => void operate(kind)}>{kind === "restart" ? "Redémarrer" : "Reconstruire"}</button>
          </div>
        </div>
      {/if}
    {/if}
  </section>

  <SettingsPermissions />
  <SettingsData />

  <section data-testid="settings-privacy">
    <h2>Vie privée</h2>
    {#if !telemetry}
      <p class="muted">Vérification…</p>
    {:else}
      <label class="switch">
        <input
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
        Envoyer les plantages et les erreurs
      </label>
      <p class="muted" id="telemetry-notice">{TELEMETRY_NOTICE}</p>
      {#if !telemetry.available}<p>Cette version n'envoie rien.</p>{/if}
    {/if}
  </section>

  <section data-testid="settings-about">
    <h2>À propos</h2>
    <p data-testid="app-version">{version === null ? "" : `WebAiOs ${version}`}</p>
    <button data-testid="open-advanced" onclick={() => s.openAdvanced()}>Réglages avancés du navigateur</button>
  </section>
</section>

<style>
  .settings { height: 100%; overflow-y: auto; padding: 20px 24px; box-sizing: border-box; color: var(--text); }
  h1 { margin: 0 0 14px; font-size: 18px; }
  .settings :global(section) { padding: 12px 0 16px; border-bottom: 1px solid var(--border); }
  .settings :global(h2) { margin: 0 0 8px; font-size: 14px; }
  .settings :global(p) { margin: 4px 0; font-size: 13px; overflow-wrap: anywhere; }
  .settings :global(button) { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-bar); color: var(--text); font-size: 12px; }
  .settings :global(button:hover:not(:disabled)) { background: var(--bg-hover); }
  .settings :global(button:disabled) { opacity: 0.5; }
  .settings :global(.muted) { color: var(--text-muted); }
  .settings :global(.alert) { color: var(--in-error); }
  .settings :global(.row) { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .settings :global(.grow) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
  .settings :global(.buttons) { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .settings :global(.confirmation) { max-width: 520px; margin-top: 10px; padding: 12px 14px; border-radius: 10px; background: var(--bg-bar); border: 1px solid var(--border); }
  .settings :global(.confirmation .confirm) { background: var(--accent); border-color: var(--accent); color: white; }
  .with-hint { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; max-width: 280px; }
  .hint { font-size: 11px; color: var(--text-muted); text-align: right; }
  .model { display: flex; align-items: center; gap: 10px; }
  .model label { display: flex; align-items: center; gap: 8px; }
  select { padding: 3px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-bar); color: var(--text); }
  .switch { display: flex; align-items: center; gap: 8px; font-size: 13px; }
</style>
