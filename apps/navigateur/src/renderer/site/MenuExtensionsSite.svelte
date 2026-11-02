<script lang="ts">
  import Icone from "../composants/Icone.svelte";
  import { HAUTEUR_BARRE_SITE, PANNEAU_EXTENSIONS_MAX } from "../../commun/sites";
  import { AUCUNE_EXTENSION_SITE, DOMAINES_CHANGES_EXTENSION, GERER_EXTENSIONS, VOIT_LES_PAGES_SITE } from "../../commun/extensions-messages";
  import type { LigneExtensionSite } from "../../commun/extensions";
  import type { ApiSite } from "../../commun/api";

  // Le menu « Extensions » de l'appli : les extensions du Store, activées pour cette appli seulement. Le panneau s'ouvre
  // sous la barre (elle coupe ce qui dépasse) et repousse la vue du site d'autant (sa hauteur, envoyée au process
  // principal), car la vue couvrirait tout ce que l'interface poserait par-dessus. Noms et messages en texte, jamais en HTML.
  let { api }: { api: ApiSite } = $props();
  let ouvert = $state(false);
  let lignes = $state<LigneExtensionSite[] | null>(null);
  /** L'état voulu par les clics en attente de réponse (C5 : jusqu'à 10 s à l'activation) ; le dernier clic l'emporte. */
  let voulus = $state<Record<string, boolean>>({});
  /** Le nombre de demandes en attente par extension. */
  let enCours = $state<Record<string, number>>({});
  let erreur = $state<string | null>(null);
  let panneau = $state<HTMLElement | null>(null);
  let lecture = 0;

  async function relire() {
    const n = ++lecture;
    const l = await api.extensions.liste().catch(() => null);
    if (l && n === lecture) lignes = l;
  }

  function ouvrir() {
    erreur = null;
    ouvert = true;
    void relire();
  }
  function fermer() {
    ouvert = false;
  }

  async function basculer(l: LigneExtensionSite) {
    const actif = !(voulus[l.cle] ?? l.active);
    voulus[l.cle] = actif;
    enCours[l.cle] = (enCours[l.cle] ?? 0) + 1;
    erreur = null;
    const r = await api.extensions.basculer(l.cle, actif).catch((e: unknown) => ({ ok: false as const, erreur: e instanceof Error ? e.message : String(e) }));
    if (!r.ok) erreur = r.erreur;
    const reste = (enCours[l.cle] ?? 1) - 1;
    enCours[l.cle] = reste;
    if (reste > 0) return;
    // Plus rien en attente : l'état lu au process principal remplace celui des clics.
    await relire();
    if (!enCours[l.cle]) {
      delete enCours[l.cle];
      delete voulus[l.cle];
    }
  }

  // La liste est relue à chaque changement des extensions (menu ouvert).
  $effect(() =>
    api.extensions.surChange(() => {
      if (ouvert) void relire();
    }),
  );

  // La hauteur du panneau, à l'ouverture et à chaque changement de taille ; 0 à la fermeture.
  $effect(() => {
    const el = panneau;
    if (!ouvert || !el) {
      api.extensions.panneau(0);
      return;
    }
    const envoyer = () => api.extensions.panneau(Math.min(PANNEAU_EXTENSIONS_MAX, Math.ceil(el.getBoundingClientRect().height)));
    envoyer();
    const suivi = new ResizeObserver(envoyer);
    suivi.observe(el);
    return () => suivi.disconnect();
  });
  $effect(() => () => api.extensions.panneau(0));
</script>

<svelte:window onkeydown={(e) => ouvert && e.key === "Escape" && fermer()} />

<button
  class="menu"
  data-testid="site-extensions"
  aria-label="Extensions"
  title="Extensions"
  aria-expanded={ouvert}
  onclick={() => (ouvert ? fermer() : ouvrir())}><Icone nom="extensions" /></button
>
{#if ouvert}
  <!-- position: fixed, sous la barre : le header coupe ce qui dépasse. no-drag : rien de ce panneau ne déplace la fenêtre. -->
  <div class="panneau" data-testid="panneau-extensions-site" role="region" aria-label="Extensions" bind:this={panneau} style:top="{HAUTEUR_BARRE_SITE}px" style:max-height="{PANNEAU_EXTENSIONS_MAX}px">
    {#if lignes !== null && lignes.length === 0}
      <p class="vide">{AUCUNE_EXTENSION_SITE}</p>
    {/if}
    {#if lignes && lignes.length > 0}
      <ul>
        {#each lignes as l (l.cle)}
          {@const coche = voulus[l.cle] ?? l.active}
          {@const attente = (enCours[l.cle] ?? 0) > 0}
          <li data-testid="ligne-extension-site">
            <div class="haut">
              <span class="nom">{l.nom}</span>
              <button
                class="interrupteur"
                data-testid="interrupteur-extension-site"
                role="switch"
                aria-checked={coche}
                aria-busy={attente}
                aria-label={l.nom}
                disabled={l.indisponible !== null}
                onclick={() => void basculer(l)}><span class="curseur"></span></button
              >
            </div>
            <p class="note" class:attention={l.indisponible !== null || (l.domainesChanges && !coche)}>
              {#if l.indisponible !== null}{l.indisponible}{:else if l.domainesChanges && !coche}{DOMAINES_CHANGES_EXTENSION}{:else}{VOIT_LES_PAGES_SITE}{/if}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
    {#if erreur}<p class="erreur" role="alert" data-testid="erreur-extension-site">{erreur}</p>{/if}
    <button
      class="gerer"
      data-testid="site-gerer-extensions"
      onclick={() => {
        fermer();
        api.extensions.gerer();
      }}>{GERER_EXTENSIONS}</button
    >
  </div>
{/if}

<style>
  .menu { all: unset; flex: none; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--texte-doux); -webkit-app-region: no-drag; }
  .menu:hover, .menu[aria-expanded="true"] { background: var(--fond-survol); color: var(--texte); }
  .panneau {
    position: fixed; right: 8px; z-index: 10; width: min(340px, calc(100vw - 16px)); box-sizing: border-box; overflow: auto;
    padding: 6px; border: 1px solid var(--bord); border-top: none; border-radius: 0 0 8px 8px; background: var(--fond-barre); color: var(--texte);
    -webkit-app-region: no-drag; user-select: none;
  }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 4px 6px; border-radius: 6px; }
  .haut { display: flex; align-items: center; gap: 8px; }
  .nom { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .note { margin: 2px 0 0; color: var(--texte-doux); font-size: 11px; }
  .note.attention { color: var(--en-cours); }
  .vide { margin: 4px 6px; color: var(--texte-doux); font-size: 12px; }
  .erreur { margin: 4px 6px; color: var(--en-erreur); font-size: 12px; }
  .interrupteur { all: unset; flex: none; position: relative; width: 30px; height: 17px; border-radius: 9px; background: var(--fond-actif); -webkit-app-region: no-drag; }
  .interrupteur[aria-checked="true"] { background: var(--accent); }
  .interrupteur:disabled { opacity: 0.4; }
  .interrupteur[aria-busy="true"] { opacity: 0.6; cursor: progress; }
  .curseur { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: var(--texte); transition: left 0.12s; }
  .interrupteur[aria-checked="true"] .curseur { left: 15px; background: #fff; }
  .gerer { all: unset; display: block; margin-top: 4px; padding: 3px 6px; border-radius: 5px; color: var(--texte-doux); font-size: 12px; -webkit-app-region: no-drag; }
  .gerer:hover { background: var(--fond-survol); color: var(--texte); }
  .menu:focus-visible, .interrupteur:focus-visible, .gerer:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
