<script lang="ts">
  import type { CatalogueBloc } from "@webaios/noyau";
  import { champsDisponibles } from "./champs";
  import type { Edition } from "./edition.svelte";
  import EditeurCode from "./EditeurCode.svelte";
  import type { Executions } from "./executions.svelte";
  import FormulaireBloc from "./FormulaireBloc.svelte";
  import PanneauWidget from "./PanneauWidget.svelte";
  import SortieBloc from "./SortieBloc.svelte";

  /** L'onglet « Bloc » : le bloc sélectionné (réglages, code, sortie), ou le widget quand aucun ne l'est. */
  let {
    widget,
    edition,
    executions,
    catalogue,
    selection,
  }: { widget: string; edition: Edition; executions: Executions; catalogue: Map<string, CatalogueBloc>; selection: string | null } = $props();

  const bloc = $derived(selection === null ? undefined : edition.brouillon?.blocs.find((b) => b.id === selection));
  const c = $derived(bloc ? catalogue.get(bloc.type) : undefined);
  const erreur = $derived(!edition.validation.ok && bloc && edition.validation.bloc === bloc.id ? edition.validation.erreur : null);
  const avertissements = $derived(bloc ? edition.avertissements.filter((a) => a.bloc === bloc.id) : []);

  /** Champs proposés dans un gabarit : ceux de la sortie du bloc amont à l'exécution choisie, puis la configuration. */
  const disponibles = $derived.by(() => {
    const d = executions.detail;
    if (!bloc || !d) return null;
    const amont = edition.brouillon?.liens.find((l) => l.vers === bloc.id)?.de;
    const sortie = amont === undefined ? undefined : d.blocs.find((b) => b.id === amont)?.sortie;
    return champsDisponibles(sortie, edition.widget?.config);
  });
  const source = $derived(bloc?.type === "code" && typeof bloc.parametres.source === "string" ? bloc.parametres.source : null);
</script>

<div class="onglet" data-testid="onglet-bloc">
  {#if bloc}
    {#key bloc.id}
      <h3><span>{c?.libelle ?? bloc.type}</span> <code>{bloc.type}</code></h3>
      {#if erreur}<p class="erreur" data-testid="erreur-validation">{erreur}</p>{/if}
      {#if avertissements.length > 0}
        <ul class="avertissements" data-testid="avertissement-{bloc.id}">
          {#each avertissements as a, i (i)}<li>⚠ {a.message}</li>{/each}
        </ul>
      {/if}
      {#if c}
        <FormulaireBloc {edition} {bloc} catalogue={c} {disponibles} />
      {:else}
        <p class="doux">Type de bloc inconnu : ses réglages ne s'éditent pas ici.</p>
      {/if}
      {#if source}
        {#key source}<EditeurCode {widget} nom={source} />{/key}
      {/if}
      <SortieBloc bloc={bloc.id} choisie={executions.choisie} execution={executions.detail} />
    {/key}
  {:else}
    <PanneauWidget widget={edition.widget} />
  {/if}
</div>

<style>
  .onglet { padding: 12px; overflow-y: auto; min-height: 0; flex: 1; color: var(--texte); }
  h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  h3 code { font-size: 11px; font-weight: 400; padding: 0 5px; border-radius: 4px; background: var(--fond-survol); color: var(--texte-doux); }
  .erreur { margin: 0 0 6px; color: var(--en-erreur); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .avertissements { list-style: none; margin: 0 0 6px; padding: 0; color: var(--en-cours); font-size: 12px; word-break: break-word; }
  .doux { color: var(--texte-doux); font-size: 12px; }
</style>
