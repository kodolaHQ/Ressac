<script lang="ts">
  import {
    apiUrlProblem,
    ClaudeEngineSchema,
    CodexEngineSchema,
    DEFAULT_CLAUDE_ENGINE,
    DEFAULT_CODEX_ENGINE,
    type ClaudeEngine,
    type CodexEngine,
  } from "../../shared/settings";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import OllamaModelPicker from "./OllamaModelPicker.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  // An agent's engine (Settings › Agent): its subscription, Ollama or a compatible API whose key stays in the keychain.
  let { agent }: { agent: "claude" | "codex" } = $props();
  const s = api.settings;
  type Engine = ClaudeEngine | CodexEngine;
  const A = $derived({
    claude: {
      agentName: "Claude Code",
      kinds: [
        { kind: "subscription", label: t("agent-engine-kind-subscription") },
        { kind: "ollama", label: "Ollama" },
        { kind: "api", label: t("agent-engine-kind-api") },
      ],
      schema: ClaudeEngineSchema,
      fallback: DEFAULT_CLAUDE_ENGINE,
      // Claude Code appends /v1/messages itself.
      apiPlaceholder: t("agent-engine-api-placeholder-claude"),
      apiFormat: t("agent-engine-api-format-claude"),
      choose: (e: Engine) => s.chooseClaudeEngine(e as ClaudeEngine),
      keySaved: s.claudeKeySaved,
      setKey: s.setClaudeKey,
      deleteKey: s.deleteClaudeKey,
    },
    codex: {
      agentName: "Codex",
      kinds: [
        { kind: "chatgpt", label: t("agent-engine-kind-chatgpt") },
        { kind: "ollama", label: "Ollama" },
        { kind: "api", label: t("agent-engine-kind-api-openai") },
      ],
      schema: CodexEngineSchema,
      fallback: DEFAULT_CODEX_ENGINE,
      apiPlaceholder: "https://openrouter.ai/api/v1",
      apiFormat: t("agent-engine-api-format-codex"),
      choose: (e: Engine) => s.chooseCodexEngine(e as CodexEngine),
      keySaved: s.codexKeySaved,
      setKey: s.setCodexKey,
      deleteKey: s.deleteCodexKey,
    },
  }[agent]);
  const engine = $derived<Engine>((agent === "claude" ? appState.value?.settings.claudeEngine : appState.value?.settings.codexEngine) ?? A.fallback);
  type Field = "ollamaUrl" | "ollamaModel" | "apiUrl" | "apiModel";
  let problems = $state<Partial<Record<Field, string>>>({});

  /** Validated on change (focus left, Enter): a wrong value stays in the field with its message, the setting keeps the old one. */
  function change(field: Field, value: string) {
    const next = { ...engine, [field]: value.trim() };
    const problem =
      field === "apiUrl"
        ? apiUrlProblem(next.apiUrl) && t("agent-engine-url-invalid-https")
        : A.schema.safeParse(next).success
          ? null
          : t(field === "ollamaUrl" ? "agent-engine-url-invalid" : "agent-engine-model-invalid");
    problems = { ...problems, [field]: problem ?? undefined };
    if (!problem) A.choose(next);
  }

  let keySaved = $state(false);
  let key = $state("");
  let keyError = $state<string | null>(null);
  $effect(() => void A.keySaved().then((k) => (keySaved = k)));
  async function saveKey() {
    const r = await A.setKey(key.trim());
    key = "";
    keyError = r.ok ? null : r.error;
    if (r.ok) keySaved = true;
  }
  async function deleteKey() {
    const r = await A.deleteKey();
    keyError = r.ok ? null : r.error;
    if (r.ok) keySaved = false;
  }
</script>

{#snippet text(field: Field, label: string, placeholder = "")}
  <label class="field">
    <span>{label}</span>
    <input data-testid={field === "ollamaUrl" ? "ollama-url" : field === "apiUrl" ? "api-url" : "api-model"} value={engine[field]} {placeholder} spellcheck="false" onchange={(e) => change(field, e.currentTarget.value)} />
    {#if problems[field]}<span class="alert" role="status">{problems[field]}</span>{/if}
  </label>
{/snippet}

<div data-testid="{agent}-engine">
  <SettingsRow label={t("agent-engine-label")} labelId="{agent}-engine-label" help={t("agent-engine-next-session")}>
    <div class="kinds" role="radiogroup" aria-labelledby="{agent}-engine-label">
      {#each A.kinds as k (k.kind)}
        <label><input type="radio" name="{agent}-engine" data-testid="engine-{k.kind}" checked={engine.kind === k.kind} onchange={() => A.choose({ ...engine, kind: k.kind } as Engine)} />{k.label}</label>
      {/each}
    </div>
    {#snippet below()}
      {#if engine.kind === "ollama"}
        <div class="fields appear">
          <span class="help" data-testid="{agent}-ollama-note">{t("agent-engine-ollama-note")}</span>
          {@render text("ollamaUrl", t("agent-engine-ollama-url"))}
          <div class="field">
            <span>{t("agent-engine-model")}</span>
            <OllamaModelPicker url={engine.ollamaUrl} value={engine.ollamaModel} onchange={(name) => change("ollamaModel", name)} />
            {#if problems.ollamaModel}<span class="alert" role="status">{problems.ollamaModel}</span>{/if}
          </div>
        </div>
      {:else if engine.kind === "api"}
        <div class="fields appear">
          {@render text("apiUrl", t("agent-engine-url"), A.apiPlaceholder)}
          {@render text("apiModel", t("agent-engine-model"))}
          <div class="field">
            <label for="{agent}-api-key">{t("agent-engine-key")}</label>
            <div class="key">
              {#if keySaved}
                <span class="pill" data-tone="ok" data-testid="api-key-saved">{t("agent-engine-key-saved")}</span>
                <button data-testid="api-key-delete" onclick={() => void deleteKey()}>{t("agent-engine-key-delete")}</button>
              {/if}
              <input id="{agent}-api-key" data-testid="api-key" type="password" autocomplete="off" spellcheck="false" bind:value={key} />
              <button data-testid="api-key-save" disabled={!key.trim()} onclick={() => void saveKey()}>{t("agent-engine-key-save")}</button>
            </div>
            {#if keyError}<span class="alert" role="status">{keyError}</span>{/if}
          </div>
          <span class="help">{t("agent-engine-api-note", { format: A.apiFormat, agent: A.agentName })}</span>
        </div>
      {/if}
    {/snippet}
  </SettingsRow>
</div>

<style>
  /* Stretched as a setting's .line: in the column of .control (aligned to the start), a long model name in the select would size it past the card. */
  .fields { align-self: stretch; min-width: 0; display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
  .key { display: flex; align-items: center; gap: 8px; }
  .key input { flex: 1; min-width: 0; }
  .alert { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
