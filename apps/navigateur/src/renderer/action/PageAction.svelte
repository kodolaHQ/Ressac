<script lang="ts">
  import { untrack } from "svelte";
  import type { EtatActions, PageAction, ResumeExecution } from "@webaios/noyau";
  import { AUCUN_RESULTAT, type ActionAffichee } from "../../commun/actions";
  import CarteAccordCompte from "../composants/CarteAccordCompte.svelte";
  import { api } from "../etat.svelte";
  import AvancementAction from "./AvancementAction.svelte";
  import EnTeteAction from "./EnTeteAction.svelte";
  import RenduPage from "./RenduPage.svelte";

  /**
   * La page `webaios://action/<id>[/<exécution>]` : le résultat demandé (le dernier sans `execution`), l'avancement d'une
   * exécution en cours, les états (accord, erreur, vide, jamais lancée). L'ouvrir, la recharger ou la restaurer ne lance
   * jamais rien : seuls « Lancer »/« Relancer » (ou Entrée dans la saisie) et l'accord du compte lancent l'action.
   */
  let { id, execution }: { id: string; execution: string | null } = $props();

  /** undefined : pas encore lue ; null : l'action n'existe pas (ou plus). */
  let action = $state<ActionAffichee | null | undefined>(undefined);
  /** undefined : pas encore lu ; null : aucun résultat (jamais lancée, ou l'exécution demandée n'existe plus). */
  let lue = $state<PageAction | null | undefined>(undefined);
  let precedentes = $state<ResumeExecution[] | null>(null);
  /**
   * Sans exécution demandée : la plus récente, quand elle n'a pas donné de résultat (échec, arrêt) et qu'elle est plus
   * récente que le dernier résultat. Son message s'affiche au-dessus de ce résultat, comme un widget en erreur.
   */
  let derniereSansResultat = $state<PageAction | null>(null);
  let direct = $state<EtatActions>({ courantes: [], enAttente: [] });
  /** Un lancement demandé depuis cette page, dont l'issue n'est pas encore revenue. */
  let lancement = $state(false);
  let erreurLancement = $state<string | null>(null);
  let saisie = $state("");
  /** L'exécution dont la saisie a rempli le champ (le champ n'est pas réécrit pendant que l'utilisateur tape). */
  let saisieDe: string | null = null;
  let carteOuverte = $state(true);

  let generation = 0;
  let relecture: ReturnType<typeof setTimeout> | undefined;
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
      // Au démarrage (session restaurée), l'agent n'est peut-être pas prêt : l'action ou ses résultats ne sont pas encore
      // servis alors que des exécutions sont sur le disque. Relu un peu plus tard (lecture seule, rien n'est lancé).
      if (action === null || (gardees.length > 0 && !page && !sansResultat)) relecture = setTimeout(() => void charger(), 2000);
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
  // Une exécution vient de finir (vue par direct) : son résultat est relu.
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
      if (r.statut === "invalide" || (r.statut === "accord-requis" && !r.execution)) {
        erreurLancement = r.erreur ?? "L'action n'a pas pu être lancée";
        carteOuverte = true;
      } else if (execution !== null && r.execution && r.execution !== execution) {
        // La page montrait un résultat précis : elle passe à celui-ci.
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
    // L'accord porte exactement sur ce que la carte a montré.
    const r = await api.actions.accorder({ id, profil, compte: [...action.compte], publiques: [...action.publiques] });
    if (!r.ok) {
      erreurLancement = `Accord non enregistré : ${r.erreur}`;
      await charger();
      return;
    }
    erreurLancement = null;
    await charger();
    // Une fois accordé, l'exécution part (si la saisie requise est là).
    if (action && !besoinAccord && (!action.saisie || saisie.trim())) void lancer();
  }

  const choisir = (e: string) => action && api.agir({ type: "ouvrirAction", fenetreId: api.fenetreId, id, nom: action.nom, execution: e });
</script>

<div class="defile" data-testid="page-action">
  {#if action === null}
    <p class="message erreur" data-testid="erreur-action">Action inconnue</p>
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
      {#if erreurLancement}
        <p class="message erreur" data-testid="erreur-action">{erreurLancement}</p>
      {:else if derniereSansResultat?.erreur ?? lue?.erreur}
        <p class="message erreur" data-testid="erreur-action">{derniereSansResultat?.erreur ?? lue?.erreur}</p>
      {/if}
      {#if lue === null && !derniereSansResultat && !action.saisie && !besoinAccord && !erreurLancement}
        <p class="message" data-testid="pas-de-resultat">Pas encore de résultat</p>
      {:else if lue?.page?.vide}
        <p class="message" data-testid="aucun-resultat">{AUCUN_RESULTAT}</p>
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
  .accord { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .accord p { margin: 0; color: var(--texte); }
  .accord button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font: inherit; }
</style>
