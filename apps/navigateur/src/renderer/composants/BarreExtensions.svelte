<script lang="ts">
  import type { BarreExtensions } from "../../commun/extensions";
  import type { EtatFenetre } from "../../commun/modele";
  import { api } from "../etat.svelte";

  // Les boutons des extensions chargées dans le profil de l'espace actif : `<button is="browser-action">` de la
  // bibliothèque (injectBrowserAction, preload de l'interface), qui en tire l'icône (crx:), le titre, le badge et la popup.
  let { fenetre }: { fenetre: EtatFenetre } = $props();
  let barre = $state<BarreExtensions>({ partition: "", onglet: null, actions: [] });
  let ouvert = $state(false);
  /** Change à chaque nouvel état des boutons (titre, icône, badge) : les boutons sont recréés et se relisent. */
  let version = $state(0);
  let requete = 0;

  async function charger() {
    const n = ++requete;
    const r = await api.extensions.barre();
    // Un bouton seul ne lit pas l'état de la bibliothèque (seule sa liste le fait) : il est lu ici, avant de les poser.
    // Sans extension chargée, la bibliothèque n'a peut-être encore équipé aucune session (pas de canal à appeler).
    if (r.partition && r.actions.length > 0) await window.browserAction?.getState(r.partition).catch(() => undefined);
    if (n !== requete) return;
    barre = r;
    version++;
  }

  // La bibliothèque prévient des changements (titre, badge, icône posés par l'extension) de la partition observée.
  // Un seul écouteur pour la vie de la barre (une fonction passée au monde isolé n'est pas sûrement retrouvée au retrait).
  let ecoute = false;
  $effect(() => {
    const p = barre.partition;
    const ba = window.browserAction;
    if (!p || !ba || barre.actions.length === 0) return;
    if (!ecoute) {
      ecoute = true;
      ba.addEventListener("update", () => version++);
    }
    ba.addObserver(p);
    return () => ba.removeObserver(p);
  });

  $effect(() => {
    // Relue quand l'espace actif (son profil) ou l'onglet affiché changent, et à chaque changement des extensions.
    void fenetre.espaceActif;
    void fenetre.actif[fenetre.espaceActif];
    void charger();
  });
  $effect(() => api.extensions.surChange(() => void charger()));

  const epinglees = $derived(barre.actions.filter((a) => a.epinglee));
  const rangees = $derived(barre.actions.filter((a) => !a.epinglee));
</script>

{#snippet bouton(a: BarreExtensions["actions"][number])}
  <!-- svelte-ignore attribute_avoid_is -->
  <button
    is="browser-action"
    class="action"
    id={a.idChrome}
    partition={barre.partition}
    tab={barre.onglet ?? -1}
    data-testid="action-extension"
    data-cle={a.cle}
    aria-label={a.nom}
  ></button>
{/snippet}

<div class="extensions" data-testid="barre-extensions">
  {#key version}{#each epinglees as a (a.cle)}{@render bouton(a)}{/each}{/key}
  <button
      class="menu"
      data-testid="menu-extensions"
      aria-label="Extensions"
      title="Extensions"
      aria-expanded={ouvert}
      onclick={() => (ouvert = !ouvert)}>⧉</button
    >
</div>
{#if ouvert}
  <!-- Dans la barre latérale, jamais au-dessus de la page (une vue d'onglet couvrirait le panneau). -->
  <div class="panneau" data-testid="panneau-extensions" role="region" aria-label="Extensions">
    {#if barre.actions.length === 0}<p class="vide">Aucune extension active dans cet espace.</p>{/if}
    <ul>
      {#key version}{#each rangees as a (a.cle)}
        <li data-testid="ligne-barre-extension">
          {@render bouton(a)}
          <span class="nom">{a.nom}</span>
          <button class="lien" onclick={() => void api.extensions.epingler(a.cle, true)}>Épingler</button>
        </li>
      {/each}{/key}
      {#each epinglees as a (a.cle)}
        <li data-testid="ligne-barre-extension">
          <span class="nom">{a.nom}</span>
          <button class="lien" onclick={() => void api.extensions.epingler(a.cle, false)}>Détacher</button>
        </li>
      {/each}
    </ul>
    <button
      class="gerer"
      onclick={() => {
        ouvert = false;
        api.agir({ type: "ouvrirExtensions", fenetreId: fenetre.id });
      }}>Gérer les extensions</button
    >
  </div>
{/if}

<style>
  .extensions { display: flex; align-items: center; gap: 2px; flex: none; -webkit-app-region: no-drag; }
  .action { all: unset; position: relative; width: 24px; height: 24px; flex: none; border-radius: 5px; background-position: center; background-repeat: no-repeat; background-size: 16px; }
  .action:hover, .menu:hover { background-color: var(--fond-survol); }
  /* Sans icône : la première lettre du titre (data-letter, posé par la bibliothèque). */
  :global(.action.no-icon)::after { content: attr(data-letter); position: absolute; inset: 4px; display: grid; place-content: center; border-radius: 4px; background: var(--fond-actif); color: var(--texte); font-size: 10px; text-transform: uppercase; }
  :global(.action .badge) { position: absolute; right: 0; bottom: 0; padding: 0 2px; border-radius: 2px; font-size: 9px; line-height: 12px; pointer-events: none; }
  .menu { all: unset; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); font-size: 18px; }
  /* min-width: 0 : sans lui, un nom long (nowrap) élargirait le panneau, élément flexible de la ligne, hors de la barre. */
  /* no-drag : le panneau est dans la zone de glissement de la barre latérale, qui avalerait ses clics (macOS). */
  .panneau { -webkit-app-region: no-drag; flex-basis: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; margin-top: 6px; padding: 4px; border: 1px solid var(--bord); border-radius: 8px; background: var(--fond-actif); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 6px; padding: 2px 4px; }
  .nom { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--texte); }
  .lien, .gerer { all: unset; padding: 2px 6px; border-radius: 5px; color: var(--texte-doux); font-size: 12px; }
  /* Après « all: unset » : le bouton garde son texte entier, c'est le nom qui cède. */
  .lien { flex: none; white-space: nowrap; }
  .lien:hover, .gerer:hover { background: var(--fond-survol); color: var(--texte); }
  .gerer { display: block; margin-top: 2px; }
  .vide { margin: 4px; color: var(--texte-doux); font-size: 12px; }
</style>
