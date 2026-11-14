<script lang="ts">
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";

  // An Ollama model picked among the installed ones (read by the host); a name typed by hand when Ollama has none to offer.
  let { url, value, onchange }: { url: string; value: string; onchange: (name: string) => void } = $props();
  let models = $state<{ name: string; size?: string }[] | null>(null);
  let error = $state<string | null>(null);
  // Only the latest read applies: an older answer must not overwrite a newer one.
  let reads = 0;
  async function read() {
    const n = ++reads;
    const r = await api.settings.ollamaModels(url);
    if (n !== reads) return;
    models = r.ok && r.models.length ? r.models : null;
    error = !r.ok ? r.error : r.models.length ? null : t("agent-ollama-none");
  }
  $effect(() => {
    void url;
    void read();
  });
  const missing = $derived(value !== "" && !!models && !models.some((m) => m.name === value));
</script>

<div class="picker">
  {#if models}
    <select data-testid="ollama-model" aria-label={t("agent-engine-model")} {value} onchange={(e) => onchange(e.currentTarget.value)}>
      {#if value === ""}<option value="" disabled>{t("agent-ollama-choose")}</option>{/if}
      {#if missing}<option value={value}>{t("agent-ollama-missing", { name: value })}</option>{/if}
      {#each models as m (m.name)}<option value={m.name}>{m.name}{m.size ? ` · ${m.size}` : ""}</option>{/each}
    </select>
  {:else}
    <input data-testid="ollama-model" aria-label={t("agent-engine-model")} {value} spellcheck="false" onchange={(e) => onchange(e.currentTarget.value)} />
  {/if}
  <button data-testid="ollama-refresh" onclick={() => void read()}>{t("agent-ollama-refresh")}</button>
</div>
{#if error}<span class="alert" role="status">{error}</span>{/if}

<style>
  .picker { display: flex; align-items: center; gap: 8px; }
  .picker > :is(select, input) { flex: 1; min-width: 0; }
  .alert { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
