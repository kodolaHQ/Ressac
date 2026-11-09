<script lang="ts">
  import { command } from "./command.svelte";
  import { onMount, untrack } from "svelte";
  import type { SpaceExtensionLine } from "../../shared/extensions";
  import type { WindowId, TabId } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { warnings } from "./spaceExtensions";
  import FrozenBackground from "./FrozenBackground.svelte";
  import { choiceLosesConnections, profileOptions, PROFILE_TO_CHOOSE } from "./spaceProfiles";
  import { spaceSettings } from "./spaceSettings.svelte";

  /**
   * Creation or settings of a space: the `reglagesEspace` draft, mounted as long as it exists. `ongletId`: the page
   * shown at opening, captured for the background (null: none, or a panel hides it).
   */
  let { fenetreId: windowId, ongletId: tabId }: { fenetreId: WindowId; ongletId: TabId | null } = $props();
  // The draft is shared state: the fields modify it in place.
  const draft = untrack(() => spaceSettings.brouillon)!;

  let carte: HTMLElement;
  let nameField: HTMLInputElement;
  let ready = $state(false);

  const spaces = $derived(appState.valeur?.espaces ?? []);
  const options = $derived(profileOptions(spaces, appState.valeur?.profils ?? [], draft.id));
  const fresh = $derived(draft.id === null);
  const valid = $derived(draft.nom.trim() !== "" && draft.profil !== PROFILE_TO_CHOOSE);
  const losesConnections = $derived(choiceLosesConnections(spaces, draft.id, draft.profil));

  // Extensions: the rows seen from the space's saved profile (an existing space only).
  let lignes = $state<SpaceExtensionLine[] | null>(null);
  let extensionError = $state<string | null>(null);
  const saved = $derived(spaces.find((e) => e.id === draft.id));
  const profileChanged = $derived(!!saved && draft.profil !== saved.profil);
  const linesKey = $derived(saved ? `${saved.id}|${saved.profil}|${saved.prive}|${spaces.map((e) => `${e.nom}:${e.profil}`).join(",")}` : "");
  const warned = $derived(
    lignes && !fresh
      ? warnings({ id: draft.id, prive: draft.prive, profil: draft.profil }, spaces, lignes)
      : { privePartage: [], agentDesactivees: [] },
  );
  async function chargerLignes() {
    if (draft.id !== null) lignes = await api.extensions.pourEspace(draft.id);
  }
  $effect(() => {
    void linesKey;
    void chargerLignes();
  });
  async function toggle(l: SpaceExtensionLine, champ: HTMLInputElement) {
    if (draft.id === null) return;
    extensionError = null;
    const r = await api.extensions.basculer(l.cle, draft.id, champ.checked);
    if (!r.ok) extensionError = r.erreur;
    await chargerLignes();
    // The switch takes back what the registry says (card refused, error).
    const view = lignes?.find((x) => x.cle === l.cle);
    if (view && champ.isConnected) champ.checked = view.active;
  }

  // The choice no longer designates any profile (the state changed meanwhile): a new space goes back to « à choisir »,
  // an existing space to the first one offered.
  $effect(() => {
    if (draft.profil === PROFILE_TO_CHOOSE || options.some((o) => o.valeur === draft.profil)) return;
    draft.profil = fresh ? PROFILE_TO_CHOOSE : options[0]!.valeur;
  });
  // The space being set was deleted (from another window): nothing left to set.
  $effect(() => {
    if (draft.id !== null && !spaces.some((e) => e.id === draft.id)) close();
  });

  onMount(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameField.focus();
    const finChange = api.extensions.surChange(() => void chargerLignes());
    return () => {
      finChange();
      // Focus goes back where it was, if it is still in the interface, when the rest is no longer inert.
      queueMicrotask(() => {
        if (before?.isConnected && before !== document.body) before.focus();
      });
    };
  });

  function close() {
    spaceSettings.brouillon = null;
  }

  function validate(e?: SubmitEvent) {
    e?.preventDefault();
    if (!valid) return;
    const name = draft.nom.trim();
    const icon = draft.icone.trim() || "📁";
    const { id, prive: isPrivate, profil: profile } = draft;
    if (id === null) api.agir({ type: "creerEspace", nom: name, icone: icon, prive: isPrivate, profil: profile, fenetreId: windowId });
    else api.agir({ type: "reglerEspace", id, nom: name, icone: icon, prive: isPrivate, profil: profile });
    close();
  }

  const focusables = () =>
    [...carte.querySelectorAll<HTMLElement>("button, input, select")].filter((e) => !e.hasAttribute("disabled"));

  // The web page does not have keyboard focus (the preview hands it back to the interface): Enter validates right away.
  function clavier(e: KeyboardEvent) {
    // The command bar opened on top keeps the keyboard: the hidden modal reacts to nothing, even if focus has left the
    // bar's field (neither Enter, nor Escape before the ⌃Tab panel takes over, nor Tab).
    if (command.ouverte || e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      // A focused button keeps its own action; everywhere else, Enter saves.
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      e.preventDefault();
      if (!e.repeat) validate();
    } else if (e.key === "Tab") {
      // Focus does not leave the modal: Tab loops over its controls.
      const list = focusables();
      if (list.length === 0) return e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const target = e.shiftKey ? (i <= 0 ? list.at(-1) : null) : i === -1 || i === list.length - 1 ? list[0] : null;
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
  }
</script>

<svelte:window onkeydown={clavier} />

<!-- Under the command bar, nothing in the modal can take focus (native Tab from the page body). -->
<div class="modale" class:prete={ready} data-testid="modale-espace" inert={!!command.ouverte}>
  <FrozenBackground ongletId={tabId} surPret={() => (ready = true)} />
  <div class="carte" bind:this={carte} role="dialog" aria-modal="true" aria-labelledby="titre-espace">
    <form onsubmit={validate}>
      <h2 id="titre-espace">{fresh ? "Nouvel espace" : "Réglages de l'espace"}</h2>
      <div class="champ">
        <input class="icone" bind:value={draft.icone} aria-label="Icône" maxlength="4" />
        <input bind:this={nameField} bind:value={draft.nom} aria-label="Nom de l'espace" placeholder="Nom" />
      </div>
      <div class="bloc">
        <label class="case"><input type="checkbox" bind:checked={draft.prive} aria-describedby="note-prive" /> <b>Espace privé</b></label>
        <p class="note" id="note-prive">L'agent ne voit pas ces onglets, ne lit rien, n'a pas les outils de développement, et rien n'est retenu dans sa mémoire.</p>
      </div>
      <div class="bloc">
        <label class="libelle" for="profil-espace">Profil de connexion</label>
        <select id="profil-espace" bind:value={draft.profil} aria-describedby="note-profil">
          {#if fresh}<option value={PROFILE_TO_CHOOSE} disabled>Choisir un profil…</option>{/if}
          {#each options as o (o.valeur)}
            <option value={o.valeur}>{o.libelle}</option>
          {/each}
        </select>
        <p class="note" id="note-profil">
          Cookies, comptes connectés, autorisations des sites. Changer de profil : les onglets de l'espace se rechargent, tu devras peut-être te reconnecter.
        </p>
        {#if losesConnections}<p class="note alerte" role="alert" data-testid="perte-connexions">Les connexions de cet espace seront perdues.</p>{/if}
      </div>
      {#if !fresh}
        <div class="bloc" data-testid="extensions-espace">
          <span class="libelle">Extensions</span>
          {#if profileChanged}
            <p class="note">Enregistre d'abord le changement de profil pour régler ses extensions.</p>
          {:else if lignes && lignes.length === 0}
            <p class="note">Aucune extension installée.</p>
          {:else if lignes}
            {#each lignes as l (l.cle)}
              <div class="extension" data-testid="extension-ligne" data-cle={l.cle}>
                <label class="case">
                  <input type="checkbox" role="switch" checked={l.active} disabled={l.grisee !== null} onchange={(e) => void toggle(l, e.currentTarget)} />
                  <b>{l.nom}</b>
                  <span class="source">{l.source === "agent" ? "écrite par l'agent" : "Chrome Web Store"}</span>
                </label>
                {#if l.active && l.aussiDans.length > 0}<p class="note">Active aussi dans « {l.aussiDans.join(", ")} » (même profil)</p>{/if}
                {#if l.grisee}<p class="note">{l.grisee}</p>{/if}
              </div>
            {/each}
          {/if}
          {#if extensionError}<p class="note alerte" role="alert" data-testid="erreur-extension">{extensionError}</p>{/if}
          {#if draft.prive && warned.privePartage.length > 0}
            <p class="note" data-testid="avertissement-extensions-prive">
              Cet espace privé partage son profil avec « {warned.privePartage.join(", ")} » : les extensions actives dans ce profil tournent aussi ici. Pour qu'elles n'y tournent jamais, donne-lui son propre profil.
            </p>
          {/if}
          {#if warned.agentDesactivees.length > 0}
            <p class="note alerte" data-testid="extensions-desactivees">En enregistrant, ces extensions de l'agent seront désactivées pour ce profil : {warned.agentDesactivees.join(", ")}. Les onglets ouverts où elles tournent seront rechargés.</p>
          {/if}
        </div>
      {/if}
      <div class="actions">
        <button type="button" onclick={close}>Annuler</button>
        <button type="submit" class="principal" disabled={!valid}>{fresh ? "Créer" : "Enregistrer"}</button>
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
  .extension { display: flex; flex-direction: column; gap: 2px; }
  .source { font-size: 11px; color: var(--texte-doux); }
  .alerte { color: var(--texte); font-weight: 600; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  button:disabled { opacity: 0.5; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .principal { background: var(--accent); border-color: var(--accent); color: white; }
</style>
