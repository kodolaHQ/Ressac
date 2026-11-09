<script lang="ts">
  import "@xyflow/svelte/dist/style.css";
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import { untrack } from "svelte";
  import type { CatalogueBloc, Proprietaire } from "@webaios/noyau";
  import { focusAgent } from "../composants/agent.svelte";
  import { api } from "../etat.svelte";
  import { placeLibre } from "./ajout";
  import ApercuAction from "./ApercuAction.svelte";
  import ApercuWidget from "./ApercuWidget.svelte";
  import BarreExecutions from "./BarreExecutions.svelte";
  import Canevas from "./Canevas.svelte";
  import { cleCible, depotDe, lanceurDe, sourceExecutionsDe } from "./cible";
  import { confirmerChangementDeBloc, garderAvantFermeture } from "./codes.svelte";
  import { creerEdition, suivreDisparitions } from "./edition.svelte";
  import { Executions } from "./executions.svelte";
  import ListeExecutions from "./ListeExecutions.svelte";
  import OngletAgent from "./OngletAgent.svelte";
  import OngletBloc from "./OngletBloc.svelte";
  import Palette from "./Palette.svelte";
  import { pastillesDe } from "./pastilles";

  /**
   * Le constructeur du workflow d'un widget (page `webaios://workflow/<id>`) ou d'une action
   * (`webaios://workflow/action/<id>`) : même canevas ; une action a son panneau, sa saisie au lancement et l'aperçu de
   * sa page.
   */
  let { cible }: { cible: Proprietaire } = $props();
  // svelte-ignore state_referenced_locally
  const estAction = cible.type === "action";
  /** La clé de ce workflow dans les états de la fenêtre (éditions, codes, exécution choisie). */
  // svelte-ignore state_referenced_locally
  const id = cleCible(cible);

  // Gardée par fenêtre et par workflow : changer d'onglet ne perd ni un brouillon invalide ni l'historique.
  const edition = creerEdition(id, depotDe(api.workflow));
  suivreDisparitions(api.accueil);
  garderAvantFermeture();
  // svelte-ignore state_referenced_locally
  const executions = new Executions(id, sourceExecutionsDe(api, cible), lanceurDe(api, cible));
  /** Ce qui change sur le disque : l'accueil pour un widget, les actions pour une action. */
  const surChange = estAction ? api.actions.surChange : api.accueil.surChange;
  let catalogue = $state.raw<CatalogueBloc[]>([]);
  const parType = $derived(new Map(catalogue.map((c) => [c.type, c])));
  /**
   * Éléments et statut de chaque bloc à l'exécution choisie (par défaut la dernière vraie, pas un essai), remplacés au
   * fil des traces par ceux de l'exécution de ce widget qui tourne.
   */
  const pastilles = $derived(pastillesDe(executions.choisie, executions.enDirect));
  /** Le bloc affiché dans l'onglet « Bloc ». */
  let selection = $state<string | null>(null);
  let canevas = $state<ReturnType<typeof Canevas>>();
  let vue = $state<"workflow" | "executions">("workflow");
  let apercuOuvert = $state(false);
  /** Onglet du volet de droite : le bloc sélectionné, ou la conversation de l'agent de la fenêtre. */
  let ongletDroit = $state<"bloc" | "agent">("bloc");
  // ⌘J ou ✦ pendant que le constructeur est affiché : l'onglet « Agent », dont le terminal prend le clavier.
  const demandesAgent = untrack(() => focusAgent.n);
  $effect(() => {
    if (focusAgent.n !== demandesAgent) ongletDroit = "agent";
  });

  const nom = $derived(edition.widget?.nom ?? edition.action?.nom ?? cible.id);
  /** La saisie demandée par « ▶ Lancer » (action avec une saisie) : la petite fenêtre est ouverte. */
  let demande = $state<{ libelle: string; valeur: string } | null>(null);
  const aSortie = $derived(edition.brouillon?.blocs.some((b) => b.type === "sortie") ?? false);
  const idSortie = $derived(edition.brouillon?.blocs.find((b) => b.type === "sortie")?.id);
  const etat = $derived.by(() => {
    const e = edition.etatEnregistrement;
    if (e === "enregistre") return "Enregistré";
    if (e === "en-cours") return "Enregistrement…";
    if ("invalide" in e) return `Non enregistré : ${e.invalide}`;
    return `Erreur d'enregistrement : ${e.erreur}`;
  });

  const chargerExecutions = () => void executions.charger().catch(() => {});

  /** Un bloc sélectionné sur le canevas ; quitter un code non enregistré demande confirmation. */
  function selectionner(bloc: string | null): void {
    if (bloc === selection) return;
    const courant = selection === null ? undefined : edition.brouillon?.blocs.find((b) => b.id === selection);
    const source = courant?.type === "code" ? courant.parametres.source : undefined;
    if (typeof source === "string" && !confirmerChangementDeBloc(id, source)) {
      canevas?.selectionner(selection);
      return;
    }
    selection = bloc;
    api.workflow.selection(cible, bloc);
  }

  $effect(() => untrack(() => {
    // Aucun bloc n'est signalé à l'agent tant que l'utilisateur n'en a pas choisi un ici.
    api.workflow.selection(cible, null);
    void api.workflow.catalogue().then((c) => (catalogue = c));
    void edition.ouvrir();
    chargerExecutions();
    const finDirect = executions.suivre();
    const fin = surChange(() => {
      void edition.relire();
      chargerExecutions();
    });
    return () => {
      fin();
      finDirect();
      api.workflow.selection(cible, null);
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

  /** « ▶ Lancer » : une action qui a une saisie la demande d'abord ; vide, rien ne part. */
  function lancer(): void {
    const saisie = edition.action?.saisie;
    if (saisie) demande = { libelle: saisie.libelle, valeur: "" };
    else void executions.lancer().catch(() => {});
  }

  function confirmerLancement(e: SubmitEvent): void {
    e.preventDefault();
    const valeur = demande?.valeur.trim();
    if (!valeur) return;
    demande = null;
    void executions.lancer(valeur).catch(() => {});
  }

  function toucheDemande(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    demande = null;
  }

  /** Le champ prend le clavier à l'ouverture de la petite fenêtre. */
  function focaliser(n: HTMLInputElement): void {
    n.focus();
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
      <button role="tab" aria-selected={vue === "workflow"} class:actif={vue === "workflow"} onclick={() => (vue = "workflow")}>Workflow</button>
      <button role="tab" data-testid="vue-executions" aria-selected={vue === "executions"} class:actif={vue === "executions"} onclick={() => (vue = "executions")}
        >Exécutions</button
      >
    </div>
    <span class="etat" class:invalide={edition.etatEnregistrement !== "enregistre" && edition.etatEnregistrement !== "en-cours"} data-testid="etat-enregistrement"
      >{etat}</span
    >
    <div class="actions">
      <button data-testid="bouton-apercu" aria-pressed={apercuOuvert} onclick={() => (apercuOuvert = !apercuOuvert)}>{estAction ? "Aperçu de la page" : "Aperçu du widget"}</button>
      <button data-testid="reorganiser" disabled={!edition.brouillon} onclick={reorganiser}>Réorganiser</button>
      <button class="lancer" data-testid="lancer" disabled={!edition.disqueValide || executions.occupe || edition.etatEnregistrement === "en-cours"} onclick={lancer}>
        {executions.occupe ? "Exécution…" : "▶ Lancer"}
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

  <!-- Le volet de droite : « Bloc » (seulement avec un canevas) et « Agent », la conversation de l'agent de la fenêtre. -->
  {#snippet volet(avecBloc: boolean)}
    <aside class="droite" class:agent={ongletDroit === "agent"} aria-label={ongletDroit === "agent" ? "Agent" : "Bloc"}>
      <div class="onglets-droite" role="tablist">
        {#if avecBloc}
          <button role="tab" aria-selected={ongletDroit === "bloc"} class:actif={ongletDroit === "bloc"} onclick={() => (ongletDroit = "bloc")}>Bloc</button>
        {/if}
        <button role="tab" data-testid="onglet-agent" aria-selected={ongletDroit === "agent"} class:actif={ongletDroit === "agent"} onclick={() => (ongletDroit = "agent")}
          >Agent</button
        >
      </div>
      {#if avecBloc}
        <!-- L'onglet « Bloc » reste monté, caché : un réglage ou du code en cours de frappe n'y est pas perdu. -->
        <div class="volet-bloc" hidden={ongletDroit !== "bloc"}>
          <OngletBloc widget={id} {edition} {executions} catalogue={parType} {selection} />
        </div>
      {/if}
      {#if ongletDroit === "agent"}<OngletAgent />{/if}
    </aside>
  {/snippet}

  {#if edition.chargement === "chargement"}
    <p class="doux message">Chargement…</p>
  {:else if edition.chargement === "introuvable" || typeof edition.chargement === "object"}
    <!-- Sans canevas, l'agent reste là : c'est à lui de réparer ou d'écrire le workflow. -->
    <div class="corps">
      {#if edition.chargement === "introuvable"}
        <p class="doux message">
          {estAction ? "Cette action n'a pas de workflow (workflow.json), ou action.json est illisible." : "Ce widget n'a pas de workflow (ni workflow.json ni recolte.mjs)."}
        </p>
      {:else}
        <p class="erreur message" data-testid="workflow-illisible">{edition.chargement.illisible}</p>
      {/if}
      {@render volet(false)}
    </div>
  {:else}
    <SvelteFlowProvider>
      <div class="corps">
        {#if vue === "executions"}<ListeExecutions {executions} onchoisie={() => (vue = "workflow")} />{/if}
        <Palette {catalogue} {aSortie} web={edition.widget?.web ?? edition.action?.web ?? false} action={estAction} onajouter={(type) => ajouter(type)} />
        <div class="zone-canevas">
          <Canevas
            bind:this={canevas}
            {edition}
            catalogue={parType}
            {pastilles}
            onselection={selectionner}
            onajouter={(type, p) => ajouter(type, p)}
          />
          {#if apercuOuvert}
            {#if cible.type === "action"}<ApercuAction id={cible.id} {executions} />{:else}<ApercuWidget id={cible.id} {executions} />{/if}
          {/if}
        </div>
        {@render volet(true)}
      </div>
      {#if vue === "workflow"}
        <BarreExecutions {executions} {selection} sortie={idSortie} rejouable={edition.disqueValide && edition.etatEnregistrement !== "en-cours"} />
      {/if}
    </SvelteFlowProvider>
  {/if}

  {#if demande}
    <div class="voile">
      <div class="demande" data-testid="demande-saisie" role="dialog" aria-modal="true" aria-label="Lancer l'action">
        <form onsubmit={confirmerLancement}>
          <label>
            <span>{demande.libelle}</span>
            <input data-testid="saisie-lancer" maxlength="200" bind:value={demande.valeur} onkeydown={toucheDemande} use:focaliser />
          </label>
          <div class="boutons">
            <button type="button" onclick={() => (demande = null)}>Annuler</button>
            <button type="submit" class="lancer" data-testid="confirmer-lancer" disabled={!demande.valeur.trim()}>▶ Lancer</button>
          </div>
        </form>
      </div>
    </div>
  {/if}
</div>

<style>
  .constructeur { position: relative; height: 100%; display: flex; flex-direction: column; color: var(--texte); min-height: 0; }
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
  .corps { position: relative; flex: 1; display: flex; min-height: 0; }
  .zone-canevas { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; }
  .droite { width: 320px; flex: none; display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--bord); background: var(--fond-barre); }
  /* La largeur du panneau latéral (--agent, posée par App) : le terminal garde ses colonnes en passant de l'un à l'autre. */
  .droite.agent { width: var(--agent, 420px); }
  .volet-bloc { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .volet-bloc[hidden] { display: none; }
  .onglets-droite { display: flex; gap: 2px; padding: 8px 12px 0; }
  .onglets-droite button { padding: 4px 10px; border-radius: 6px; border: none; background: none; color: var(--texte-doux); }
  .onglets-droite button.actif { background: var(--fond-actif); color: var(--texte); }
  .message { padding: 20px 24px; margin: 0; }
  .corps > .message { flex: 1; min-width: 0; }
  .doux { color: var(--texte-doux); }
  .erreur { color: var(--en-erreur); white-space: pre-wrap; word-break: break-word; }
  .voile { position: absolute; inset: 0; z-index: 10; display: flex; align-items: flex-start; justify-content: center; padding-top: 80px; background: rgba(0, 0, 0, 0.25); }
  .demande form { display: flex; flex-direction: column; gap: 12px; }
  .demande { width: 340px; max-width: calc(100% - 32px); padding: 16px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); box-shadow: var(--ombre-modale); font-size: 13px; }
  .demande label { display: flex; flex-direction: column; gap: 6px; }
  .demande input { padding: 6px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); font: inherit; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .boutons button:disabled { opacity: 0.5; }
  .boutons .lancer { border-color: var(--accent); background: var(--accent); color: white; }
</style>
