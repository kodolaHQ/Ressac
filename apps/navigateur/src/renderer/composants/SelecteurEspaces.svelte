<script lang="ts">
  import Icone from "./Icone.svelte";
  import { PROFIL_DEFAUT, type Espace, type EtatFenetre } from "../../commun/modele";
  import { api, etat } from "../etat.svelte";
  import { ouvrirMenu } from "./menu.svelte";
  import { perdConnexions } from "./profilsEspace";
  import { reglagesEspace } from "./reglagesEspace.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  /** Espace à supprimer en attente de confirmation (il contient des onglets, ou il emporte des connexions). */
  let aSupprimer = $state<{ espace: Espace; onglets: number; connexions: boolean } | null>(null);

  function supprimer(espace: Espace) {
    const n = Object.values(etat.valeur?.onglets ?? {}).filter((o) => o.espaceId === espace.id).length;
    const connexions = perdConnexions(etat.valeur?.espaces ?? [], espace);
    if (n > 0 || connexions) aSupprimer = { espace, onglets: n, connexions };
    else api.agir({ type: "supprimerEspace", id: espace.id });
  }

  // Un réglage garde le profil actuel de l'espace (seul ou partagé) ; un nouvel espace prend celui de l'espace actif.
  const regler = (espace: Espace) =>
    (reglagesEspace.brouillon = { id: espace.id, nom: espace.nom, icone: espace.icone, prive: espace.prive, profil: espace.profil });
  function creer() {
    const profil = etat.valeur?.espaces.find((x) => x.id === fenetre.espaceActif)?.profil ?? PROFIL_DEFAUT;
    reglagesEspace.brouillon = { id: null, nom: "", icone: "📁", prive: false, profil };
  }
</script>

{#if aSupprimer}
  {@const { espace, onglets, connexions } = aSupprimer}
  <div class="confirmation" role="alertdialog" aria-label="Supprimer l'espace">
    <p>
      {#if onglets > 0}Supprimer l'espace « {espace.nom} » et ses {onglets} onglet{onglets > 1 ? "s" : ""} ?{:else}Supprimer l'espace « {espace.nom} » ?{/if}
      {#if connexions}Les connexions de cet espace seront perdues.{/if}
    </p>
    <div class="boutons">
      <button onclick={() => (aSupprimer = null)}>Annuler</button>
      <button
        class="danger"
        onclick={() => {
          api.agir({ type: "supprimerEspace", id: espace.id });
          aSupprimer = null;
        }}>Supprimer</button
      >
    </div>
  </div>
{/if}
<nav class="espaces">
  {#each etat.valeur?.espaces ?? [] as espace (espace.id)}
    <button
      data-testid="espace-{espace.id}"
      aria-current={espace.id === fenetre.espaceActif ? "true" : undefined}
      title={espace.prive ? `${espace.nom} (privé)` : espace.nom}
      data-prive={espace.prive || undefined}
      onclick={() => api.agir({ type: "activerEspace", fenetreId: fenetre.id, id: espace.id })}
      oncontextmenu={(e) =>
        ouvrirMenu(e, [
          { libelle: "Réglages", agir: () => regler(espace) },
          ...((etat.valeur?.espaces.length ?? 0) > 1 ? [{ libelle: "Supprimer", agir: () => supprimer(espace) }] : []),
        ])}
      >{espace.icone}{#if espace.prive}<span class="cadenas" aria-hidden="true">🔒</span>{/if}</button
    >
  {/each}
  <button data-testid="nouvel-espace" title="Nouvel espace" onclick={creer}><Icone nom="plus" /></button>
</nav>

<style>
  .espaces { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 0; }
  .espaces button { all: unset; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); position: relative; }
  .espaces button:hover { background: var(--fond-survol); }
  .espaces button[aria-current="true"] { background: var(--fond-actif); }
  .cadenas { position: absolute; right: -3px; bottom: -3px; font-size: 9px; line-height: 1; }
  .confirmation { padding: 8px; border-radius: 6px; background: var(--fond-actif); color: var(--texte); -webkit-app-region: no-drag; }
  .confirmation p { margin: 0 0 8px; }
  .boutons { display: flex; justify-content: flex-end; gap: 6px; }
  .boutons button { padding: 4px 8px; border-radius: 4px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .danger { background: #c0392b; border-color: #c0392b; color: white; }
</style>
