<script lang="ts">
  import { untrack } from "svelte";
  import type { ActionsState, PageAction, ResumeExecution } from "@webaios/kernel";
  import { ACTION_UNKNOWN, NO_RESULT, RESULT_GONE, type ActionShown } from "../../shared/actions";
  import AccountGrantCard from "../components/AccountGrantCard.svelte";
  import { api } from "../state.svelte";
  import ActionProgress from "./ActionProgress.svelte";
  import ActionHeader from "./EnTeteAction.svelte";
  import PageRender from "./PageRender.svelte";

  /**
   * The page `webaios://action/<id>[/<run>]`: the requested result (the latest without `execution`), the progress of a
   * running run, the states (grant, error, empty, never run). Opening, reloading or restoring it never launches
   * anything: only « Lancer »/« Relancer » (or Enter in the input) and the account grant launch the action.
   */
  let { id, execution }: { id: string; execution: string | null } = $props();

  /** undefined: not read yet; null: the action does not exist (or no longer). */
  let action = $state<ActionShown | null | undefined>(undefined);
  /** undefined: not read yet; null: no result (never run, or the requested run no longer exists). */
  let loaded = $state<PageAction | null | undefined>(undefined);
  let previous = $state<ResumeExecution[] | null>(null);
  /**
   * Without a requested run: the most recent one, when it gave no result (failure, stop) and is more recent than the
   * last result. Its message shows above that result, like a widget in error.
   */
  let lastWithoutResult = $state<PageAction | null>(null);
  let direct = $state<ActionsState>({ courantes: [], enAttente: [] });
  /** A launch requested from this page, whose outcome has not come back yet. */
  let launch = $state(false);
  let launchError = $state<string | null>(null);
  let input = $state("");
  /** The run whose input filled the field (the field is not rewritten while the user types). */
  let inputOf: string | null = null;
  let cardOpen = $state(true);

  let generation = 0;
  let review: ReturnType<typeof setTimeout> | undefined;
  /** Re-reads done (at most MAX_REVIEWS); none once the kernel has served a page. */
  let reviews = 0;
  let kernelReady = false;
  const MAX_REVIEWS = 15;
  let unmounted = false;
  async function load() {
    const g = ++generation;
    clearTimeout(review);
    try {
      const [list, page, executions] = await Promise.all([api.actions.liste(), api.actions.page(id, execution), api.actions.executions(id)]);
      if (g !== generation) return;
      const kept = executions.filter((e) => !e.essai && !e.id.endsWith("-essai"));
      const mostRecent = kept[0];
      const withoutResult =
        execution === null && mostRecent && mostRecent.id !== page?.execution && (!page || mostRecent.debut > page.debut)
          ? await api.actions.page(id, mostRecent.id)
          : null;
      if (g !== generation || unmounted) return;
      action = list.find((a) => a.id === id) ?? null;
      loaded = page;
      previous = kept;
      lastWithoutResult = withoutResult?.page ? null : withoutResult;
      const shown = lastWithoutResult ?? page;
      if (shown && shown.execution !== inputOf) {
        inputOf = shown.execution;
        input = shown.saisie ?? "";
      }
      // At startup (restored session), the agent may not be ready: the action or its results are not served yet
      // while runs are on disk. Re-read a bit later (read only, nothing is launched).
      if (page || withoutResult) kernelReady = true;
      const incomplete = action === null || (kept.length > 0 && !page && !withoutResult);
      if (incomplete && !kernelReady && reviews < MAX_REVIEWS) {
        reviews++;
        review = setTimeout(() => void load(), 2000);
      }
    } catch (e) {
      console.error(`[webaios] page de l'action ${id} :`, e);
    }
  }

  $effect(() => {
    untrack(() => void load());
    const end = api.actions.surChange(() => void load());
    return () => {
      unmounted = true;
      clearTimeout(review);
      end();
    };
  });
  $effect(() => {
    let received = false;
    const end = api.actions.surDirect((e) => {
      received = true;
      direct = e;
    });
    void api.actions.direct().then((e) => {
      if (!received) direct = e;
    });
    return end;
  });

  const current = $derived(direct.courantes.find((c) => c.action === id) ?? null);
  const pending = $derived(direct.enAttente.some((a) => a.action === id));
  const running = $derived(current !== null || pending);
  const grantNeed = $derived(!!action && action.compte.length > 0 && !action.accord);
  /** The outcome of a launch refused without writing anything: this page's, otherwise a suggestion's or « Lancer »'s. */
  const shownError = $derived(launchError ?? action?.refus ?? null);
  // A run just finished (seen through direct): its result is re-read.
  let wasRunning = false;
  $effect(() => {
    if (wasRunning && !running) void load();
    wasRunning = running;
  });

  async function launchAction() {
    if (!action || running || launch) return;
    launchError = null;
    launch = true;
    try {
      const r = await api.actions.lancer(id, action.saisie ? input : null);
      // Nothing written (workshop stopped, workflow.json missing or invalid, grant required…): the page could not re-read it.
      if (!r.execution) {
        launchError = r.erreur ?? "L'action n'a pas pu être lancée";
        cardOpen = true;
      } else if (execution !== null && r.execution && r.execution !== execution) {
        // The page showed a specific result: it switches to this one.
        api.agir({ type: "ouvrirAction", fenetreId: api.fenetreId, id, nom: action.nom, execution: r.execution });
      }
    } catch (e) {
      launchError = e instanceof Error ? e.message : String(e);
    } finally {
      launch = false;
      void load();
    }
  }

  async function giveGrant(profile: string) {
    if (!action) return;
    cardOpen = false;
    // The grant covers exactly what the card showed.
    const r = await api.actions.accorder({ id, profil: profile, compte: [...action.compte], publiques: [...action.publiques] });
    if (!r.ok) {
      launchError = `Accord non enregistré : ${r.erreur}`;
      await load();
      return;
    }
    launchError = null;
    await load();
    // Once granted, the run starts (if the required input is there).
    if (action && !grantNeed && (!action.saisie || input.trim())) void launchAction();
  }

  const choose = (e: string) => action && api.agir({ type: "ouvrirAction", fenetreId: api.fenetreId, id, nom: action.nom, execution: e });
</script>

<div class="defile" data-testid="page-action">
  {#if action === null}
    <p class="message erreur" data-testid="erreur-action">{ACTION_UNKNOWN}</p>
  {:else if action}
    <ActionHeader
      nom={action.nom}
      bind:saisie={input}
      libelleSaisie={action.saisie?.libelle ?? null}
      debut={lastWithoutResult?.debut ?? loaded?.debut ?? null}
      occupee={running || launch}
      dejaLancee={!!loaded || (previous?.length ?? 0) > 0}
      precedentes={previous}
      lancer={() => void launchAction()}
      voirWorkflow={() => api.actions.voirWorkflow(id)}
      choisir={choose}
    />
    {#if running}
      {#key current?.debut}<ActionProgress courante={current} enAttente={pending} arreter={() => api.actions.arreter(id)} />{/key}
    {:else}
      {#if action.erreur}<p class="message erreur">{action.erreur}</p>{/if}
      {#if grantNeed}
        <div class="message accord" data-testid="accord-requis">
          <p>Accord requis pour lire avec ton compte : {action.compte.join(", ")}</p>
          <button onclick={() => (cardOpen = true)}>Autoriser…</button>
        </div>
      {/if}
      {#if shownError}
        <p class="message erreur" data-testid="erreur-action">{shownError}</p>
      {:else if lastWithoutResult?.erreur ?? loaded?.erreur}
        <p class="message erreur" data-testid="erreur-action">{lastWithoutResult?.erreur ?? loaded?.erreur}</p>
      {/if}
      {#if loaded === null && execution !== null}
        <div class="message disparu" data-testid="resultat-disparu">
          <p>{RESULT_GONE}</p>
          {#if previous && previous.length > 0}
            <button data-testid="voir-dernier-resultat" onclick={() => choose(previous![0]!.id)}>Voir le dernier résultat</button>
          {/if}
        </div>
      {:else if loaded === null && !lastWithoutResult && !action.saisie && !grantNeed && !shownError}
        <p class="message" data-testid="pas-de-resultat">Pas encore de résultat</p>
      {:else if loaded?.page?.vide}
        <p class="message" data-testid="aucun-resultat">{NO_RESULT}</p>
      {:else if loaded?.page}
        <PageRender page={loaded.page} action={id} execution={loaded.execution} />
      {/if}
    {/if}
    {#if grantNeed && cardOpen}
      <AccountGrantCard
        sujet="action"
        nom={action.nom}
        domaines={action.compte}
        publiques={action.publiques}
        profilsPourAccord={api.actions.profilsPourAccord}
        fermer={() => (cardOpen = false)}
        autoriser={(profile) => void giveGrant(profile)}
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
