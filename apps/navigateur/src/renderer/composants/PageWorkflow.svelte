<script lang="ts">
  import type { Execution, ResumeExecution, TraceBloc } from "@webaios/noyau";
  import type { VueWorkflow, WidgetAffiche } from "../../commun/api";
  import { api } from "../etat.svelte";

  /** Vue provisoire en lecture seule (l'étape 2 la remplace par le canevas) : le widget `id`, son workflow, ses exécutions. */
  let { id }: { id: string } = $props();

  let widget = $state.raw<WidgetAffiche | null>(null);
  let vue = $state.raw<VueWorkflow | null>(null);
  let executions = $state.raw<ResumeExecution[]>([]);
  let chargee = $state(false);
  let choisie = $state<string | null>(null);
  let detail = $state.raw<Execution | null>(null);
  /** Sorties dépliées (`<exécution>/<bloc>`) : une sortie n'est mise en forme qu'une fois ouverte (jusqu'à 256 Ko). */
  let ouvertes = $state<Record<string, boolean>>({});

  // Lectures qui se croisent (rafale de changements) : seule la dernière compte.
  let requete = 0;
  async function charger() {
    const n = ++requete;
    const [w, v, e] = await Promise.all([api.accueil.lire(), api.accueil.workflow(id), api.accueil.executions(id)]);
    if (n !== requete) return;
    widget = w.find((x) => x.id === id) ?? null;
    vue = v;
    executions = e;
    chargee = true;
    // L'exécution choisie a pu partir (seules les 20 dernières sont gardées).
    if (choisie && !e.some((x) => x.id === choisie)) choisie = null;
    await chargerDetail();
  }

  let requeteDetail = 0;
  async function chargerDetail() {
    const n = ++requeteDetail;
    const cible = choisie;
    const d = cible ? await api.accueil.execution(id, cible) : null;
    if (n === requeteDetail) detail = d;
  }

  $effect(() => {
    void id;
    choisie = null;
    void charger().catch(() => {});
    return api.accueil.surChange(() => void charger().catch(() => {}));
  });

  function choisir(e: ResumeExecution) {
    choisie = choisie === e.id ? null : e.id;
    void chargerDetail().catch(() => {});
  }

  const nom = $derived(widget && !("erreur" in widget) ? widget.nom : id);
  const enCours = $derived(!!widget && !("erreur" in widget) && widget.etat.statut === "en-cours");
  /** Éléments produits par chaque bloc à la dernière exécution. */
  const derniers = $derived(new Map((executions[0]?.blocs ?? []).map((b) => [b.id, b.elements])));

  const DECLENCHEURS: Record<Execution["declencheur"], string> = { planifiee: "Planifiée", manuelle: "Manuelle", agent: "Par l'agent" };
  const STATUTS: Record<Execution["statut"], string> = {
    reussie: "Réussie",
    partielle: "Partielle",
    echouee: "Échouée",
    interrompue: "Interrompue",
    "accord-requis": "Accord requis",
  };
  const STATUTS_BLOC: Record<TraceBloc["statut"], string> = {
    reussi: "Réussi",
    partiel: "Partiel",
    echoue: "Échoué",
    interrompu: "Interrompu",
    "pas-lance": "Pas lancé",
  };
  /** Couleur de la pastille : la même échelle pour une exécution et pour un bloc. */
  const TEINTES: Record<string, "ok" | "moyen" | "echec" | "neutre"> = {
    reussie: "ok",
    reussi: "ok",
    partielle: "moyen",
    partiel: "moyen",
    "accord-requis": "moyen",
    echouee: "echec",
    echoue: "echec",
    interrompue: "echec",
    interrompu: "echec",
    "pas-lance": "neutre",
  };

  const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
  /** « 0,4 s », « 12 s », « 2 min 05 s » ; « en cours » sans fin. */
  function duree(debut: string | null, fin: string | null): string {
    if (!debut) return "—";
    if (!fin) return "en cours";
    const ms = Math.max(0, new Date(fin).getTime() - new Date(debut).getTime());
    if (ms < 10_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  }
  const elements = (n: number | null | undefined) => (n == null ? null : `${n} élément${n > 1 ? "s" : ""}`);
  const json = (v: unknown) => JSON.stringify(v, null, 2) ?? String(v);
  /** Une sortie tronquée est gardée en texte : le début de son JSON, tel quel. */
  const sortie = (b: TraceBloc) => (b.sortieTronquee && typeof b.sortie === "string" ? b.sortie : json(b.sortie));
</script>

<div class="workflow" data-testid="page-workflow">
  <header>
    <div>
      <h1>{nom}</h1>
      <p class="doux">Workflow du widget, en lecture seule.</p>
    </div>
    <button class="lancer" disabled={enCours || !vue || "erreur" in vue} onclick={() => api.accueil.recolter(id)}>
      {enCours ? "Mise à jour…" : "Lancer maintenant"}
    </button>
  </header>

  <section>
    <h2>Blocs</h2>
    {#if !chargee}
      <p class="doux">Chargement…</p>
    {:else if !vue}
      <p class="doux">Ce widget n'a pas de workflow (ni workflow.json ni recolte.mjs).</p>
    {:else if "erreur" in vue}
      <p class="erreur" data-testid="workflow-invalide">{vue.erreur}</p>
    {:else}
      {#if vue.origine === "implicite"}<p class="doux">Workflow implicite (recolte.mjs).</p>{/if}
      <ol class="blocs">
        {#each vue.blocs as b (b.id)}
          <li>
            <div class="ligne">
              <b>{b.nom ?? b.id}</b>
              <code>{b.type}</code>
              {#if b.entrees.length}<span class="doux">← {b.entrees.join(", ")}</span>{/if}
              {#if elements(derniers.get(b.id))}<span class="doux elements">{elements(derniers.get(b.id))} à la dernière exécution</span>{/if}
            </div>
            {#if b.nom}<p class="doux id">{b.id}</p>{/if}
            <pre>{json(b.parametres)}</pre>
          </li>
        {/each}
      </ol>
    {/if}
  </section>

  <section>
    <h2>Dernières exécutions</h2>
    {#if chargee && !executions.length}
      <p class="doux">Aucune exécution pour l'instant.</p>
    {:else}
      <ul class="executions">
        {#each executions as e (e.id)}
          <li>
            <button class:actif={choisie === e.id} onclick={() => choisir(e)}>
              <span class="pastille {TEINTES[e.statut]}"></span>
              <span class="quand">{date(e.debut)}</span>
              <span>{DECLENCHEURS[e.declencheur]}</span>
              <span>{STATUTS[e.statut]}</span>
              <span class="doux">{duree(e.debut, e.fin)}</span>
            </button>
            {#if choisie === e.id && detail?.id === e.id}
              <div class="detail">
                {#if detail.erreur}<p class="erreur">{detail.erreur}</p>{/if}
                <ol class="blocs">
                  {#each detail.blocs as b (b.id)}
                    {@const cle = `${detail.id}/${b.id}`}
                    <li>
                      <div class="ligne">
                        <span class="pastille {TEINTES[b.statut]}"></span>
                        <b>{b.id}</b>
                        <code>{b.type}</code>
                        <span>{STATUTS_BLOC[b.statut]}</span>
                        <span class="doux">{duree(b.debut, b.fin)}</span>
                        {#if elements(b.elements)}<span class="doux">{elements(b.elements)}</span>{/if}
                      </div>
                      {#if b.erreur}<p class="erreur">{b.erreur}</p>{/if}
                      {#if b.sortie !== undefined}
                        <details ontoggle={(ev) => (ouvertes[cle] = (ev.currentTarget as HTMLDetailsElement).open)}>
                          <summary>Sortie{#if b.sortieTronquee} <span class="tronquee">tronquée</span>{/if}</summary>
                          {#if ouvertes[cle]}<pre>{sortie(b)}</pre>{/if}
                        </details>
                      {/if}
                      {#if b.journal.length}
                        <details>
                          <summary>Journal ({b.journal.length})</summary>
                          <pre>{b.journal.join("\n")}</pre>
                        </details>
                      {/if}
                    </li>
                  {/each}
                </ol>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .workflow { height: 100%; overflow-y: auto; padding: 20px 24px; color: var(--texte); box-sizing: border-box; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; }
  h2 { margin: 20px 0 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--texte-doux); }
  p { margin: 4px 0; }
  .doux { color: var(--texte-doux); font-size: 12px; }
  .erreur { color: var(--en-erreur); white-space: pre-wrap; word-break: break-word; }
  .lancer { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: white; flex: none; }
  .lancer:disabled { opacity: 0.5; }
  ol, ul { list-style: none; margin: 0; padding: 0; }
  .blocs > li { padding: 10px 8px; border-bottom: 1px solid var(--bord); }
  .ligne { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
  .elements { margin-left: auto; }
  .id { margin: 2px 0 0; }
  code { font-size: 12px; padding: 1px 6px; border-radius: 4px; background: var(--fond-survol); }
  pre { margin: 6px 0 0; padding: 8px 10px; max-height: 360px; overflow: auto; border-radius: 6px; background: var(--fond-barre); border: 1px solid var(--bord); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .executions > li { border-bottom: 1px solid var(--bord); }
  .executions button { all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 8px 170px 110px 110px 1fr; align-items: center; gap: 10px; padding: 8px; border-radius: 6px; cursor: pointer; }
  .executions button:hover { background: var(--fond-survol); }
  .executions button.actif { background: var(--fond-actif); }
  .quand { font-variant-numeric: tabular-nums; }
  .detail { padding: 0 8px 10px 26px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; font-size: 12px; color: var(--texte-doux); }
  .tronquee { padding: 0 6px; border-radius: 4px; background: var(--fond-actif); color: var(--texte); }
  .pastille { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--arretee); }
  .pastille.ok { background: var(--en-marche); }
  .pastille.moyen { background: var(--en-cours); }
  .pastille.echec { background: var(--en-erreur); }
</style>
