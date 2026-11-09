<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../etat.svelte";
  import { depotDe, estCleAction } from "./cible";
  import { FichierCode } from "./codes.svelte";
  import { creerEdition } from "./edition.svelte";

  /**
   * The `.mjs` file of a `code` block. Nothing is written on typing (the running widget would read half-written code):
   * « Enregistrer le code » or ⌘S writes it. The code never runs here, it is only text.
   */
  /** `widget`: the workflow's key (`cleCible`), a widget's or an action's. */
  let { widget, nom }: { widget: string; nom: string } = $props();
  const depot = depotDe(api.workflow);

  // svelte-ignore state_referenced_locally
  // Once saved, the code may unblock the workflow refused for lack of this file (same edit as the builder).
  const fichier = new FichierCode(widget, nom, depot, (n) => creerEdition(widget, depot).codeEnregistre(n));

  $effect(() =>
    untrack(() => {
      void fichier.lire();
      // The agent may be writing the file: re-read on each change of home (or of the actions).
      return (estCleAction(widget) ? api.actions.surChange : api.accueil.surChange)(() => void fichier.lire());
    }),
  );

  /** ⌘S: saves the code (no menu: the page has no « Enregistrer » of its own), except when typed in the agent's terminal. */
  function touche(e: KeyboardEvent): void {
    if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.key.toLowerCase() !== "s") return;
    if (e.target instanceof Element && e.target.closest(".xterm")) return;
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
