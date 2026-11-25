<script lang="ts">
  import { fade } from "svelte/transition";
  import { validAgentDomain, type AgentAccount, type LoginResult } from "../../shared/settings";
  import { aiOn, api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import AiAsleep from "./AiAsleep.svelte";
  import LiftLock from "./LiftLock.svelte";
  import type { QuarantinedFile } from "../../shared/api";
  import SettingsEngine from "./SettingsEngine.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  let agents = $state<AgentAccount[] | null>(null);
  // The textarea's draft (null until typed in); a bad line stays listed under it, never saved.
  let domainsText = $state<string | null>(null);
  let domainsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Saved while typing too: a click straight into the agent's terminal may never blur the field (seen 2026-11-15). */
  const saveDomains = () => {
    clearTimeout(domainsTimer);
    if (domainsText !== null) api.dispatch({ type: "chooseAgentDomains", domains: domainLines(domainsText) });
  };
  const rawLines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  /** A pasted address keeps its name only: `https://example.com/page` → `example.com`. */
  const asDomain = (line: string) => line.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#:].*$/, "").replace(/\.$/, "");
  const domainLines = (text: string) => rawLines(text).map(asDomain);
  const ignoredDomains = $derived(domainsText === null ? [] : [...new Set(rawLines(domainsText).filter((l) => !validAgentDomain(asDomain(l))))]);
  /** Each account's sign-in in progress: null while the host starts it, then its code or its error. */
  let logins = $state<Record<string, LoginResult | null>>({});
  const loadAgents = async () => {
    agents = await s.agents();
    // A finished sign-in forgets its code: after a logout, the row offers Se connecter again.
    for (const a of agents) if (a.state === "logged-in") delete logins[a.id];
    // A code still shown whose sign-in ended without signing in (expired, or stopped before an agent session): say so, offer it again.
    else if (logins[a.id]?.kind === "device" && !a.signingIn) logins[a.id] = { kind: "error", error: t("settings-agent-device-interrupted") };
  };
  // AI off: the accounts show the asleep card and ask nothing of the host.
  $effect(() => void (aiOn() && loadAgents()));
  // Claude signs in in the agent panel (which builds the workshop if needed), Codex by a code on OpenAI's site: re-read only while one is awaited (a Codex code shown, or Claude signed out).
  // A check that failed during a sign-in by code keeps the code and the polling: the sign-in is still running.
  const signIn = (a: AgentAccount) => !!a.signingIn || a.state === "logged-out" || a.state === "no-container";
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
  /** The workspace lock (its names) and the files a lift put in quarantine: read again on each masking change. */
  let locked = $state<string[] | null>(null);
  let lifting = $state(false);
  let quarantined = $state<QuarantinedFile[]>([]);
  let restoreError = $state<string | null>(null);
  const readLock = () => {
    void api.agent.masking().then((m) => {
      locked = m.locked;
      if (!m.locked) lifting = false;
    });
    void api.agent.lock.quarantine().then((q) => (quarantined = q));
  };
  $effect(() => {
    if (!aiOn()) return;
    readLock();
    return api.agent.onMasking(readLock);
  });
  async function restore(id: string) {
    restoreError = null;
    const r = await api.agent.lock.restore(id);
    if (!r.ok) restoreError = r.error;
    readLock();
  }
  // Claude on Ollama or an API starts without its subscription: no nudge to sign in.
  const claudeSubscription = $derived((appState.value?.settings.claudeEngine.kind ?? "subscription") === "subscription");
</script>

<section data-testid="settings-agent" aria-label={t("settings-section-agent")}>
  <div class="group">
    <SettingsRow label={t("settings-ai-switch")} id="ai-switch" help={t("settings-ai-switch-note")}>
      <input
        id="ai-switch"
        class="switch"
        type="checkbox"
        role="switch"
        data-testid="settings-ai-switch"
        aria-describedby="ai-switch-help"
        checked={aiOn()}
        onchange={(e) => api.dispatch({ type: e.currentTarget.checked ? "enableAi" : "disableAi" })}
      />
    </SettingsRow>
  </div>
  {#if !aiOn()}
    <AiAsleep feature="settings" />
  {:else if !agents}
    <p class="status"><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
  {:else}
    {#each agents as a (a.id)}
      <h3 class="group-title">{a.name}</h3>
      <div class="group">
        <div data-testid="agent-{a.id}">
          <SettingsRow label={t("settings-agent-account")}>
            <span class="pill" data-tone={agentTone(a)}>{agentText(a)}</span>
            {#if signIn(a)}
              {@const l = logins[a.id]}
              {#if l?.kind === "device"}
                <button class="primary" data-testid="device-open" onclick={() => s.openUrl(l.url)}>{t("settings-agent-device-open")}</button>
              {:else}
                <button class:primary={a.id !== "claude" || claudeSubscription} data-testid="agent-login" disabled={l === null} onclick={() => void login(a.id)}>{t("settings-agent-login")}</button>
              {/if}
            {:else if a.state === "logged-in"}
              <button data-testid="agent-logout" onclick={() => void logout(a.id)}>{t("settings-agent-logout")}</button>
            {/if}
            {#snippet below()}
              {#if signIn(a)}
                {@const l = logins[a.id]}
                {#if l?.kind === "device"}
                  <span class="help">{t("settings-agent-device-code")} <code data-testid="device-code">{l.code}</code></span>
                  <span class="help">{t("settings-agent-device-waiting")}</span>
                {:else if l?.kind === "error"}
                  <span class="alert appear">{t("settings-error", { error: l.error })}</span>
                {:else if a.login === "panel"}
                  {#if claudeSubscription}<span class="help">{t("settings-agent-panel-login")}</span>{/if}
                {:else}
                  <span class="help">{t("settings-agent-codex-login")}</span>
                {/if}
              {:else if a.state === "logged-in"}
                <span class="help">{t("settings-agent-open-chats")}</span>
              {/if}
            {/snippet}
          </SettingsRow>
        </div>
        {#if a.id === "claude" || a.id === "codex"}<SettingsEngine agent={a.id} />{/if}
      </div>
    {:else}
      <p class="status"><span class="pill" data-tone="error">{t("settings-agent-silent-sentence")}</span></p>
    {/each}
  {/if}
  {#if aiOn()}
    <div class="group">
      <SettingsRow label={t("settings-agent-domains")} id="agent-domains" help={t("settings-agent-domains-help")}>
        <textarea
          id="agent-domains"
          class="wide"
          data-testid="settings-agent-domains"
          aria-describedby="agent-domains-help"
          rows="4"
          spellcheck="false"
          value={domainsText ?? appState.value?.settings.agentDomains.join("\n") ?? ""}
          oninput={(e) => {
            domainsText = e.currentTarget.value;
            clearTimeout(domainsTimer);
            domainsTimer = setTimeout(saveDomains, 500);
          }}
          onblur={saveDomains}
        ></textarea>
        {#snippet below()}
          {#each ignoredDomains as line (line)}
            <span class="pill appear" data-tone="warn" data-testid="settings-agent-domains-ignored" out:fade={{ duration: 150 }}>{t("settings-agent-domains-ignored", { line })}</span>
          {/each}
        {/snippet}
      </SettingsRow>
    </div>
    {#if locked}
      <h3 class="group-title appear" out:fade={{ duration: 150 }}>{t("settings-lock-title")}</h3>
      <div class="group appear" data-testid="settings-lock" out:fade={{ duration: 150 }}>
        {#if lifting}
          <LiftLock names={locked} onClose={() => (lifting = false)} />
        {:else}
          <SettingsRow label={t("agent-lift-title")}>
            <button data-testid="settings-lift-open" onclick={() => (lifting = true)}>{t("agent-lift-open")}</button>
          </SettingsRow>
        {/if}
      </div>
    {/if}
    {#if quarantined.length}
      <h3 class="group-title appear" out:fade={{ duration: 150 }}>{t("settings-quarantine-title")}</h3>
      <div class="group appear" data-testid="settings-quarantine" out:fade={{ duration: 150 }}>
        <p class="help">{t("settings-quarantine-help")}</p>
        {#each quarantined as q (q.id)}
          <div data-testid="settings-quarantine-file" data-path={q.path} out:fade={{ duration: 150 }}>
            <SettingsRow label={q.path}>
              <button data-testid="settings-quarantine-reveal" onclick={() => s.reveal(`${s.dataDir()}/masking/quarantine/${q.id}`)}>{t("agent-data-reveal")}</button>
              <button data-testid="settings-quarantine-restore" onclick={() => void restore(q.id)}>{t("settings-quarantine-restore")}</button>
            </SettingsRow>
          </div>
        {/each}
        {#if restoreError}<span class="alert appear">{t("settings-error", { error: restoreError })}</span>{/if}
      </div>
    {/if}
  {/if}
</section>
