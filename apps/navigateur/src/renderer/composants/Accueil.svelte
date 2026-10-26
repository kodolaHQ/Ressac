<script lang="ts">
  import type { BlocAffiche } from "../../commun/api";
  import { api } from "../etat.svelte";
  import BlocAccueil from "./BlocAccueil.svelte";

  const TYPE_GLISSE = "application/x-webaios-bloc";
  let blocs = $state<BlocAffiche[]>([]);
  // Lectures qui se croisent (rafale de changements) : seule la dernière compte.
  let derniere = 0;
  function charger() {
    const n = ++derniere;
    api.accueil.lire().then(
      (b) => n === derniere && (blocs = b),
      () => {},
    );
  }
  $effect(() => {
    charger();
    return api.accueil.surChange(charger);
  });

  /** Point de dépôt : avant ou après le bloc survolé, selon la moitié sous la souris (même règle que les onglets). */
  let survol = $state<{ index: number; apres: boolean } | null>(null);
  let glisse = $state(false);
  let aRetirer = $state<BlocAffiche | null>(null);
  const titre = (b: BlocAffiche) => ("titre" in b ? b.titre : b.id);

  function deposer(e: DragEvent, index: number) {
    e.preventDefault();
    const apres = survol?.index === index && survol.apres;
    survol = null;
    glisse = false;
    const id = e.dataTransfer?.getData(TYPE_GLISSE);
    const depart = blocs.findIndex((b) => b.id === id);
    if (depart < 0) return;
    const reste = blocs.filter((b) => b.id !== id);
    const position = index + (apres ? 1 : 0) - (depart < index + (apres ? 1 : 0) ? 1 : 0);
    reste.splice(position, 0, blocs[depart]!);
    blocs = reste; // tout de suite à l'écran ; la surveillance du dossier confirmera
    api.accueil.ordonner(reste.map((b) => b.id));
  }
</script>

{#if blocs.length}
  <section class="blocs" class:glisse data-testid="accueil">
    {#each blocs as bloc, index (bloc.id)}
      <div
        role="listitem"
        class="place"
        class:avant={survol?.index === index && !survol.apres}
        class:apres={survol?.index === index && survol.apres}
        ondragover={(e) => {
          if (!e.dataTransfer?.types.includes(TYPE_GLISSE)) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          survol = { index, apres: e.clientY > r.top + r.height / 2 };
        }}
        ondragleave={() => (survol = null)}
        ondrop={(e) => deposer(e, index)}
      >
        <BlocAccueil
          {bloc}
          retirer={() => (aRetirer = bloc)}
          glisserDebut={(e) => {
            e.dataTransfer?.setData(TYPE_GLISSE, bloc.id);
            glisse = true;
          }}
        />
      </div>
    {/each}
  </section>
{/if}
<svelte:window ondragend={() => ((glisse = false), (survol = null))} />

{#if aRetirer}
  {@const cible = aRetirer}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-retrait">
      <p>Retirer « {titre(cible)} » de la page d'accueil ?</p>
      <div class="boutons">
        <button onclick={() => (aRetirer = null)}>Annuler</button>
        <button
          class="principal"
          onclick={() => {
            const id = cible.id; // {@const} se relit : après aRetirer = null, cible vaut null
            aRetirer = null;
            blocs = blocs.filter((b) => b.id !== id);
            api.accueil.retirer(id);
          }}>Retirer</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .blocs { width: min(900px, 92%); display: flex; flex-direction: column; gap: 16px; padding-bottom: 32px; }
  /* Pendant un glisser, le contenu des blocs ne doit pas capter la souris. */
  .blocs.glisse :global(iframe), .blocs.glisse :global(webview) { pointer-events: none; }
  .place { border-radius: 10px; }
  .place.avant { box-shadow: 0 -3px 0 var(--accent); }
  .place.apres { box-shadow: 0 3px 0 var(--accent); }
  .voile { position: fixed; inset: 0; display: grid; place-content: center; background: rgb(0 0 0 / 0.35); z-index: 10; }
  .confirmation { padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); }
  .confirmation p { margin: 0 0 14px; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .principal { background: var(--accent); border-color: var(--accent); color: white; }
</style>
