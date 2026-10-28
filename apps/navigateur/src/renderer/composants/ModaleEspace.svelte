<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { IdFenetre, IdOnglet } from "../../commun/modele";
  import { api, etat } from "../etat.svelte";
  import FondFige from "./FondFige.svelte";
  import { choixPerdConnexions, optionsProfil } from "./profilsEspace";
  import { reglagesEspace } from "./reglagesEspace.svelte";

  /**
   * Création ou réglages d'un espace : le brouillon de `reglagesEspace`, montée tant qu'il existe. `ongletId` : la page
   * affichée à l'ouverture, capturée pour le fond (null : aucune, ou un panneau la cache).
   */
  let { fenetreId, ongletId }: { fenetreId: IdFenetre; ongletId: IdOnglet | null } = $props();
  // Le brouillon est un état partagé : les champs le modifient en place.
  const brouillon = untrack(() => reglagesEspace.brouillon)!;

  let carte: HTMLElement;
  let champNom: HTMLInputElement;
  let prete = $state(false);

  const espaces = $derived(etat.valeur?.espaces ?? []);
  const options = $derived(optionsProfil(espaces, etat.valeur?.profils ?? [], brouillon.id));
  const nouveau = $derived(brouillon.id === null);
  const valide = $derived(brouillon.nom.trim() !== "");
  const perdConnexions = $derived(choixPerdConnexions(espaces, brouillon.id, brouillon.profil));

  // Le choix ne désigne plus aucun profil (l'état a changé entre-temps) : on revient au premier proposé.
  $effect(() => {
    if (!options.some((o) => o.valeur === brouillon.profil)) brouillon.profil = options[0]!.valeur;
  });
  // L'espace réglé a été supprimé (depuis une autre fenêtre) : plus rien à régler.
  $effect(() => {
    if (brouillon.id !== null && !espaces.some((e) => e.id === brouillon.id)) fermer();
  });

  onMount(() => {
    const avant = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    champNom.focus();
    return () => {
      // Le focus revient où il était, s'il est encore dans l'interface, quand le reste n'est plus inerte.
      queueMicrotask(() => {
        if (avant?.isConnected && avant !== document.body) avant.focus();
      });
    };
  });

  function fermer() {
    reglagesEspace.brouillon = null;
  }

  function valider(e?: SubmitEvent) {
    e?.preventDefault();
    if (!valide) return;
    const nom = brouillon.nom.trim();
    const icone = brouillon.icone.trim() || "📁";
    const { id, prive, profil } = brouillon;
    if (id === null) api.agir({ type: "creerEspace", nom, icone, prive, profil, fenetreId });
    else api.agir({ type: "reglerEspace", id, nom, icone, prive, profil });
    fermer();
  }

  const focusables = () =>
    [...carte.querySelectorAll<HTMLElement>("button, input, select")].filter((e) => !e.hasAttribute("disabled"));

  // La page web n'a pas le focus clavier (l'aperçu le rend à l'interface) : Entrée vaut tout de suite validation.
  function clavier(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      fermer();
    } else if (e.key === "Enter") {
      // Un bouton qui a le focus garde sa propre action ; partout ailleurs, Entrée enregistre.
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      e.preventDefault();
      if (!e.repeat) valider();
    } else if (e.key === "Tab") {
      // Le focus ne quitte pas la modale : Tab boucle sur ses commandes.
      const liste = focusables();
      if (liste.length === 0) return e.preventDefault();
      const i = liste.indexOf(document.activeElement as HTMLElement);
      const cible = e.shiftKey ? (i <= 0 ? liste.at(-1) : null) : i === -1 || i === liste.length - 1 ? liste[0] : null;
      if (cible) {
        e.preventDefault();
        cible.focus();
      }
    }
  }
</script>

<svelte:window onkeydown={clavier} />

<div class="modale" class:prete data-testid="modale-espace">
  <FondFige {ongletId} surPret={() => (prete = true)} />
  <div class="carte" bind:this={carte} role="dialog" aria-modal="true" aria-labelledby="titre-espace">
    <form onsubmit={valider}>
      <h2 id="titre-espace">{nouveau ? "Nouvel espace" : "Réglages de l'espace"}</h2>
      <div class="champ">
        <input class="icone" bind:value={brouillon.icone} aria-label="Icône" maxlength="4" />
        <input bind:this={champNom} bind:value={brouillon.nom} aria-label="Nom de l'espace" placeholder="Nom" />
      </div>
      <div class="bloc">
        <label class="case"><input type="checkbox" bind:checked={brouillon.prive} aria-describedby="note-prive" /> <b>Espace privé</b></label>
        <p class="note" id="note-prive">L'agent ne voit pas ces onglets, ne lit rien, n'a pas les outils de développement, et rien n'est retenu dans sa mémoire.</p>
      </div>
      <div class="bloc">
        <label class="libelle" for="profil-espace">Profil de connexion</label>
        <select id="profil-espace" bind:value={brouillon.profil} aria-describedby="note-profil">
          {#each options as o (o.valeur)}
            <option value={o.valeur}>{o.libelle}</option>
          {/each}
        </select>
        <p class="note" id="note-profil">
          Cookies, comptes connectés, autorisations des sites. Changer de profil : les onglets de l'espace se rechargent, tu devras peut-être te reconnecter.
        </p>
        {#if perdConnexions}<p class="note alerte" role="alert" data-testid="perte-connexions">Les connexions de cet espace seront perdues.</p>{/if}
      </div>
      <div class="actions">
        <button type="button" onclick={fermer}>Annuler</button>
        <button type="submit" class="principal" disabled={!valide}>{nouveau ? "Créer" : "Enregistrer"}</button>
      </div>
    </form>
  </div>
</div>

<style>
  .modale { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; -webkit-app-region: no-drag; }
  .carte {
    position: relative;
    width: min(400px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 16px 18px;
    background: var(--fond-actif);
    color: var(--texte);
    border: 1px solid var(--bord);
    border-radius: 12px;
    box-shadow: var(--ombre-modale);
    font-size: 13px;
    line-height: 1.45;
    opacity: 0;
    transform: translateY(6px) scale(0.98);
    transition: opacity 120ms ease-out, transform 120ms ease-out;
  }
  .prete .carte { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .carte { transition: none; transform: none; }
  }
  form { display: flex; flex-direction: column; gap: 10px; margin: 0; }
  h2 { margin: 0; font-size: 15px; }
  .champ { display: flex; gap: 6px; }
  input:not([type="checkbox"]), select {
    min-width: 0;
    padding: 5px 7px;
    border-radius: 6px;
    border: 1px solid var(--bord);
    background: var(--fond);
    color: var(--texte);
    font: inherit;
  }
  .champ input { flex: 1; }
  .champ .icone { flex: none; width: 2.5em; text-align: center; }
  select { width: 100%; }
  .bloc { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--bord); padding-top: 10px; }
  .case { display: flex; align-items: center; gap: 6px; }
  .libelle { font-size: 11.5px; color: var(--texte-doux); }
  .note { margin: 0; font-size: 11.5px; color: var(--texte-doux); }
  .alerte { color: var(--texte); font-weight: 600; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  button:disabled { opacity: 0.5; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .principal { background: var(--accent); border-color: var(--accent); color: white; }
</style>
