<script lang="ts">
  import type { Execution, ResumeExecution } from "@webaios/noyau";

  /**
   * An action page's header: its name, its input, « Relancer » (« Lancer » when there is no result yet), « Voir le
   * workflow », the time of the shown result and the menu of previous results. Nothing is launched without a click (or Enter).
   */
  let {
    nom,
    saisie = $bindable(""),
    libelleSaisie,
    debut,
    occupee,
    dejaLancee,
    precedentes,
    lancer,
    voirWorkflow,
    choisir,
  }: {
    nom: string;
    /** The field's text, pre-filled with the shown result's input. */
    saisie?: string;
    /** Label of the declared input; null: the action has none. */
    libelleSaisie: string | null;
    /** Start of the shown run; null: none. */
    debut: string | null;
    /** A run of the action is running or waiting: no second launch. */
    occupee: boolean;
    dejaLancee: boolean;
    /** Kept runs (not the trials), most recent first; null until read. */
    precedentes: ResumeExecution[] | null;
    lancer: () => void;
    voirWorkflow: () => void;
    choisir: (execution: string) => void;
  } = $props();

  let menuOuvert = $state(false);
  const saisieManquante = $derived(libelleSaisie !== null && saisie.trim() === "");

  const FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const heure = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : FORMAT.format(d);
  };
  const STATUTS: Record<Execution["statut"], string> = {
    reussie: "réussie",
    partielle: "partielle",
    echouee: "échouée",
    interrompue: "interrompue",
    "accord-requis": "accord requis",
  };

  function valider() {
    if (!occupee && !saisieManquante) lancer();
  }

  // The menu closes on a click elsewhere and on Escape.
  $effect(() => {
    if (!menuOuvert) return;
    const fermer = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element | null)?.closest?.(".precedents")) menuOuvert = false;
    };
    window.addEventListener("pointerdown", fermer);
    window.addEventListener("keydown", fermer);
    return () => {
      window.removeEventListener("pointerdown", fermer);
      window.removeEventListener("keydown", fermer);
    };
  });
</script>

<header class="entete">
  <h1 data-testid="nom-action">{nom}</h1>
  <div class="commandes">
    {#if libelleSaisie !== null}
      <label class="saisie">
        <span>{libelleSaisie}</span>
        <input
          data-testid="saisie-action"
          bind:value={saisie}
          maxlength="200"
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              valider();
            }
          }}
        />
      </label>
    {/if}
    <button class="principal" data-testid="relancer-action" disabled={occupee || saisieManquante} onclick={valider}>
      {dejaLancee ? "Relancer" : "Lancer"}
    </button>
    <button data-testid="voir-workflow" onclick={voirWorkflow}>Voir le workflow</button>
    {#if debut}<span class="heure" data-testid="heure-resultat">{heure(debut)}</span>{/if}
    {#if precedentes && precedentes.length > 0}
      <div class="precedents">
        <button data-testid="resultats-precedents" aria-haspopup="menu" aria-expanded={menuOuvert} onclick={() => (menuOuvert = !menuOuvert)}>
          Résultats précédents
        </button>
        {#if menuOuvert}
          <div class="menu" role="menu">
            {#each precedentes as e (e.id)}
              <button
                role="menuitem"
                data-testid="resultat-{e.id}"
                onclick={() => {
                  menuOuvert = false;
                  choisir(e.id);
                }}
              >
                <span>{heure(e.debut)}</span>
                {#if e.saisie}<span class="doux">{e.saisie}</span>{/if}
                <span class="statut {e.statut}">{STATUTS[e.statut]}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</header>

<style>
  .entete { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; max-width: 960px; margin: 0 auto; padding: 20px 24px 0; color: var(--texte); }
  h1 { margin: 0; font-size: 18px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .commandes { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
  .saisie { display: flex; align-items: center; gap: 6px; color: var(--texte-doux); }
  .saisie input { width: 180px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font: inherit; }
  .saisie input:focus { outline: none; border-color: var(--accent); }
  button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font: inherit; }
  button:hover:not(:disabled) { background: var(--fond-survol); }
  button:disabled { opacity: 0.5; }
  .principal { background: var(--accent); border-color: var(--accent); color: white; }
  .principal:hover:not(:disabled) { background: var(--accent); filter: brightness(1.1); }
  .heure { color: var(--texte-doux); font-size: 12px; }
  .precedents { position: relative; }
  .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; display: flex; flex-direction: column; min-width: 260px; max-height: 320px; overflow-y: auto; padding: 4px; border: 1px solid var(--bord); border-radius: 8px; background: var(--fond-barre); box-shadow: var(--ombre-modale); }
  .menu button { display: flex; gap: 8px; align-items: baseline; border: none; background: none; text-align: left; white-space: nowrap; }
  .menu button:hover { background: var(--fond-survol); }
  .doux { color: var(--texte-doux); overflow: hidden; text-overflow: ellipsis; }
  .statut { margin-left: auto; font-size: 12px; color: var(--texte-doux); }
  .statut.echouee, .statut.interrompue, .statut.accord-requis { color: var(--en-erreur); }
</style>
