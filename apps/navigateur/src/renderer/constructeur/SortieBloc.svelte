<script lang="ts">
  import type { Execution, ResumeExecution } from "@webaios/noyau";

  /**
   * Ce que le bloc a produit à l'exécution choisie : statut, durée, éléments, erreur, journal et sortie repliable. Tout
   * vient d'une page ou du code de l'agent : affiché en texte, jamais en HTML.
   */
  let { bloc, choisie, execution }: { bloc: string; choisie: ResumeExecution | null; execution: Execution | null } = $props();

  const LIBELLES: Record<string, string> = {
    reussi: "réussi",
    partiel: "partiel",
    echoue: "échoué",
    interrompu: "interrompu",
    "pas-lance": "pas lancé",
    repris: "repris",
  };

  const trace = $derived(execution?.id === choisie?.id ? execution?.blocs.find((b) => b.id === bloc) : undefined);
  /** La sortie n'est mise en forme qu'une fois le repli ouvert (elle peut peser 256 Ko). */
  let ouverte = $state(false);
  const json = $derived(ouverte && trace && trace.sortie !== undefined ? JSON.stringify(trace.sortie, null, 2) : "");

  function duree(debut: string | null, fin: string | null): string | null {
    if (!debut || !fin) return null;
    const ms = Date.parse(fin) - Date.parse(debut);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  }
  const heure = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
</script>

<section class="sortie" data-testid="sortie-bloc">
  <h3>À l'exécution choisie</h3>
  {#if !choisie}
    <p class="doux">Aucune exécution pour l'instant.</p>
  {:else}
    <p class="doux">{heure(choisie.debut)} · {choisie.declencheur}{choisie.essai ? " (essai)" : ""}</p>
    {#if execution?.id !== choisie.id}
      <p class="doux">Chargement…</p>
    {:else if !trace}
      <p class="doux">Ce bloc n'était pas dans cette exécution.</p>
    {:else}
      <dl>
        <dt>Statut</dt>
        <dd data-testid="statut-bloc">{LIBELLES[trace.statut] ?? trace.statut}</dd>
        {#if duree(trace.debut, trace.fin)}<dt>Durée</dt><dd>{duree(trace.debut, trace.fin)}</dd>{/if}
        <dt>Éléments</dt>
        <dd>{trace.elements ?? "—"}</dd>
      </dl>
      {#if trace.statut === "repris" && execution.essai}
        <p class="doux" data-testid="sortie-reprise">Sortie reprise de l'exécution {execution.essai.origine}</p>
      {/if}
      {#if trace.erreur}<p class="erreur" data-testid="erreur-bloc">{trace.erreur}</p>{/if}
      {#if trace.journal.length > 0}
        <details>
          <summary>Journal ({trace.journal.length})</summary>
          <pre data-testid="journal-bloc">{trace.journal.join("\n")}</pre>
        </details>
      {/if}
      {#if trace.sortie !== undefined || trace.sortieTronquee}
        <details data-testid="sortie-repliable" ontoggle={(e) => (ouverte = e.currentTarget.open)}>
          <summary>Sortie{trace.sortieTronquee ? " (tronquée)" : ""}</summary>
          {#if ouverte}<pre data-testid="sortie-json">{json}</pre>{/if}
        </details>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .sortie { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--bord); font-size: 12px; }
  h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
  .doux { margin: 0 0 6px; color: var(--texte-doux); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0 0 6px; }
  dt { color: var(--texte-doux); }
  dd { margin: 0; }
  .erreur { margin: 0 0 6px; color: var(--en-erreur); white-space: pre-wrap; word-break: break-word; }
  details { margin-top: 4px; }
  summary { cursor: pointer; color: var(--texte-doux); }
  pre { margin: 4px 0 0; padding: 6px 8px; max-height: 320px; overflow: auto; border-radius: 6px; background: var(--fond); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
</style>
