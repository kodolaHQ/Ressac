<script lang="ts">
  // The agent panel of the window, in its own iframe.
  import { untrack } from "svelte";
  import PanneauAgent from "../ui/composants/PanneauAgent.svelte";
  import { focusAgent } from "../ui/composants/agent.svelte";
  import { api, etat, fenetreCourante } from "../ui/etat.svelte";
  import { AGENT_WIDTH_MAX, AGENT_WIDTH_MIN } from "../shared/modele";

  const win = window.parent.webaiosWindow!;
  const fenetre = $derived(fenetreCourante());
  const panneauAgentOuvert = $derived(fenetre?.panneauAgentOuvert ?? false);
  const ongletActif = $derived.by(() => {
    const id = fenetre?.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });
  $effect(() => api.surRaccourci((r) => r === "agent" && focusAgent.n++));

  // The panel is open by default on the home page (the agent's session starts there), and closes
  // when leaving it if it opened only for it. Closed by the user on the home page, it stays closed there until next launch.
  let panneauFermeSurAccueil = false;
  /** Opening asked by the home page, not back in the state yet (null: none). */
  let attendu: boolean | null = null;
  let ouvertParAccueil = false;
  let ouvertAvant = false;
  $effect(() => {
    const ouvert = panneauAgentOuvert;
    const f = fenetre;
    if (!f) return;
    const surAccueil = !ongletActif;
    if (ouvert !== ouvertAvant) {
      // A change from elsewhere (⌘J, ✦ button): the panel now belongs to the user.
      const deUtilisateur = ouvert !== attendu;
      // Opened by the user: the terminal takes the keyboard. Opened again by the home page: it does not.
      if (deUtilisateur && ouvert) untrack(() => focusAgent.n++);
      if (deUtilisateur) ouvertParAccueil = false;
      if (deUtilisateur && surAccueil && !ouvert) panneauFermeSurAccueil = true;
      attendu = null;
    }
    ouvertAvant = ouvert;
    // A tab showed before the opening went through: it was refused (see panneauAgentAccueil).
    if (!surAccueil && !ouvert) {
      attendu = null;
      ouvertParAccueil = false;
    }
    // The action is idempotent: sending it again until the state reflects it toggles nothing.
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

  /** Width of this iframe when the drag started. */
  let debut: number | null = null;
  function redimensionner(voulue: number, fin: boolean) {
    // The handle measures in this iframe, whose left edge moves with the width: back to window coordinates.
    debut ??= window.innerWidth;
    const reelle = voulue - debut + window.innerWidth;
    // Always room for the page: 300 px at least beside the sidebar.
    const max = Math.min(AGENT_WIDTH_MAX, window.parent.innerWidth - win.sidebarWidth() - 300);
    const largeur = Math.round(Math.max(AGENT_WIDTH_MIN, Math.min(max, reelle)));
    win.setAgentWidth(largeur);
    if (fin) {
      debut = null;
      api.agir({ type: "largeurPanneauAgent", largeur });
    }
  }
</script>

<PanneauAgent visible={panneauAgentOuvert} {redimensionner} />

<style>
  :global(html), :global(body) { height: 100%; margin: 0; }
  :global(body) { display: flex; }
  :global(body > .agent) { flex: 1; }
</style>
