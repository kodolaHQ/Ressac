<script lang="ts">
  import type { Panneau } from "../../commun/api";
  import { URL_APPLICATIONS, type EtatFenetre } from "../../commun/modele";
  import { api, etat, telechargements } from "../etat.svelte";
  import BarreAdresse from "./BarreAdresse.svelte";
  import Essentiels from "./Essentiels.svelte";
  import Icone from "./Icone.svelte";
  import IconeSite from "./IconeSite.svelte";
  import ListeOnglets from "./ListeOnglets.svelte";
  import { ouvrirMenu } from "./menu.svelte";
  import SelecteurEspaces from "./SelecteurEspaces.svelte";

  let {
    fenetre,
    cachee = false,
    surEntree,
    surSortie,
    basculerPanneau,
  }: {
    fenetre: EtatFenetre;
    cachee?: boolean;
    surEntree?: () => void;
    surSortie?: () => void;
    basculerPanneau?: (p: Panneau) => void;
  } = $props();
  const enCours = $derived(telechargements.liste.filter((t) => t.etat === "en-cours"));
  const progression = $derived.by(() => {
    const total = enCours.reduce((s, t) => s + t.total, 0);
    return total ? enCours.reduce((s, t) => s + t.recus, 0) / total : 0;
  });
  const espace = $derived(etat.valeur?.espaces.find((e) => e.id === fenetre.espaceActif));
  const ongletActif = $derived.by(() => {
    const id = fenetre.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });
  const lienActif = $derived(ongletActif?.lien?.id);
</script>

<aside class="barre" data-testid="barre-laterale" hidden={cachee} onmouseenter={surEntree} onmouseleave={surSortie}>
  <BarreAdresse {fenetre} />
  <div class="defilant">
    <Essentiels {fenetre} />
    <ul
      class="epingles"
      data-testid="epingles"
      ondragover={(e) => e.dataTransfer?.types.includes("application/x-webaios-onglet") && e.preventDefault()}
      ondrop={(e) => {
        const id = e.dataTransfer?.getData("application/x-webaios-onglet");
        if (id) api.agir({ type: "epinglerOnglet", id });
      }}
    >
      {#each espace?.epingles ?? [] as favori (favori.id)}
        <li>
          <button
            data-testid="favori-{favori.id}"
            class:actif={favori.id === lienActif}
            onclick={() => api.agir({ type: "ouvrirFavori", fenetreId: fenetre.id, genre: "epingle", id: favori.id })}
            oncontextmenu={(e) =>
              ouvrirMenu(e, [{ libelle: "Retirer", agir: () => api.agir({ type: "desepingler", espaceId: fenetre.espaceActif, favoriId: favori.id }) }])}
          >
            <IconeSite favicon={favori.favicon} titre={favori.titre} />
            <span>{favori.titre}</span>
          </button>
        </li>
      {/each}
    </ul>
    <hr />
    <ListeOnglets {fenetre} />
    <button class="nouveau" data-testid="nouvel-onglet" onclick={() => api.agir({ type: "afficherPageVide", fenetreId: fenetre.id })}><Icone nom="plus" taille={14} /> Nouvel onglet</button>
  </div>
  <footer>
    <SelecteurEspaces {fenetre} />
    <button
      class="outil"
      data-testid="bouton-agent"
      aria-label="Agent (⌘J)"
      title="Agent (⌘J)"
      aria-pressed={fenetre.panneauAgentOuvert}
      onclick={() => api.agir({ type: "basculerPanneauAgent", fenetreId: fenetre.id })}><Icone nom="agent" /></button
    >
    <button
      class="outil"
      data-testid="bouton-applications"
      aria-label="Applications (⇧⌘A)"
      title="Applications (⇧⌘A)"
      aria-pressed={ongletActif?.url === URL_APPLICATIONS}
      onclick={() => api.agir({ type: "ouvrirApplications", fenetreId: fenetre.id })}><Icone nom="applications" /></button
    >
    {#if telechargements.liste.length}
      <button class="telechargements" aria-label="Téléchargements" title="Téléchargements" onclick={() => basculerPanneau?.("telechargements")}>
        <Icone nom="telecharger" />
        {#if enCours.length}<span class="pastille" style:--p={progression}></span>{/if}
      </button>
    {/if}
  </footer>
</aside>

<style>
  .barre {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px 8px 0;
    background: var(--fond-barre);
    -webkit-app-region: drag;
  }
  .barre[hidden] { display: none; }
  .defilant { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; -webkit-app-region: no-drag; }
  .barre :global(nav) { -webkit-app-region: no-drag; }
  .epingles { list-style: none; margin: 0; padding: 0; min-height: 8px; }
  .epingles button { all: unset; display: flex; align-items: center; gap: 8px; width: calc(100% - 12px); height: 32px; padding: 0 6px; border-radius: 6px; color: var(--texte); }
  .epingles button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .epingles button:hover { background: var(--fond-survol); }
  .epingles button.actif { background: var(--fond-actif); }
  footer { display: flex; align-items: flex-end; gap: 4px; -webkit-app-region: no-drag; }
  footer :global(nav) { flex: 1; }
  .telechargements { all: unset; position: relative; width: 28px; height: 28px; margin-bottom: 8px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); }
  .telechargements:hover { background: var(--fond-survol); }
  .outil { all: unset; width: 28px; height: 28px; margin-bottom: 8px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); }
  .outil:hover { background: var(--fond-survol); }
  .outil[aria-pressed="true"] { color: var(--accent); }
  .pastille { position: absolute; inset: 3px; border-radius: 50%; background: conic-gradient(var(--accent) calc(var(--p) * 360deg), transparent 0); mask: radial-gradient(circle, transparent 55%, black 56%); }
  hr { width: 100%; border: none; border-top: 1px solid var(--bord); margin: 2px 0; }
  .nouveau { all: unset; display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 6px; color: var(--texte-doux); }
  .nouveau:hover { background: var(--fond-survol); }
</style>
