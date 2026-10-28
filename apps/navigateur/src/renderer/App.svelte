<script lang="ts">
  import BarreLaterale from "./composants/BarreLaterale.svelte";
  import MenuContextuel from "./composants/MenuContextuel.svelte";
  import { adresse } from "./composants/adresse.svelte";
  import { focusAgent } from "./composants/agent.svelte";
  import { recherche } from "./composants/recherche.svelte";
  import ZoneContenu from "./composants/ZoneContenu.svelte";
  import PanneauAgent from "./composants/PanneauAgent.svelte";
  import ModaleDemande from "./composants/ModaleDemande.svelte";
  import ModaleEspace from "./composants/ModaleEspace.svelte";
  import { reglagesEspace } from "./composants/reglagesEspace.svelte";
  import { estDemandeAgent } from "./composants/modale.svelte";
  import type { Panneau } from "../commun/api";
  import { untrack } from "svelte";
  import { acces, api, demandeDe, etat, fenetreCourante } from "./etat.svelte";
  import { BORD_REVELATION, LARGEUR_AGENT_MAX, LARGEUR_AGENT_MIN } from "../commun/modele";

  const MASQUAGE_MS = 300;

  const fenetre = $derived(fenetreCourante());
  const panneauAgentOuvert = $derived(fenetre?.panneauAgentOuvert ?? false);
  const ongletActif = $derived.by(() => {
    const id = fenetre?.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });

  // Mode compact : la barre réapparaît quand la souris touche le bord gauche. Une page web couvrant
  // toujours l'interface, la barre « révélée » reprend sa colonne le temps du survol.
  const compact = $derived(fenetre?.compact ?? false);
  // Plein écran HTML (vidéo) : seule la page reste.
  let pleinEcran = $state(false);
  let revelee = $state(false);
  let survolBarre = false;
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const barreVisible = $derived(!pleinEcran && (!compact || revelee));

  function reveler() {
    clearTimeout(minuterie);
    if (compact) revelee = true;
  }
  function planifierMasquage() {
    clearTimeout(minuterie);
    if (!revelee || survolBarre || acces.bullesOuvertes > 0) return;
    minuterie = setTimeout(() => {
      if (!survolBarre && acces.bullesOuvertes === 0) revelee = false;
    }, MASQUAGE_MS);
  }

  // La bulle d'accès est montée hors de la barre : la souris qui s'y trouve ne la fait pas quitter ; à sa fermeture, le masquage reprend.
  $effect(() => {
    if (acces.bullesOuvertes === 0) untrack(planifierMasquage);
  });

  let panneau = $state<Panneau | null>(null);

  // Une demande de l'agent couvre toute la fenêtre (barre latérale et panneau agent compris) ; sous un panneau de
  // l'interface, la page n'est pas affichée : pas de capture à montrer derrière.
  const demande = $derived(demandeDe(fenetre, ongletActif));
  const demandeAgent = $derived(demande && estDemandeAgent(demande) ? demande : undefined);
  const basculerPanneau = (p: Panneau) => (panneau = panneau === p ? null : p);
  $effect(() => api.surPanneau(basculerPanneau));
  // Activer un autre onglet referme le panneau et la recherche (pas un simple changement d'état ailleurs).
  const idActif = $derived(ongletActif?.id);
  $effect(() => {
    void idActif;
    panneau = null;
    recherche.ouverte = false;
    recherche.resultat = null;
  });

  $effect(() =>
    api.surRaccourci((r) => {
      if (r === "adresse") adresse.focus++;
      else if (r === "agent") focusAgent.n++;
      else if (r === "rechercher") {
        recherche.ouverte = true;
        recherche.focus++;
      } else if (recherche.ouverte) recherche.pas = { n: recherche.pas.n + 1, precedent: r === "chercherPrecedent" };
    }),
  );
  $effect(() => api.surResultatRecherche((r) => (recherche.resultat = r)));

  // Page d'accueil : le panneau agent y est ouvert par défaut (spec §7), et se referme en la quittant s'il ne
  // s'était ouvert que pour elle. Si l'utilisateur le ferme sur la page d'accueil, il y reste fermé jusqu'au prochain lancement.
  let panneauFermeSurAccueil = false;
  /** Ouverture demandée par la page d'accueil, pas encore revenue dans l'état (null : aucune). */
  let attendu: boolean | null = null;
  let ouvertParAccueil = false;
  let ouvertAvant = false;
  $effect(() => {
    const ouvert = panneauAgentOuvert;
    const f = fenetre;
    if (!f) return;
    const surAccueil = !ongletActif;
    if (ouvert !== ouvertAvant) {
      // Changement venu d'ailleurs (⌘J, bouton ✦) : le panneau appartient désormais à l'utilisateur.
      const deUtilisateur = ouvert !== attendu;
      if (deUtilisateur) ouvertParAccueil = false;
      if (deUtilisateur && surAccueil && !ouvert) panneauFermeSurAccueil = true;
      attendu = null;
    }
    ouvertAvant = ouvert;
    // Un onglet s'est affiché avant que l'ouverture n'aboutisse : elle a été refusée (voir panneauAgentAccueil).
    if (!surAccueil && !ouvert) {
      attendu = null;
      ouvertParAccueil = false;
    }
    // L'action est idempotente : la renvoyer tant que l'état ne l'a pas reflétée ne bascule rien.
    const demander = (v: boolean) => {
      attendu = v;
      api.agir({ type: "panneauAgentAccueil", fenetreId: f.id, ouvert: v });
    };
    if (surAccueil && !ouvert && !panneauFermeSurAccueil) {
      ouvertParAccueil = true;
      demander(true);
    } else if (!surAccueil && ouvert && ouvertParAccueil) {
      ouvertParAccueil = false;
      demander(false);
    }
  });

  // Largeur du panneau agent : celle des réglages, ou celle que l'utilisateur est en train de tirer (enregistrée au lâcher).
  const largeurReglee = $derived(etat.valeur?.reglages.largeurPanneauAgent ?? 420);
  let largeurTiree = $state<number | null>(null);
  const largeurAgent = $derived(largeurTiree ?? largeurReglee);
  $effect(() => {
    void largeurReglee;
    largeurTiree = null; // la largeur enregistrée est revenue dans l'état
  });
  function redimensionnerAgent(voulue: number, fin: boolean) {
    // Toujours de la place pour la page : 300 px au moins à côté de la barre latérale.
    const max = Math.min(LARGEUR_AGENT_MAX, window.innerWidth - (barreVisible ? 240 : 0) - 300);
    const largeur = Math.round(Math.max(LARGEUR_AGENT_MIN, Math.min(max, voulue)));
    if (fin) api.agir({ type: "largeurPanneauAgent", largeur });
    largeurTiree = largeur;
  }

  $effect(() => api.surPleinEcran((actif) => (pleinEcran = actif)));

  $effect(() => api.surBordGauche((dedans) => (dedans ? reveler() : planifierMasquage())));
  $effect(() => {
    if (!compact) revelee = false;
  });
</script>

<svelte:window onmousemove={(e) => compact && !revelee && e.clientX < BORD_REVELATION && reveler()} />

<div class="fenetre" inert={!!demandeAgent || !!reglagesEspace.brouillon} class:compact={!barreVisible} class:agent={panneauAgentOuvert && !pleinEcran} style:--agent="{largeurAgent}px">
  {#if fenetre}
    <BarreLaterale
      {fenetre}
      cachee={!barreVisible}
      {basculerPanneau}
      surEntree={() => {
        survolBarre = true;
        clearTimeout(minuterie);
      }}
      surSortie={() => {
        survolBarre = false;
        planifierMasquage();
      }}
    />
  {:else}
    <aside data-testid="barre-laterale"></aside>
  {/if}
  <ZoneContenu {fenetre} onglet={ongletActif} {panneau} fermerPanneau={() => (panneau = null)} />
  <PanneauAgent visible={panneauAgentOuvert && !pleinEcran} redimensionner={redimensionnerAgent} />
</div>
<MenuContextuel />
<!-- Une demande de l'agent passe devant les réglages d'un espace, qui reviennent ensuite avec leur brouillon. -->
{#if demandeAgent}
  <ModaleDemande demande={demandeAgent} ongletId={panneau ? null : (ongletActif?.id ?? null)} />
{:else if reglagesEspace.brouillon && fenetre}
  <ModaleEspace fenetreId={fenetre.id} ongletId={panneau ? null : (ongletActif?.id ?? null)} />
{/if}

<style>
  .fenetre {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100%;
  }
  .fenetre.agent { grid-template-columns: 240px 1fr var(--agent); }
  .fenetre.compact { grid-template-columns: 1fr; }
  /* Sans barre latérale, les boutons de fenêtre de macOS tombent sur le contenu : les pages de l'interface les évitent. */
  .fenetre.compact { --retrait-feux: 28px; }
  .fenetre.compact.agent { grid-template-columns: 1fr var(--agent); }
</style>
