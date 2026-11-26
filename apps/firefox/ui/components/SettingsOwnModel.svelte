<script lang="ts">
  import { untrack } from "svelte";
  import { apiUrlProblem, DEFAULT_OWN_ENGINE, isOnMac, OwnEngineSchema, type OwnEngine } from "../../shared/settings";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import OllamaModelPicker from "./OllamaModelPicker.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  // « Votre modèle » (Réglages › Agent): Ollama on this Mac or an OpenAI-compatible API, checked by the host before it is saved.
  const s = api.settings;
  const engine = $derived<OwnEngine>(appState.value?.settings.ownEngine ?? DEFAULT_OWN_ENGINE);
  type Field = "ollamaUrl" | "ollamaModel" | "apiUrl" | "apiModel";
  let problems = $state<Partial<Record<Field, string>>>({});
  /** The field a refusal of the whole setting shows under: the kind's address. */
  const urlField = (e: OwnEngine): Field => (e.kind === "ollama" ? "ollamaUrl" : "apiUrl");

  /**
   * Validated here, then by the host (Ollama on this Mac only): a refused value stays in the field with its message.
   * Resolves to the engine saved, null when refused.
   */
  async function choose(next: OwnEngine, field: Field): Promise<OwnEngine | null> {
    const problem =
      field === "apiUrl" && next.apiUrl && apiUrlProblem(next.apiUrl)
        ? t("agent-engine-url-invalid-https")
        : OwnEngineSchema.safeParse(next).success
          ? null
          : t(field.endsWith("Url") ? "agent-engine-url-invalid" : "agent-engine-model-invalid");
    problems = { ...problems, [field]: problem ?? undefined };
    if (problem) return null;
    const r = await s.chooseOwnEngine(next);
    problems = { ...problems, [field]: r.ok ? undefined : r.error };
    checked = null;
    return r.ok ? next : null;
  }
  /** The last save from this page: « Enregistrer la clé » waits for it, so the key binds to the address really saved. */
  let saving: Promise<OwnEngine | null | undefined> = Promise.resolve(undefined);
  const save = (next: OwnEngine, field: Field) => void (saving = choose(next, field));
  const change = (field: Field, value: string) => save({ ...engine, [field]: value.trim() }, field);
  // The saved setting, asked again once loaded: one the host refused at start (an address it no longer accepts) shows its refusal here.
  let rechecked = false;
  $effect(() => {
    const saved = appState.value?.settings.ownEngine;
    if (!saved || rechecked) return;
    rechecked = true;
    untrack(() => {
      void s.chooseOwnEngine(saved).then((r) => {
        if (!r.ok) problems = { ...problems, [urlField(saved)]: r.error };
      });
    });
  });

  const model = $derived(engine.kind === "ollama" ? engine.ollamaModel : engine.apiModel);
  // The host's rule (shared): anything not on loopback is off this Mac. A saved apiUrl always parses.
  // An Ollama cloud model: the local Ollama forwards its messages to the model's host.
  let ollamaCloud = $state<string | null>(null);
  const remoteHost = $derived(engine.kind === "api" ? (engine.apiUrl && !isOnMac(engine.apiUrl) ? new URL(engine.apiUrl).host : null) : ollamaCloud);

  let keySaved = $state(false);
  let key = $state("");
  let keyError = $state<string | null>(null);
  $effect(() => void s.ownKeySaved().then((k) => (keySaved = k)));
  async function saveKey() {
    // A URL typed just before (its change still with the host) decides where the key goes; a refused one takes no key.
    const pending = saving;
    const saved = await pending;
    if (saving === pending) saving = Promise.resolve(undefined);
    if (problems.apiUrl) return void (keyError = problems.apiUrl);
    const url = saved?.apiUrl ?? engine.apiUrl;
    if (!url) return;
    const r = await s.setOwnKey(key.trim(), url);
    key = "";
    keyError = r.ok ? null : r.error;
    if (r.ok) keySaved = true;
    void readModels();
  }
  async function deleteKey() {
    const r = await s.deleteOwnKey();
    keyError = r.ok ? null : r.error;
    if (r.ok) keySaved = false;
    void readModels();
  }

  /** The API's models; `keyNotSent`: the saved key belongs to another address. Only the latest read applies. */
  let listed = $state<{ models: string[]; error: string | null; keyNotSent: string | null } | null>(null);
  let reads = 0;
  async function readModels() {
    const n = ++reads;
    if (engine.kind !== "api" || !engine.apiUrl) return void (listed = null);
    const r = await s.ownModels(engine.apiUrl);
    if (n === reads) listed = { models: r.ok ? r.models : [], error: r.ok ? null : r.error, keyNotSent: r.keyNotSent ?? null };
  }
  $effect(() => {
    void engine.kind;
    void engine.apiUrl;
    untrack(() => void readModels());
  });

  let checking = $state(false);
  let checked = $state<{ ok: true; model: string } | { ok: false; error: string } | null>(null);
  async function check() {
    checking = true;
    checked = await s.ownCheck();
    checking = false;
  }
</script>

{#snippet text(field: Field, testid: string, label: string, placeholder = "")}
  <label class="field">
    <span>{label}</span>
    <input data-testid={testid} value={engine[field]} {placeholder} spellcheck="false" onchange={(e) => change(field, e.currentTarget.value)} />
    {#if problems[field]}<span class="alert" role="status">{problems[field]}</span>{/if}
  </label>
{/snippet}

<h3 class="group-title">{t("own-title")}</h3>
<div class="group" data-testid="own-engine">
  <SettingsRow label={t("agent-engine-label")} labelId="own-engine-label" help={t("own-help")}>
    <div class="kinds" role="radiogroup" aria-labelledby="own-engine-label">
      {#each [["ollama", "own-kind-ollama"], ["api", "own-kind-api"]] as const as [kind, name] (kind)}
        <label><input type="radio" name="own-engine" data-testid="own-kind-{kind}" checked={engine.kind === kind} onchange={() => save({ ...engine, kind }, kind === "ollama" ? "ollamaUrl" : "apiUrl")} />{t(name)}</label>
      {/each}
    </div>
    {#snippet below()}
      {#if engine.kind === "ollama"}
        <div class="fields appear">
          {@render text("ollamaUrl", "ollama-url", t("own-ollama-url"))}
          <div class="field">
            <span>{t("own-model")}</span>
            <OllamaModelPicker url={engine.ollamaUrl} value={engine.ollamaModel} online bind:cloud={ollamaCloud} onchange={(name) => change("ollamaModel", name)} />
            {#if problems.ollamaModel}<span class="alert" role="status">{problems.ollamaModel}</span>{/if}
          </div>
        </div>
      {:else}
        <div class="fields appear">
          {@render text("apiUrl", "api-url", t("own-api-url"), "https://api.exemple.com/v1")}
          <div class="field">
            <label for="own-api-key">{t("own-api-key")}</label>
            <div class="key">
              {#if keySaved}
                <span class="pill" data-tone="ok" data-testid="api-key-saved">{t("own-api-key-saved")}</span>
                <button data-testid="api-key-delete" onclick={() => void deleteKey()}>{t("own-api-key-delete")}</button>
              {/if}
              <input id="own-api-key" data-testid="api-key" type="password" autocomplete="off" spellcheck="false" bind:value={key} />
              <button data-testid="api-key-save" disabled={!key.trim() || !engine.apiUrl} onclick={() => void saveKey()}>{t("agent-engine-key-save")}</button>
            </div>
            {#if keyError}<span class="alert" role="status">{keyError}</span>{/if}
            {#if listed?.keyNotSent}<span class="alert" role="status" data-testid="own-key-not-sent">{listed.keyNotSent}</span>{/if}
          </div>
          <div class="field">
            <span>{t("own-model")}</span>
            {#if listed?.models.length}
              <select data-testid="own-api-model" aria-label={t("own-model")} value={engine.apiModel} onchange={(e) => change("apiModel", e.currentTarget.value)}>
                {#if !listed.models.includes(engine.apiModel)}<option value={engine.apiModel} disabled>{engine.apiModel || t("agent-ollama-choose")}</option>{/if}
                {#each listed.models as m (m)}<option value={m}>{m}</option>{/each}
              </select>
            {/if}
            <input data-testid="own-api-model-typed" aria-label={t("own-model-typed")} placeholder={t("own-model-typed")} value={engine.apiModel} spellcheck="false" onchange={(e) => change("apiModel", e.currentTarget.value)} />
            {#if problems.apiModel}<span class="alert" role="status">{problems.apiModel}</span>{/if}
            {#if listed?.error}<span class="help appear">{listed.error}</span>{/if}
          </div>
        </div>
      {/if}
      {#if !model}
        <span class="help appear" data-testid="own-none">{t("own-none")}</span>
      {:else}
        <span class="help appear" data-testid="own-where">{remoteHost ? t("own-off-mac", { host: remoteHost }) : t("own-on-mac")}</span>
        <div class="key">
          <button data-testid="own-check" disabled={checking} onclick={() => void check()}>{t("own-check")}</button>
          {#if checked}
            {#key checked}
              {#if checked.ok}
                <span class="pill appear" data-tone="ok" data-testid="own-check-result">{t("own-check-ok", { model: checked.model })}</span>
              {:else}
                <span class="alert" role="status" data-testid="own-check-result">{checked.error}</span>
              {/if}
            {/key}
          {/if}
        </div>
      {/if}
    {/snippet}
  </SettingsRow>
</div>

<style>
  /* As SettingsEngine.svelte. */
  .fields { align-self: stretch; min-width: 0; display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
  .key { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .key input { flex: 1; min-width: 0; }
  .alert { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
