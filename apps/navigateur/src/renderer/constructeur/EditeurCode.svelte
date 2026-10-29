<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../etat.svelte";
  import { FichierCode } from "./codes.svelte";

  /**
   * Le fichier `.mjs` d'un bloc `code`. Rien n'est écrit à la frappe (le widget en marche lirait un code à moitié écrit) :
   * « Enregistrer le code » ou ⌘S l'écrit. Le code ne s'exécute jamais ici, il n'est que du texte.
   */
  let { widget, nom }: { widget: string; nom: string } = $props();

  // svelte-ignore state_referenced_locally
  const fichier = new FichierCode(widget, nom, api.workflow);

  $effect(() =>
    untrack(() => {
      void fichier.lire();
      // L'agent écrit peut-être le fichier : relu à chaque changement de l'accueil.
      return api.accueil.surChange(() => void fichier.lire());
    }),
  );

  /** ⌘S : enregistre le code (sans menu : la page n'a pas de « Enregistrer » à elle). */
  function touche(e: KeyboardEvent): void {
    if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
    e.preventDefault();
    void fichier.enregistrer();
  }
</script>

<svelte:window onkeydown={touche} />

<section class="code">
  <div class="tete">
    <span class="titre">Code <code>{nom}</code></span>
    {#if fichier.nonEnregistre}<span class="non-enregistre" data-testid="code-non-enregistre">Code non enregistré</span>{/if}
    <button data-testid="enregistrer-code" disabled={!fichier.nonEnregistre || fichier.enregistrement || fichier.disque === undefined} onclick={() => fichier.enregistrer()}
      >Enregistrer le code</button
    >
  </div>
  {#if fichier.changeSurDisque}
    <div class="bandeau" role="status" data-testid="code-change">
      <span>Le fichier a changé sur le disque</span>
      <button data-testid="recharger-code" onclick={() => fichier.recharger()}>Recharger</button>
      <button data-testid="garder-code" onclick={() => fichier.garderLeMien()}>Garder le mien</button>
    </div>
  {/if}
  {#if fichier.erreur}<p class="erreur" data-testid="erreur-code">{fichier.erreur}</p>{/if}
  <textarea
    data-testid="editeur-code"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    wrap="off"
    disabled={fichier.disque === undefined}
    value={fichier.texte}
    oninput={(e) => fichier.saisir(e.currentTarget.value)}
  ></textarea>
</section>

<style>
  .code { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
  .tete { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .titre { flex: 1; color: var(--texte-doux); }
  .non-enregistre { color: var(--en-cours); }
  button { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  button:disabled { opacity: 0.5; }
  .bandeau { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; background: var(--fond-actif); font-size: 12px; }
  .bandeau span { flex: 1; }
  .erreur { margin: 0; color: var(--en-erreur); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  textarea {
    box-sizing: border-box; width: 100%; min-height: 220px; resize: vertical; padding: 8px; border-radius: 6px;
    border: 1px solid var(--bord); background: var(--fond); color: var(--texte); tab-size: 2;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.45;
  }
</style>
