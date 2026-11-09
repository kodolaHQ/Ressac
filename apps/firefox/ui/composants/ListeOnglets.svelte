<script lang="ts">
  import Icone from "./Icone.svelte";
  import type { EtatFenetre } from "../../shared/modele";
  import { accesDe, api, etat, fermerOnglet } from "../etat.svelte";
  import PastilleAcces from "./PastilleAcces.svelte";
  import IconeSite from "./IconeSite.svelte";
  import { ouvrirMenu } from "./menu.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  const ordre = $derived(fenetre.ordre[fenetre.espaceActif] ?? []);
  const actif = $derived(fenetre.actif[fenetre.espaceActif]);
  /** Drop point: before or after the hovered tab, depending on the half under the mouse (the line shows it). */
  let survol = $state<{ index: number; apres: boolean } | null>(null);

  function deposer(e: DragEvent, index: number) {
    const apres = survol?.index === index && survol.apres;
    survol = null;
    const id = e.dataTransfer?.getData("application/x-webaios-onglet");
    if (!id) return;
    // deplacerOnglet counts without the moved tab: coming from above shifts the target by one.
    const position = index + (apres ? 1 : 0);
    api.agir({ type: "deplacerOnglet", id, index: ordre.indexOf(id) < position ? position - 1 : position });
  }
</script>

<ul class="onglets" role="tablist" aria-orientation="vertical">
  {#each ordre as id, index (id)}
    {@const onglet = etat.valeur?.onglets[id]}
    {@const droitsAgent = accesDe(id)}
    {#if onglet}
      <li
        data-testid="onglet-{id}"
        role="tab"
        tabindex="0"
        aria-selected={id === actif}
        aria-current={id === actif ? "page" : undefined}
        class:avant={survol?.index === index && !survol.apres}
        class:apres={survol?.index === index && survol.apres}
        draggable="true"
        ondragstart={(e) => e.dataTransfer?.setData("application/x-webaios-onglet", id)}
        ondragover={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          survol = { index, apres: e.clientY > r.top + r.height / 2 };
        }}
        ondragleave={() => (survol = null)}
        ondrop={(e) => deposer(e, index)}
        onclick={() => api.agir({ type: "activerOnglet", id })}
        onkeydown={(e) => (e.key === "Enter" || e.key === " ") && api.agir({ type: "activerOnglet", id })}
        onauxclick={(e) => e.button === 1 && fermerOnglet(id)}
        oncontextmenu={(e) =>
          ouvrirMenu(e, [
            { libelle: "Épingler", agir: () => api.agir({ type: "epinglerOnglet", id }) },
            { libelle: "Ajouter aux essentiels", agir: () => api.agir({ type: "ajouterEssentiel", id }) },
            { libelle: "Fermer", agir: () => fermerOnglet(id) },
          ])}
      >
        {#if onglet.chargement}<span class="roue" aria-label="Chargement"></span>{:else}<IconeSite favicon={onglet.favicon} titre={onglet.titre} />{/if}
        <span class="titre">{onglet.titre}</span>
        {#if droitsAgent}<PastilleAcces {id} etat={droitsAgent} />{/if}
        {#if onglet.ouvertParAgent}<span class="agent" title="Ouvert par l'agent">✦</span>{/if}
        <button
          class="fermer"
          aria-label="Fermer l'onglet"
          onclick={(e) => {
            e.stopPropagation();
            fermerOnglet(id);
          }}><Icone nom="fermer" taille={12} /></button
        >
      </li>
    {/if}
  {/each}
</ul>

<style>
  .onglets { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 8px; border-radius: 8px; color: var(--texte); cursor: default; }
  li:hover { background: var(--fond-survol); }
  li[aria-current="page"] { background: var(--fond-actif); }
  li.avant { box-shadow: inset 0 2px 0 var(--accent); }
  li.apres { box-shadow: inset 0 -2px 0 var(--accent); }
  .titre { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent { color: var(--accent); }
  .fermer { all: unset; opacity: 0; padding: 0 4px; color: var(--texte-doux); }
  li:hover .fermer { opacity: 1; }
  .roue { width: 12px; height: 12px; margin: 2px; flex: none; border: 2px solid var(--texte-doux); border-top-color: transparent; border-radius: 50%; animation: tourne 0.8s linear infinite; }
  @keyframes tourne { to { transform: rotate(360deg); } }
</style>
