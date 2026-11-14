<script lang="ts">
  import type { BlockCatalogEntry } from "@ressac/kernel";
  import { t } from "../i18n.svelte";
  import { availableFields } from "./fields";
  import type { Edit } from "./edit.svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import type { Executions } from "./executions.svelte";
  import BlockForm from "./BlockForm.svelte";
  import { isActionKey } from "./target";
  import ActionPanel from "./ActionPanel.svelte";
  import WidgetPanel from "./WidgetPanel.svelte";
  import BlockOutput from "./BlockOutput.svelte";

  /**
   * The « Bloc » tab: the selected block (settings, code, output), or the widget (the action) when none is.
   * `widget`: the workflow's key (`targetKey`).
   */
  let {
    widget,
    editing: edit,
    runs: executions,
    catalog: catalog,
    selection,
  }: { widget: string; editing: Edit; runs: Executions; catalog: Map<string, BlockCatalogEntry>; selection: string | null } = $props();

  const block = $derived(selection === null ? undefined : edit.draft?.blocks.find((b) => b.id === selection));
  const c = $derived(block ? catalog.get(block.type) : undefined);
  const error = $derived(!edit.validation.ok && block && edit.validation.block === block.id ? edit.validation.error : null);
  const warnings = $derived(block ? edit.warnings.filter((a) => a.block === block.id) : []);

  /** Fields offered in a template: those of the upstream block's output at the chosen run, then the configuration. */
  const available = $derived.by(() => {
    const d = executions.detail;
    if (!block || !d) return null;
    const upstream = edit.draft?.links.find((l) => l.to === block.id)?.from;
    const output = upstream === undefined ? undefined : d.blocks.find((b) => b.id === upstream)?.output;
    return availableFields(output, edit.widget?.config);
  });
  const source = $derived(block?.type === "code" && typeof block.params.source === "string" ? block.params.source : null);
</script>

<div class="pane" data-testid="block-pane">
  {#if block}
    {#key block.id}
      <h3><span>{c?.label ?? block.type}</span> <code>{block.type}</code></h3>
      {#if error}<p class="error" data-testid="validation-error">{error}</p>{/if}
      {#if warnings.length > 0}
        <ul class="warnings" data-testid="warning-{block.id}">
          {#each warnings as a, i (i)}<li>⚠ {a.message}</li>{/each}
        </ul>
      {/if}
      {#if c}
        <BlockForm editing={edit} block={block} catalog={c} available={available} />
      {:else}
        <p class="muted">{t("builder-block-unknown")}</p>
      {/if}
      {#if source}
        {#key source}<CodeEditor {widget} name={source} />{/key}
      {/if}
      <BlockOutput block={block.id} chosen={executions.chosen} run={executions.detail} notFound={executions.notFound} />
    {/key}
  {:else if isActionKey(widget)}
    <ActionPanel action={edit.action} />
  {:else}
    <WidgetPanel widget={edit.widget} />
  {/if}
</div>

<style>
  .pane { padding: 12px; overflow-y: auto; min-height: 0; flex: 1; color: var(--text); }
  h3 { margin: 0 0 8px; font: 650 16px/1.2 var(--font-display); letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
  h3 code { font: 400 10.5px var(--font-mono); padding: 1px 6px; border-radius: 6px; background: var(--glass-hi); color: var(--text-muted); }
  .error { margin: 0 0 6px; color: var(--in-error); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .warnings { list-style: none; margin: 0 0 6px; padding: 0; color: var(--in-progress); font-size: 12px; word-break: break-word; }
  .muted { color: var(--text-muted); font-size: 12px; }
</style>
