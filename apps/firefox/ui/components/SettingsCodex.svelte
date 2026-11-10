<script lang="ts">
  import { apiUrlProblem, CodexEngineSchema, DEFAULT_CODEX_ENGINE, type CodexEngine, type CodexEngineKind } from "../../shared/settings";
  import { api, appState } from "../state.svelte";

  // Codex's engine (Settings › Agents): ChatGPT, Ollama or an OpenAI-compatible API whose key stays in the keychain.
  const s = api.settings;
  const engine = $derived<CodexEngine>(appState.value?.settings.codexEngine ?? DEFAULT_CODEX_ENGINE);
  const KINDS: { kind: CodexEngineKind; label: string }[] = [
    { kind: "chatgpt", label: "Abonnement ChatGPT" },
    { kind: "ollama", label: "Ollama" },
    { kind: "api", label: "API compatible OpenAI" },
  ];
  type Field = "ollamaUrl" | "ollamaModel" | "apiUrl" | "apiModel";
  let problems = $state<Partial<Record<Field, string>>>({});

  /** Validated on change (focus left, Enter): a wrong value stays in the field with its message, the setting keeps the old one. */
  function change(field: Field, value: string) {
    const next = { ...engine, [field]: value.trim() };
    const problem =
      field === "apiUrl" ? apiUrlProblem(next.apiUrl) : CodexEngineSchema.safeParse(next).success ? null : field === "ollamaUrl" ? "Adresse invalide" : "Modèle invalide";
    problems = { ...problems, [field]: problem ?? undefined };
    if (!problem) s.chooseCodexEngine(next);
  }

  let keySaved = $state(false);
  let key = $state("");
  let keyError = $state<string | null>(null);
  $effect(() => void s.codexKeySaved().then((k) => (keySaved = k)));
  async function saveKey() {
    const r = await s.setCodexKey(key.trim());
    key = "";
    keyError = r.ok ? null : r.error;
    if (r.ok) keySaved = true;
  }
  async function deleteKey() {
    const r = await s.deleteCodexKey();
    keyError = r.ok ? null : r.error;
    if (r.ok) keySaved = false;
  }
</script>

{#snippet text(field: Field, label: string, placeholder = "")}
  <label class="field">
    <span>{label}</span>
    <input data-testid={field === "ollamaUrl" ? "ollama-url" : field === "ollamaModel" ? "ollama-model" : field === "apiUrl" ? "api-url" : "api-model"} value={engine[field]} {placeholder} spellcheck="false" onchange={(e) => change(field, e.currentTarget.value)} />
    {#if problems[field]}<span class="alert" role="status">{problems[field]}</span>{/if}
  </label>
{/snippet}

<div class="engine" data-testid="codex-engine">
  <b>Moteur de Codex</b>
  <div class="kinds" role="radiogroup" aria-label="Moteur de Codex">
    {#each KINDS as k (k.kind)}
      <label><input type="radio" name="codex-engine" data-testid="engine-{k.kind}" checked={engine.kind === k.kind} onchange={() => s.chooseCodexEngine({ ...engine, kind: k.kind })} />{k.label}</label>
    {/each}
  </div>
  {#if engine.kind === "ollama"}
    {@render text("ollamaUrl", "Adresse (vue depuis le conteneur)")}
    {@render text("ollamaModel", "Modèle")}
  {:else if engine.kind === "api"}
    {@render text("apiUrl", "Adresse", "https://openrouter.ai/api/v1")}
    {@render text("apiModel", "Modèle")}
    <div class="field">
      <label for="codex-api-key">Clé</label>
      <div class="key">
        {#if keySaved}
          <span class="pill" data-tone="ok" data-testid="api-key-saved">clé enregistrée</span>
          <button data-testid="api-key-delete" onclick={() => void deleteKey()}>Effacer la clé</button>
        {/if}
        <input id="codex-api-key" data-testid="api-key" type="password" autocomplete="off" spellcheck="false" bind:value={key} />
        <button data-testid="api-key-save" disabled={!key.trim()} onclick={() => void saveKey()}>Enregistrer la clé</button>
      </div>
      {#if keyError}<span class="alert" role="status">{keyError}</span>{/if}
    </div>
    <span class="muted">L'API doit accepter le format Responses d'OpenAI (/responses). La clé reste dans le Trousseau de votre Mac : Codex ne la voit jamais.</span>
  {/if}
  <span class="muted">S'applique à la prochaine conversation avec Codex.</span>
</div>

<style>
  .engine { display: flex; flex-direction: column; gap: 10px; padding: 11px 14px; }
  .engine b { font-weight: 600; }
  .kinds { display: flex; flex-wrap: wrap; gap: 16px; }
  .kinds label { display: inline-flex; align-items: center; gap: 6px; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .key { display: flex; align-items: center; gap: 8px; }
  .key input { flex: 1; }
  .muted { font-size: 12px; }
  input:not([type="radio"]) { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 12px; }
</style>
