<script lang="ts">
  import { untrack } from "svelte";
  import type { ActionsState, PageAction, ResumeExecution } from "@webaios/noyau";
  import { ACTION_UNKNOWN, NO_RESULT, RESULT_GONE, type ActionShown } from "../../shared/actions";
  import CarteAccordCompte from "../composants/CarteAccordCompte.svelte";
  import { api } from "../etat.svelte";
  import AvancementAction from "./AvancementAction.svelte";
  import EnTeteAction from "./EnTeteAction.svelte";
  import RenduPage from "./RenduPage.svelte";

  /**
   * The page `webaios://action/<id>[/<run>]`: the requested result (the latest without `execution`), the progress of a
   * running run, the states (grant, error, empty, never run). Opening, reloading or restoring it never launches
   * anything: only « Lancer »/« Relancer » (or Enter in the input) and the account grant launch the action.
   */
  let { id, execution }: { id: string; execution: string | null } = $props();

  /** undefined: not read yet; null: the action does not exist (or no longer). */
  let action = $state<ActionShown | null | undefined>(undefined);
  /** undefined: not read yet; null: no result (never run, or the requested run no longer exists). */
  let lue = $state<PageAction | null | undefined>(undefined);
  let precedentes = $state<ResumeExecution[] | null>(null);
  /**
   * Without a requested run: the most recent one, when it gave no result (failure, stop) and is more recent than the
   * last result. Its message shows above that result, like a widget in error.
   */
  let derniereSansResultat = $state<PageAction | null>(null);
  let direct = $state<ActionsState>({ courantes: [], enAttente: [] });
  /** A launch requested from this page, whose outcome has not come back yet. */
  let lancement = $state(false);
  let erreurLancement = $state<string | null>(null);
  let saisie = $state("");
  /** The run whose input filled the field (the field is not rewritten while the user types). */
  let saisieDe: string | null = null;
  let carteOuverte = $state(true);

  let generation = 0;
  let relecture: ReturnType<typeof setTimeout> | undefined;
  /** Re-reads done (at most RELECTURES_MAX); none once the kernel has served a page. */
  let relectures = 0;
  let noyauPret = false;
  const RELECTURES_MAX = 15;
  let demontee = false;
  async function charger() {
    const g = ++generation;
    clearTimeout(relecture);
    try {
      const [liste, page, executions] = await Promise.all([api.actions.liste(), api.actions.page(id, execution), api.actions.executions(id)]);
      if (g !== generation) return;
      const gardees = executions.filter((e) => !e.essai && !e.id.endsWith("-essai"));
      const plusRecente = gardees[0];
      const sansResultat =
        execution === null && plusRecente && plusRecente.id !== page?.execution && (!page || plusRecente.debut > page.debut)
          ? await api.actions.page(id, plusRecente.id)
          : null;
      if (g !== generation || demontee) return;
      action = liste.find((a) => a.id === id) ?? null;
      lue = page;
      precedentes = gardees;
      derniereSansResultat = sansResultat?.page ? null : sansResultat;
      const montree = derniereSansResultat ?? page;
      if (montree && montree.execution !== saisieDe) {
        saisieDe = montree.execution;
        saisie = montree.saisie ?? "";
      }
      // At startup (restored session), the agent may not be ready: the action or its results are not served yet
      // while runs are on disk. Re-read a bit later (read only, nothing is launched).
      if (page || sansResultat) noyauPret = true;
      const incomplet = action === null || (gardees.length > 0 && !page && !sansResultat);
      if (incomplet && !noyauPret && relectures < RELECTURES_MAX) {
        relectures++;
        relecture = setTimeout(() => void charger(), 2000);
      }
    } catch (e) {
      console.error(`[webaios] page de l'action ${id} :`, e);
    }
  }

  $effect(() => {
    untrack(() => void charger());
    const fin = api.actions.surChange(() => void charger());
    return () => {
      demontee = true;
      clearTimeout(relecture);
      fin();
    };
  });
  $effect(() => {
    let recu = false;
    const fin = api.actions.surDirect((e) => {
      recu = true;
      direct = e;
    });
    void api.actions.direct().then((e) => {
      if (!recu) direct = e;
    });
    return fin;
  });

  const courante = $derived(direct.courantes.find((c) => c.action === id) ?? null);
  const enAttente = $derived(direct.enAttente.some((a) => a.action === id));
  const tourne = $derived(courante !== null || enAttente);
  const besoinAccord = $derived(!!action && action.compte.length > 0 && !action.accord);
  /** The outcome of a launch refused without writing anything: this page's, otherwise a suggestion's or « Lancer »'s. */
  const erreurAffichee = $derived(erreurLancement ?? action?.refus ?? null);
  // A run just finished (seen through direct): its result is re-read.
  let tournait = false;
  $effect(() => {
    if (tournait && !tourne) void charger();
    tournait = tourne;
  });

  async function lancer() {
    if (!action || tourne || lancement) return;
    erreurLancement = null;
    lancement = true;
    try {
      const r = await api.actions.lancer(id, action.saisie ? saisie : null);
      // Nothing written (workshop stopped, workflow.json missing or invalid, grant required…): the page could not re-read it.
      if (!r.execution) {
        erreurLancement = r.erreur ?? "L'action n'a pas pu être lancée";
        carteOuverte = true;
      } else if (execution !== null && r.execution && r.execution !== execution) {
        // The page showed a specific result: it switches to this one.
        api.agir({ type: "ouvrirAction", fenetreId: api.fenetreId, id, nom: action.nom, execution: r.execution });
      }
    } catch (e) {
      erreurLancement = e instanceof Error ? e.message : String(e);
    } finally {
      lancement = false;
      void charger();
    }
  }

  async function accorder(profil: string) {
    if (!action) return;
    carteOuverte = false;
    // The grant covers exactly what the card showed.
    const r = await api.actions.accorder({ id, profil, compte: [...action.compte], publiques: [...action.publiques] });
    if (!r.ok) {
      erreurLancement = `Accord non enregistré : ${r.erreur}`;
      await charger();
      return;
    }
    erreurLancement = null;
    await charger();
    // Once granted, the run starts (if the required input is there).
    if (action && !besoinAccord && (!action.saisie || saisie.trim())) void lancer();
  }

  const choisir = (e: string) => action && api.agir({ type: "ouvrirAction", fenetreId: api.fenetreId, id, nom: action.nom, execution: e });
</script>

<div class="defile" data-testid="page-action">
  {#if action === null}
    <p class="message erreur" data-testid="erreur-action">{ACTION_UNKNOWN}</p>
  {:else if action}
    <EnTeteAction
      nom={action.nom}
      bind:saisie
      libelleSaisie={action.saisie?.libelle ?? null}
      debut={derniereSansResultat?.debut ?? lue?.debut ?? null}
      occupee={tourne || lancement}
      dejaLancee={!!lue || (precedentes?.length ?? 0) > 0}
      {precedentes}
      lancer={() => void lancer()}
      voirWorkflow={() => api.actions.voirWorkflow(id)}
      {choisir}
    />
    {#if tourne}
      {#key courante?.debut}<AvancementAction {courante} {enAttente} arreter={() => api.actions.arreter(id)} />{/key}
    {:else}
      {#if action.erreur}<p class="message erreur">{action.erreur}</p>{/if}
      {#if besoinAccord}
        <div class="message accord" data-testid="accord-requis">
          <p>Accord requis pour lire avec ton compte : {action.compte.join(", ")}</p>
          <button onclick={() => (carteOuverte = true)}>Autoriser…</button>
        </div>
      {/if}
      {#if erreurAffichee}
        <p class="message erreur" data-testid="erreur-action">{erreurAffichee}</p>
      {:else if derniereSansResultat?.erreur ?? lue?.erreur}
        <p class="message erreur" data-testid="erreur-action">{derniereSansResultat?.erreur ?? lue?.erreur}</p>
      {/if}
      {#if lue === null && execution !== null}
        <div class="message disparu" data-testid="resultat-disparu">
          <p>{RESULT_GONE}</p>
          {#if precedentes && precedentes.length > 0}
            <button data-testid="voir-dernier-resultat" onclick={() => choisir(precedentes![0]!.id)}>Voir le dernier résultat</button>
          {/if}
        </div>
      {:else if lue === null && !derniereSansResultat && !action.saisie && !besoinAccord && !erreurAffichee}
        <p class="message" data-testid="pas-de-resultat">Pas encore de résultat</p>
      {:else if lue?.page?.vide}
        <p class="message" data-testid="aucun-resultat">{NO_RESULT}</p>
      {:else if lue?.page}
        <RenduPage page={lue.page} action={id} execution={lue.execution} />
      {/if}
    {/if}
    {#if besoinAccord && carteOuverte}
      <CarteAccordCompte
        sujet="action"
        nom={action.nom}
        domaines={action.compte}
        publiques={action.publiques}
        profilsPourAccord={api.actions.profilsPourAccord}
        fermer={() => (carteOuverte = false)}
        autoriser={(profil) => void accorder(profil)}
      />
    {/if}
  {/if}
</div>

<style>
  .defile { position: absolute; inset: 0; overflow: auto; }
  .message { max-width: 960px; box-sizing: border-box; margin: 16px auto 0; padding: 0 24px; color: var(--texte-doux); font-size: 14px; }
  .erreur { color: var(--en-erreur); overflow-wrap: anywhere; }
  .disparu { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .disparu p { margin: 0; }
  .disparu button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font: inherit; }
  .accord { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .accord p { margin: 0; color: var(--texte); }
  .accord button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font: inherit; }
</style>
