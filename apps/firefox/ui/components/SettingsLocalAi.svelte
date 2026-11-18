<script lang="ts">
  import type { LocalAiStateShown } from "../../shared/api";
  import { DECISION_MODEL, SEARCH_MODEL, type PullProgress } from "../../shared/settings";
  import { aiOn, api } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import AiAsleep from "./AiAsleep.svelte";
  import { showSection } from "./settings-section.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  let ai = $state<LocalAiStateShown | null>(null);
  const v = $derived(ai?.verification);
  const reloadAi = () => void api.ai.state().then((r) => (ai = r));
  $effect(() => {
    if (aiOn()) reloadAi();
  });

  // Model downloads: the host runs one at a time and reports it; polled like the workshop operation.
  let pulling = $state<PullProgress | null>(null);
  /** The last download started here that failed, shown under its model's row. */
  let pullError = $state<{ name: string; error: string } | null>(null);
  let writer = $state<"claude" | "codex" | "workshop-stopped" | null | undefined>(undefined);
  // Read when Réglages opens: the host re-checks the accounts then.
  $effect(() => {
    if (aiOn()) void s.writer().then((r) => (writer = r.agent));
  });
  async function pullModel(name: string) {
    pullError = null;
    pulling = { name, percent: null, status: "" };
    const timer = setInterval(() => void s.pullProgress().then((p) => p && (pulling = p)), 700);
    const r = await s.pullModel(name);
    clearInterval(timer);
    pulling = null;
    if (!r.ok) pullError = { name, error: r.error };
    reloadAi();
  }
  // A pull started elsewhere (the welcome, another window) shows here until it ends.
  $effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    if (!aiOn()) return;
    void s.pullProgress().then((p) => {
      // Cleaned up before the answer came: no poll left behind.
      if (!p || pulling || stopped) return;
      pulling = p;
      timer = setInterval(() => void s.pullProgress().then((q) => {
        if (q) return void (pulling = q);
        clearInterval(timer);
        pulling = null;
        reloadAi();
      }), 700);
    });
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });
  const pullLabel = (p: PullProgress) => (p.percent === null ? t("settings-pull-progress-unknown") : t("settings-pull-progress", { percent: p.percent }));
</script>

<!-- One of Ressac's models: its name and use, one error line at most, and « installé » or « absent » with a download button. -->
{#snippet model(id: "decision" | "search", name: string, installed: boolean, title: string, detail: string, failed: string | undefined, serverError: string | null | undefined)}
  <div class="row" data-testid="ai-{id}">
    <div class="grow">
      <b>{title}</b><span class="muted">{detail}</span>
      {#if pullError?.name === name}
        <span class="alert appear" data-testid="pull-error">{pullError.error}</span>
      {:else if failed && !installed && pulling?.name !== name}
        <span class="alert appear" data-testid="ai-{id}-error">{t("settings-ai-model-failed", { reason: failed })}</span>
      {:else if serverError}
        <span class="alert appear" data-testid="ai-{id}-server-error">{serverError}</span>
      {/if}
    </div>
    {#if installed}
      <span class="pill" data-tone="ok">{t("settings-pill-installed")}</span>
    {:else if pulling?.name === name}
      <span class="pill" data-tone="warn" data-testid="pull-progress-{id}">{pullLabel(pulling)}</span>
    {:else}
      <span class="pill" data-tone="off">{t("settings-pill-absent")}</span>
      <button data-testid="pull-{id}" disabled={!!pulling} onclick={() => void pullModel(name)}>{t("settings-pull-download")}</button>
    {/if}
  </div>
{/snippet}

<section data-testid="settings-ai" aria-label={t("settings-section-ai")}>
  <p class="intro">{t("settings-ai-intro")}</p>
  {#if !aiOn()}
    <AiAsleep feature="settings" />
  {:else if !ai}
    <p class="status"><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
  {:else if !v}
    <!-- Only the silent host gives no verification. -->
    <p class="status"><span class="pill" data-tone="error" data-testid="ai-error">{ai.error ?? t("settings-agent-silent")}</span></p>
  {:else}
    <div class="group">
      {@render model("decision", DECISION_MODEL, !!v.decision, t("settings-ai-decision-model"), t("settings-ai-decision-detail"), ai.decisionError, ai.state === "error" ? ai.error : null)}
      {@render model("search", SEARCH_MODEL, !!v.embed, t("settings-ai-search-model"), t("settings-ai-search-detail"), ai.searchError, ai.searchServerError)}
      <div class="row" data-testid="ai-writer">
        <div class="grow"><b>{t("settings-ai-writer")}</b><span class="muted">{writer === undefined ? "" : t(`settings-ai-writer-${writer ?? "none"}`)}</span></div>
        {#if writer === null}<button data-testid="ai-writer-connect" onclick={() => showSection("agent")}>{t("settings-ai-writer-connect")}</button>{/if}
      </div>
    </div>
  {/if}
</section>
