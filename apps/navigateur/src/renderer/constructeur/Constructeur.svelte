<script lang="ts">
  import "@xyflow/svelte/dist/style.css";
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import { untrack } from "svelte";
  import type { CatalogueBloc } from "@webaios/noyau";
  import { api } from "../etat.svelte";
  import { placeLibre } from "./ajout";
  import Canevas from "./Canevas.svelte";
  import { creerEdition } from "./edition.svelte";
  import Palette from "./Palette.svelte";
  import type { Pastille } from "./pastilles";

  /** Le constructeur du workflow du widget `id` (page `webaios://workflow/<id>`). */
  let { id }: { id: string } = $props();

  // Gardée par fenêtre et par widget : changer d'onglet ne perd ni un brouillon invalide ni l'historique.
  // svelte-ignore state_referenced_locally
  const edition = creerEdition(id, api.workflow);
  let catalogue = $state.raw<CatalogueBloc[]>([]);
  const parType = $derived(new Map(catalogue.map((c) => [c.type, c])));
  let pastilles = $state.raw<Record<string, Pastille>>({});
  let canevas = $state<ReturnType<typeof Canevas>>();
  let lancement = $state(false);

  const nom = $derived(edition.widget?.nom ?? id);
  const aSortie = $derived(edition.brouillon?.blocs.some((b) => b.type === "sortie") ?? false);
  const etat = $derived.by(() => {
    const e = edition.etatEnregistrement;
    if (e === "enregistre") return "Enregistré";
    if (e === "en-cours") return "Enregistrement…";
    if ("invalide" in e) return `Non enregistré : ${e.invalide}`;
    return `Erreur d'enregistrement : ${e.erreur}`;
  });

  /** Éléments et statut de chaque bloc à la dernière vraie exécution (pas un essai). */
  let requetePastilles = 0;
  async function chargerPastilles(): Promise<void> {
    const n = ++requetePastilles;
    const liste = await api.accueil.executions(id);
    if (n !== requetePastilles) return;
    const derniere = liste.find((e) => !e.essai);
    pastilles = Object.fromEntries((derniere?.blocs ?? []).map((b) => [b.id, { statut: b.statut, elements: b.elements }]));
  }

  $effect(() => untrack(() => {
    // Aucun bloc n'est signalé à l'agent tant que l'utilisateur n'en a pas choisi un ici.
    api.workflow.selection(id, null);
    void api.workflow.catalogue().then((c) => (catalogue = c));
    void edition.ouvrir();
    void chargerPastilles().catch(() => {});
    const fin = api.accueil.surChange(() => {
      void edition.relire();
      void chargerPastilles().catch(() => {});
    });
    return () => {
      fin();
      api.workflow.selection(id, null);
    };
  }));

  /** ⌘Z / ⇧⌘Z : annuler et rétablir le canevas, sauf dans un champ de texte (il garde les siens). */
  function touche(e: KeyboardEvent): void {
    if (!e.metaKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== "z") return;
    const cible = e.target as HTMLElement | null;
    if (cible && (cible.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(cible.tagName))) return;
    e.preventDefault();
    if (e.shiftKey) edition.retablir();
    else edition.annuler();
  }

  function ajouter(type: string, position?: { x: number; y: number }): void {
    const c = parType.get(type);
    if (!c || !canevas) return;
    const p = placeLibre(position ?? canevas.centre(), Object.values(edition.positions));
    void edition.ajouter(c, p);
  }

  async function lancer(): Promise<void> {
    lancement = true;
    try {
      await api.workflow.lancer(id);
    } finally {
      lancement = false;
      void chargerPastilles().catch(() => {});
    }
  }

  function reorganiser(): void {
    edition.reorganiser();
    canevas?.ajusterVue();
  }
</script>

<svelte:window onkeydown={touche} />

<div class="constructeur" data-testid="constructeur">
  <header>
    <h1>{nom}</h1>
    <div class="onglets" role="tablist">
      <button role="tab" aria-selected="true" class="actif">Workflow</button>
      <button role="tab" aria-selected="false" disabled>Exécutions</button>
    </div>
    <span class="etat" class:invalide={edition.etatEnregistrement !== "enregistre" && edition.etatEnregistrement !== "en-cours"} data-testid="etat-enregistrement"
      >{etat}</span
    >
    <div class="actions">
      <button disabled>Aperçu du widget</button>
      <button data-testid="reorganiser" disabled={!edition.brouillon} onclick={reorganiser}>Réorganiser</button>
      <button class="lancer" data-testid="lancer" disabled={!edition.disqueValide || lancement} onclick={lancer}>
        {lancement ? "Exécution…" : "▶ Lancer"}
      </button>
    </div>
  </header>

  {#if edition.bandeau}
    <div class="bandeau" data-testid="bandeau-fichier" role="status">
      {#if edition.bandeau === "proposer"}
        <span>L'agent a modifié le workflow pendant que le tien n'était pas enregistré.</span>
        <button data-testid="prendre-version" onclick={() => edition.prendreVersionDisque()}>Prendre sa version</button>
        <button data-testid="garder-mienne" onclick={() => edition.garderLaMienne()}>Garder la mienne</button>
      {:else}
        <span>workflow.json est illisible sur le disque (l'agent est peut-être en train de l'écrire).</span>
        <button data-testid="garder-mienne" onclick={() => edition.garderLaMienne()}>Garder la mienne</button>
      {/if}
    </div>
  {/if}

  {#if edition.chargement === "chargement"}
    <p class="doux message">Chargement…</p>
  {:else if edition.chargement === "introuvable"}
    <p class="doux message">Ce widget n'a pas de workflow (ni workflow.json ni recolte.mjs).</p>
  {:else if typeof edition.chargement === "object"}
    <p class="erreur message" data-testid="workflow-illisible">{edition.chargement.illisible}</p>
  {:else}
    <SvelteFlowProvider>
      <div class="corps">
        <Palette {catalogue} {aSortie} onajouter={(type) => ajouter(type)} />
        <Canevas
          bind:this={canevas}
          {edition}
          catalogue={parType}
          {pastilles}
          onselection={(bloc) => api.workflow.selection(id, bloc)}
          onajouter={(type, p) => ajouter(type, p)}
        />
      </div>
    </SvelteFlowProvider>
  {/if}
</div>

<style>
  .constructeur { height: 100%; display: flex; flex-direction: column; color: var(--texte); min-height: 0; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--bord); flex-wrap: wrap; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .onglets { display: flex; gap: 2px; }
  .onglets button { padding: 4px 10px; border-radius: 6px; border: none; background: none; color: var(--texte-doux); }
  .onglets button.actif { background: var(--fond-actif); color: var(--texte); }
  .onglets button:disabled { opacity: 0.5; }
  .etat { font-size: 12px; color: var(--texte-doux); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .etat.invalide { color: var(--en-erreur); }
  .actions { display: flex; gap: 8px; margin-left: auto; }
  .actions button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .actions button:disabled { opacity: 0.5; }
  .actions .lancer { border-color: var(--accent); background: var(--accent); color: white; }
  .bandeau { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--fond-actif); font-size: 13px; }
  .bandeau span { flex: 1; }
  .corps { flex: 1; display: flex; min-height: 0; }
  .message { padding: 20px 24px; margin: 0; }
  .doux { color: var(--texte-doux); }
  .erreur { color: var(--en-erreur); white-space: pre-wrap; word-break: break-word; }
</style>
