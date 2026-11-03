<script lang="ts">
  import type { EtatFenetre } from "../../commun/modele";
  import { onMount, untrack } from "svelte";
  import { focusPageVide } from "./commande.svelte";
  import { api, etat } from "../etat.svelte";
  import Accueil from "./Accueil.svelte";
  import Essentiels from "./Essentiels.svelte";
  import IaLocale from "./IaLocale.svelte";
  import SuggestionsActions from "./SuggestionsActions.svelte";
  import { suggestionsActions } from "./suggestions";
  import type { ActionAffichee } from "../../commun/actions";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  let saisie = $state("");
  let champ: HTMLInputElement;

  onMount(() => champ.focus());
  // La barre de commande refermée sur l'accueil y rend le clavier.
  $effect(() => {
    if (focusPageVide.n > 0) untrack(() => champ?.focus());
  });

  // Les actions ne sont pas disponibles dans un espace privé (un espace introuvable compte comme privé) : la liste n'est
  // alors même pas demandée.
  const enPrive = $derived(etat.valeur?.espaces.find((e) => e.id === fenetre.espaceActif)?.prive ?? true);
  let actions = $state.raw<ActionAffichee[]>([]);
  let derniere = 0;
  $effect(() => {
    if (enPrive) {
      actions = [];
      return;
    }
    const charger = () => {
      const n = ++derniere;
      api.actions.liste().then(
        (l) => {
          if (n === derniere) actions = l;
        },
        () => {},
      );
    };
    charger();
    return api.actions.surChange(charger);
  });

  // Échap ferme la liste jusqu'à la prochaine frappe.
  let fermee = $state(false);
  let choisie = $state(-1);
  const suggestions = $derived(enPrive || fermee ? [] : suggestionsActions(saisie, actions));
  const ligneHabituelle = $derived(/^\S+\.\S+$/.test(saisie.trim()) ? `Ouvrir ${saisie.trim()}` : `Rechercher « ${saisie.trim()} »`);

  let refus = $state("");
  const cles = $derived(suggestions.map((x) => x.id).join("\0"));
  $effect(() => {
    void cles;
    choisie = -1;
  });
  function valider(i: number) {
    const s = suggestions[i];
    if (s) {
      choisie = -1;
      void api.actions.ouvrir(s.id, s.saisie).then(
        (r) => {
          if (r.ok) {
            saisie = "";
            refus = "";
          } else refus = r.erreur;
        },
        () => (refus = "Le service des actions ne répond pas"),
      );
    } else if (saisie.trim()) {
      api.naviguer(null, saisie.trim());
      saisie = "";
    }
  }
  function touche(e: KeyboardEvent) {
    if (suggestions.length === 0) return;
    const n = suggestions.length + 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      choisie = (choisie + 1) % n;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      choisie = choisie < 0 ? n - 1 : choisie - 1;
    } else if (e.key === "Escape") {
      e.preventDefault();
      fermee = true;
      choisie = -1;
    }
  }
</script>

<div class="page-vide" data-testid="page-vide">
  <div class="ia-locale"><IaLocale /></div>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      valider(choisie);
      choisie = -1;
    }}
  >
    <input
      bind:this={champ}
      bind:value={saisie}
      oninput={() => {
        fermee = false;
        refus = "";
        choisie = -1;
      }}
      onblur={() => (fermee = true)}
      onfocus={() => (fermee = false)}
      onkeydown={touche}
      data-testid="saisie-page-vide"
      placeholder="Rechercher ou saisir une adresse"
      spellcheck="false"
      role={suggestions.length ? "combobox" : undefined}
      aria-expanded={suggestions.length ? true : undefined}
      aria-controls={suggestions.length ? "suggestions-actions" : undefined}
      aria-activedescendant={suggestions.length && choisie >= 0 ? `suggestion-action-${choisie}` : undefined}
    />
    {#if suggestions.length}
      <SuggestionsActions {suggestions} {ligneHabituelle} {choisie} choisir={(i) => valider(i)} />
    {/if}
    {#if refus}<p class="refus" data-testid="refus-action">{refus}</p>{/if}
  </form>
  <Essentiels {fenetre} grand />
  <Accueil />
</div>

<style>
  .page-vide { position: relative; display: flex; flex-direction: column; align-items: center; gap: 32px; padding-top: 12vh; height: 100%; box-sizing: border-box; overflow-y: auto; }
  .ia-locale { position: absolute; top: 12px; right: 16px; }
  form { width: min(560px, 80%); }
  input { width: 100%; box-sizing: border-box; padding: 12px 16px; font-size: 16px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); outline: none; }
  .refus { margin: 6px 4px 0; color: var(--en-erreur); font-size: 13px; }
  input:focus { border-color: var(--accent); }
  .page-vide :global([data-testid="essentiels-page-vide"]) { width: min(560px, 80%); }
</style>
