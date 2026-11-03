<script lang="ts">
  // Electron's App.svelte, reduced to step 2: sidebar, spaces, empty page, command bar. Web pages are Firefox's <browser>, under
  // this transparent iframe; the iframe covers the whole window only when the UI shows more than its column.
  import { untrack } from "svelte";
  import BarreCommande from "../../navigateur/src/renderer/composants/BarreCommande.svelte";
  import BarreLaterale from "../../navigateur/src/renderer/composants/BarreLaterale.svelte";
  import FondFige from "../../navigateur/src/renderer/composants/FondFige.svelte";
  import MenuContextuel from "../../navigateur/src/renderer/composants/MenuContextuel.svelte";
  import ModaleEspace from "../../navigateur/src/renderer/composants/ModaleEspace.svelte";
  import PageVide from "../../navigateur/src/renderer/composants/PageVide.svelte";
  import { commande, focusPageVide, ouvrirCommande } from "../../navigateur/src/renderer/composants/commande.svelte";
  import { menu } from "../../navigateur/src/renderer/composants/menu.svelte";
  import { reglagesEspace } from "../../navigateur/src/renderer/composants/reglagesEspace.svelte";
  import { api, etat, fenetreCourante, fermerOnglet } from "../../navigateur/src/renderer/etat.svelte";
  import { aUneVue } from "../../navigateur/src/commun/modele";
  import InternalPage from "./InternalPage.svelte";

  const win = window.parent.webaiosWindow!;

  const fenetre = $derived(fenetreCourante());
  const ongletActif = $derived.by(() => {
    const id = fenetre?.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });
  const pageWeb = $derived(!!ongletActif && aUneVue(ongletActif.url));
  // The command bar targets the tab active when it opened: if another one shows, it closes.
  const idActif = $derived(ongletActif?.id);
  $effect(() => {
    void idActif;
    untrack(() => (commande.ouverte = null));
  });
  $effect(() =>
    api.surRaccourci((r) => {
      if (r === "fermerOnglet") {
        if (ongletActif) fermerOnglet(ongletActif.id);
      } else if (r === "commande") ouvrirCommande("nouveau");
      else if (r === "adresse") {
        if (ongletActif) ouvrirCommande("actif", ongletActif.url);
        else ouvrirCommande("nouveau");
      }
    }),
  );
  $effect(() => win.setFullWindow(!pageWeb || !!reglagesEspace.brouillon || !!menu.ouvert || !!commande.ouverte));
</script>

<!-- A tab switch to the parking tab blurs the field the empty page had just focused; the controller then focuses this
     iframe again (TabSwitchDone), and the empty page takes the keyboard back. -->
<svelte:window onfocus={() => document.activeElement === document.body && focusPageVide.n++} />

<div class="fenetre" inert={!!reglagesEspace.brouillon || !!commande.ouverte}>
  {#if fenetre}
    <BarreLaterale {fenetre} />
  {:else}
    <aside data-testid="barre-laterale"></aside>
  {/if}
  <main class="contenu" class:opaque={!pageWeb}>
    {#if fenetre && !ongletActif}
      <PageVide {fenetre} />
    {:else if ongletActif && !pageWeb}
      <InternalPage />
    {/if}
  </main>
</div>
<MenuContextuel />
{#if reglagesEspace.brouillon && fenetre}
  <!-- No page capture under the modal in step 2: the web page shows through the veil. -->
  <ModaleEspace fenetreId={fenetre.id} ongletId={null} />
{/if}
{#if commande.ouverte && fenetre}
  <div class="couche-commande">
    <FondFige ongletId={ongletActif?.id ?? null} surPret={() => {}} />
    <BarreCommande {fenetre} {ongletActif} cede={false} fermerPanneau={() => {}} />
  </div>
{/if}

<style>
  /* Transparent so the web page under the iframe shows; the sidebar and the content area paint their own. */
  :global(html, body) { background: transparent; }
  .couche-commande { position: fixed; inset: 0; z-index: 100; }
  .fenetre {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100%;
  }
  .contenu { min-width: 0; min-height: 0; }
  .opaque { background: var(--fond); }
</style>
