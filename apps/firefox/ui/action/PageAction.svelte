<script lang="ts">
  import { untrack } from "svelte";
  import type { ActionsState, PageAction, ResumeExecution } from "@webaios/kernel";
  import { ACTION_UNKNOWN, NO_RESULT, RESULT_GONE, type ActionShown } from "../../shared/actions";
  import AccountGrantCard from "../components/AccountGrantCard.svelte";
  import { api } from "../state.svelte";
  import ActionProgress from "./ActionProgress.svelte";
  import ActionHeader from "./ActionHeader.svelte";
  import PageRender from "./PageRender.svelte";

  /**
   * The page `webaios://action/<id>[/<run>]`: the requested result (the latest without `execution`), the progress of a
   * running run, the states (grant, error, empty, never run). Opening, reloading or restoring it never launches
   * anything: only « Lancer »/« Relancer » (or Enter in the input) and the account grant launch the action.
   */
  let { id, run: execution }: { id: string; run: string | null } = $props();

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
  let direct = $state<ActionsState>({ running: [], waiting: [] });
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
      const [list, page, executions] = await Promise.all([api.actions.list(), api.actions.page(id, execution), api.actions.runs(id)]);
      if (g !== generation) return;
      const kept = executions.filter((e) => !e.attempt && !e.id.endsWith("-attempt"));
      const mostRecent = kept[0];
      const withoutResult =
        execution === null && mostRecent && mostRecent.id !== page?.run && (!page || mostRecent.start > page.start)
          ? await api.actions.page(id, mostRecent.id)
          : null;
      if (g !== generation || unmounted) return;
      action = list.find((a) => a.id === id) ?? null;
      loaded = page;
      previous = kept;
      lastWithoutResult = withoutResult?.page ? null : withoutResult;
      const shown = lastWithoutResult ?? page;
      if (shown && shown.run !== inputOf) {
        inputOf = shown.run;
        input = shown.input ?? "";
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
    const end = api.actions.onChange(() => void load());
    return () => {
      unmounted = true;
      clearTimeout(review);
      end();
    };
  });
  $effect(() => {
    let received = false;
    const end = api.actions.onLive((e) => {
      received = true;
      direct = e;
    });
    void api.actions.live().then((e) => {
      if (!received) direct = e;
    });
    return end;
  });

  const current = $derived(direct.running.find((c) => c.action === id) ?? null);
  const pending = $derived(direct.waiting.some((a) => a.action === id));
  const running = $derived(current !== null || pending);
  const grantNeed = $derived(!!action && action.account.length > 0 && !action.grant);
  /** The outcome of a launch refused without writing anything: this page's, otherwise a suggestion's or « Lancer »'s. */
  const shownError = $derived(launchError ?? action?.denial ?? null);
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
      const r = await api.actions.launch(id, action.input ? input : null);
      // Nothing written (workshop stopped, workflow.json missing or invalid, grant required…): the page could not re-read it.
      if (!r.run) {
        launchError = r.error ?? "L'action n'a pas pu être lancée";
        cardOpen = true;
      } else if (execution !== null && r.run && r.run !== execution) {
        // The page showed a specific result: it switches to this one.
        api.dispatch({ type: "openAction", windowId: api.windowId, id, name: action.name, run: r.run });
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
    const r = await api.actions.grant({ id, profile: profile, account: [...action.account], public: [...action.public] });
    if (!r.ok) {
      launchError = `Accord non enregistré : ${r.error}`;
      await load();
      return;
    }
    launchError = null;
    await load();
    // Once granted, the run starts (if the required input is there).
    if (action && !grantNeed && (!action.input || input.trim())) void launchAction();
  }

  const choose = (e: string) => action && api.dispatch({ type: "openAction", windowId: api.windowId, id, name: action.name, run: e });
</script>

<div class="defile" data-testid="page-action">
  {#if action === null}
    <p class="message erreur" data-testid="erreur-action">{ACTION_UNKNOWN}</p>
  {:else if action}
    <ActionHeader
      name={action.name}
      bind:input={input}
      inputLabel={action.input?.label ?? null}
      start={lastWithoutResult?.start ?? loaded?.start ?? null}
      busy={running || launch}
      alreadyLaunched={!!loaded || (previous?.length ?? 0) > 0}
      previous={previous}
      launch={() => void launchAction()}
      viewWorkflow={() => api.actions.viewWorkflow(id)}
      choose={choose}
    />
    {#if running}
      {#key current?.start}<ActionProgress current={current} waiting={pending} stop={() => api.actions.stop(id)} />{/key}
    {:else}
      {#if action.error}<p class="message erreur">{action.error}</p>{/if}
      {#if grantNeed}
        <div class="message accord" data-testid="accord-requis">
          <p>Accord requis pour lire avec ton compte : {action.account.join(", ")}</p>
          <button onclick={() => (cardOpen = true)}>Autoriser…</button>
        </div>
      {/if}
      {#if shownError}
        <p class="message erreur" data-testid="erreur-action">{shownError}</p>
      {:else if lastWithoutResult?.error ?? loaded?.error}
        <p class="message erreur" data-testid="erreur-action">{lastWithoutResult?.error ?? loaded?.error}</p>
      {/if}
      {#if loaded === null && execution !== null}
        <div class="message disparu" data-testid="resultat-disparu">
          <p>{RESULT_GONE}</p>
          {#if previous && previous.length > 0}
            <button data-testid="voir-dernier-resultat" onclick={() => choose(previous![0]!.id)}>Voir le dernier résultat</button>
          {/if}
        </div>
      {:else if loaded === null && !lastWithoutResult && !action.input && !grantNeed && !shownError}
        <p class="message" data-testid="pas-de-resultat">Pas encore de résultat</p>
      {:else if loaded?.page?.empty}
        <p class="message" data-testid="aucun-resultat">{NO_RESULT}</p>
      {:else if loaded?.page}
        <PageRender page={loaded.page} action={id} run={loaded.run} />
      {/if}
    {/if}
    {#if grantNeed && cardOpen}
      <AccountGrantCard
        subject="action"
        name={action.name}
        domains={action.account}
        public={action.public}
        profilesForGrant={api.actions.profilesForGrant}
        close={() => (cardOpen = false)}
        allow={(profile) => void giveGrant(profile)}
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
