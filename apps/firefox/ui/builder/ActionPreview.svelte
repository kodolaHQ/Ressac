<script lang="ts">
  import type { PageAction } from "@ressac/kernel";
  import { t } from "../i18n.svelte";
  import PageRender from "../action/PageRender.svelte";
  import { actionContext } from "../action/types";
  import { api } from "../state.svelte";
  import type { Executions } from "./executions.svelte";

  /**
   * The action's floating preview: the page of the run chosen in the list (a trial included), small. Reading a page
   * relaunches nothing; a trial never becomes the action's latest result there. The agent's components are not loaded
   * there (a neutral frame replaces them).
   */
  let { id, runs: executions }: { id: string; runs: Executions } = $props();

  let loaded = $state.raw<PageAction | null | undefined>(undefined);
  /** The chosen run, and what changes its page (its end, its status). */
  const wanted = $derived(executions.chosen ? `${executions.chosen.id}|${executions.chosen.end}|${executions.chosen.status}` : null);
  let request = 0;
  $effect(() => {
    const v = wanted;
    const execution = executions.chosen?.id ?? null;
    const n = ++request;
    if (v === null || execution === null) {
      loaded = null;
      return;
    }
    loaded = undefined;
    void api.actions
      .page(id, execution)
      .then((p) => n === request && (loaded = p))
      .catch(() => n === request && (loaded = null));
  });
</script>

<div class="preview" data-testid="action-preview">
  {#if executions.chosen === null}
    <p class="muted">{t("builder-no-run")}</p>
  {:else if loaded === undefined}
    <p class="muted">{t("builder-loading")}</p>
  {:else if loaded === null || !loaded.page}
    <p class="muted">{loaded?.error ?? t("builder-preview-no-page")}</p>
  {:else if loaded.page.empty}
    <p class="muted">{t("action-no-result")}</p>
  {:else}
    <div class="page">
      <PageRender page={loaded.page} ctx={actionContext(id, loaded.run)} components={false} />
    </div>
  {/if}
  {#if executions.chosen?.attempt}<p class="muted mention" data-testid="mention-preview">{t("builder-preview-trial")}</p>{/if}
</div>

<style>
  .preview { position: absolute; left: 12px; bottom: 12px; z-index: 4; display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass-dense); box-shadow: var(--modal-shadow); animation: ressac-rise var(--spring-d) var(--spring) backwards; width: 480px; max-width: calc(100% - 24px); }
  .page { max-height: 360px; overflow: auto; border-radius: 12px; background: var(--bg); zoom: 0.75; }
  .muted { margin: 0; font-size: 11px; color: var(--text-muted); }
  .mention { max-width: 360px; }
</style>
