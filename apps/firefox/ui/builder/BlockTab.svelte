<script lang="ts">
  import type { BlockCatalogEntry } from "@webaios/kernel";
  import { availableFields } from "./fields";
  import type { Edit } from "./edition.svelte";
  import CodeEditor from "./CodeEditor.svelte";
  import type { Executions } from "./executions.svelte";
  import BlockForm from "./BlockForm.svelte";
  import { isActionKey } from "./target";
  import ActionPanel from "./ActionPanel.svelte";
  import WidgetPanel from "./WidgetPanel.svelte";
  import BlockOutput from "./BlockOutput.svelte";

  /**
   * The « Bloc » tab: the selected block (settings, code, output), or the widget (the action) when none is.
   * `widget`: the workflow's key (`cleCible`).
   */
  let {
    widget,
    edition: edit,
    executions,
    catalogue: catalog,
    selection,
  }: { widget: string; edition: Edit; executions: Executions; catalogue: Map<string, BlockCatalogEntry>; selection: string | null } = $props();

  const block = $derived(selection === null ? undefined : edit.brouillon?.blocs.find((b) => b.id === selection));
  const c = $derived(block ? catalog.get(block.type) : undefined);
  const error = $derived(!edit.validation.ok && block && edit.validation.bloc === block.id ? edit.validation.erreur : null);
  const warnings = $derived(block ? edit.avertissements.filter((a) => a.bloc === block.id) : []);

  /** Fields offered in a template: those of the upstream block's output at the chosen run, then the configuration. */
  const available = $derived.by(() => {
    const d = executions.detail;
    if (!block || !d) return null;
    const upstream = edit.brouillon?.liens.find((l) => l.vers === block.id)?.de;
    const output = upstream === undefined ? undefined : d.blocs.find((b) => b.id === upstream)?.sortie;
    return availableFields(output, edit.widget?.config);
  });
  const source = $derived(block?.type === "code" && typeof block.parametres.source === "string" ? block.parametres.source : null);
</script>

<div class="volet" data-testid="volet-bloc">
  {#if block}
    {#key block.id}
      <h3><span>{c?.libelle ?? block.type}</span> <code>{block.type}</code></h3>
      {#if error}<p class="erreur" data-testid="erreur-validation">{error}</p>{/if}
      {#if warnings.length > 0}
        <ul class="avertissements" data-testid="avertissement-{block.id}">
          {#each warnings as a, i (i)}<li>⚠ {a.message}</li>{/each}
        </ul>
      {/if}
      {#if c}
        <BlockForm edition={edit} bloc={block} catalogue={c} disponibles={available} />
      {:else}
        <p class="doux">Type de bloc inconnu : ses réglages ne s'éditent pas ici.</p>
      {/if}
      {#if source}
        {#key source}<CodeEditor {widget} nom={source} />{/key}
      {/if}
      <BlockOutput bloc={block.id} choisie={executions.choisie} execution={executions.detail} introuvable={executions.introuvable} />
    {/key}
  {:else if isActionKey(widget)}
    <ActionPanel action={edit.action} />
  {:else}
    <WidgetPanel widget={edit.widget} />
  {/if}
</div>

<style>
  .volet { padding: 12px; overflow-y: auto; min-height: 0; flex: 1; color: var(--texte); }
  h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  h3 code { font-size: 11px; font-weight: 400; padding: 0 5px; border-radius: 4px; background: var(--fond-survol); color: var(--texte-doux); }
  .erreur { margin: 0 0 6px; color: var(--en-erreur); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .avertissements { list-style: none; margin: 0 0 6px; padding: 0; color: var(--en-cours); font-size: 12px; word-break: break-word; }
  .doux { color: var(--texte-doux); font-size: 12px; }
</style>
