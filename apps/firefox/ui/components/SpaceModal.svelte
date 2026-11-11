<script lang="ts">
  import { AURA_IDS, AURAS, auraVariables } from "../../shared/aura";
  import AuraDot from "./AuraDot.svelte";
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
   * Creation or settings of a space: the `spaceSettings` draft, mounted as long as it exists. `ongletId`: the page
   * shown at opening, captured for the background (null: none, or a panel hides it).
   */
  let { windowId: windowId, tabId: tabId }: { windowId: WindowId; tabId: TabId | null } = $props();
  // The draft is shared state: the fields modify it in place.
  const draft = untrack(() => spaceSettings.draft)!;

  let card: HTMLElement;
  let nameField: HTMLInputElement;
  let ready = $state(false);

  const spaces = $derived(appState.value?.spaces ?? []);
  const options = $derived(profileOptions(spaces, appState.value?.profiles ?? [], draft.id));
  const fresh = $derived(draft.id === null);
  const valid = $derived(draft.name.trim() !== "" && draft.profile !== PROFILE_TO_CHOOSE);
  const losesConnections = $derived(choiceLosesConnections(spaces, draft.id, draft.profile));

  // Extensions: the rows seen from the space's saved profile (an existing space only).
  let lines = $state<SpaceExtensionLine[] | null>(null);
  let extensionError = $state<string | null>(null);
  const saved = $derived(spaces.find((e) => e.id === draft.id));
  const profileChanged = $derived(!!saved && draft.profile !== saved.profile);
  const linesKey = $derived(saved ? `${saved.id}|${saved.profile}|${saved.private}|${spaces.map((e) => `${e.name}:${e.profile}`).join(",")}` : "");
  const warned = $derived(
    lines && !fresh
      ? warnings({ id: draft.id, private: draft.private, profile: draft.profile }, spaces, lines)
      : { sharedPrivate: [], agentDisabled: [] },
  );
  async function loadLines() {
    if (draft.id !== null) lines = await api.extensions.forSpace(draft.id);
  }
  $effect(() => {
    void linesKey;
    void loadLines();
  });
  async function toggle(l: SpaceExtensionLine, field: HTMLInputElement) {
    if (draft.id === null) return;
    extensionError = null;
    const r = await api.extensions.toggle(l.key, draft.id, field.checked);
    if (!r.ok) extensionError = r.error;
    await loadLines();
    // The switch takes back what the registry says (card refused, error).
    const view = lines?.find((x) => x.key === l.key);
    if (view && field.isConnected) field.checked = view.active;
  }

  // The choice no longer designates any profile (the state changed meanwhile): a new space goes back to « à choisir »,
  // an existing space to the first one offered.
  $effect(() => {
    if (draft.profile === PROFILE_TO_CHOOSE || options.some((o) => o.value === draft.profile)) return;
    draft.profile = fresh ? PROFILE_TO_CHOOSE : options[0]!.value;
  });
  // The space being set was deleted (from another window): nothing left to set.
  $effect(() => {
    if (draft.id !== null && !spaces.some((e) => e.id === draft.id)) close();
  });

  onMount(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameField.focus();
    const endChange = api.extensions.onChange(() => void loadLines());
    return () => {
      endChange();
      // Focus goes back where it was, if it is still in the interface, when the rest is no longer inert.
      queueMicrotask(() => {
        if (before?.isConnected && before !== document.body) before.focus();
      });
    };
  });

  function close() {
    spaceSettings.draft = null;
  }

  function validate(e?: SubmitEvent) {
    e?.preventDefault();
    if (!valid) return;
    const name = draft.name.trim();
    const icon = draft.icon.trim() || "📁";
    const { id, private: isPrivate, profile: profile, aura } = draft;
    if (id === null) api.dispatch({ type: "createSpace", name: name, icon: icon, private: isPrivate, profile: profile, aura, windowId: windowId });
    else api.dispatch({ type: "updateSpace", id, name: name, icon: icon, private: isPrivate, profile: profile, aura });
    close();
  }

  const focusables = () =>
    [...card.querySelectorAll<HTMLElement>("button, input, select")].filter((e) => !e.hasAttribute("disabled"));

  // The web page does not have keyboard focus (the preview hands it back to the interface): Enter validates right away.
  function clavier(e: KeyboardEvent) {
    // The command bar opened on top keeps the keyboard: the hidden modal reacts to nothing, even if focus has left the
    // bar's field (neither Enter, nor Escape before the ⌃Tab panel takes over, nor Tab).
    if (command.open || e.isComposing) return;
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
<div class="modal" class:ready={ready} data-testid="space-modal" inert={!!command.open} style={Object.entries(auraVariables(draft.aura)).map(([k, v]) => `${k}:${v}`).join(";")}>
  <FrozenBackground tabId={tabId} onReady={() => (ready = true)} />
  <div class="card" bind:this={card} role="dialog" aria-modal="true" aria-labelledby="space-title">
    <form onsubmit={validate}>
      <h2 id="space-title">{fresh ? "Nouvel espace" : "Réglages de l'espace"}</h2>
      <div class="field">
        <input class="icon" bind:value={draft.icon} aria-label="Icône" maxlength="4" />
        <input bind:this={nameField} bind:value={draft.name} aria-label="Nom de l'espace" placeholder="Nom" />
      </div>
      <div class="block">
        <span class="label" id="aura-label">Aura</span>
        <div class="auras" role="radiogroup" aria-labelledby="aura-label">
          {#each AURA_IDS as id (id)}
            <button type="button" class="aura" role="radio" aria-checked={draft.aura === id} aria-label="Aura {AURAS[id].name}" title={AURAS[id].name} onclick={() => (draft.aura = id)}>
              <AuraDot aura={id} size={18} />
            </button>
          {/each}
        </div>
      </div>
      <div class="block">
        <label class="case"><input type="checkbox" bind:checked={draft.private} aria-describedby="private-note" /> <b>Espace privé</b></label>
        <p class="note" id="private-note">L'agent ne voit pas ces onglets, ne lit rien, n'a pas les outils de développement, et rien n'est retenu dans sa mémoire.</p>
      </div>
      <div class="block">
        <label class="label" for="space-profile">Profil de connexion</label>
        <select id="space-profile" bind:value={draft.profile} aria-describedby="profile-note">
          {#if fresh}<option value={PROFILE_TO_CHOOSE} disabled>Choisir un profil…</option>{/if}
          {#each options as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </select>
        <p class="note" id="profile-note">
          Cookies, comptes connectés, autorisations des sites. Changer de profil : les onglets de l'espace se rechargent, tu devras peut-être te reconnecter.
        </p>
        {#if losesConnections}<p class="note alert" role="alert" data-testid="connections-lost">Les connexions de cet espace seront perdues.</p>{/if}
      </div>
      {#if !fresh}
        <div class="block" data-testid="space-extensions">
          <span class="label">Extensions</span>
          {#if profileChanged}
            <p class="note">Enregistre d'abord le changement de profil pour régler ses extensions.</p>
          {:else if lines && lines.length === 0}
            <p class="note">Aucune extension installée.</p>
          {:else if lines}
            {#each lines as l (l.key)}
              <div class="extension" data-testid="extension-row" data-key={l.key}>
                <label class="case">
                  <input type="checkbox" role="switch" checked={l.active} disabled={l.greyedOut !== null} onchange={(e) => void toggle(l, e.currentTarget)} />
                  <b>{l.name}</b>
                  <span class="source">{l.source === "agent" ? "écrite par l'agent" : "Chrome Web Store"}</span>
                </label>
                {#if l.active && l.alsoIn.length > 0}<p class="note">Active aussi dans « {l.alsoIn.join(", ")} » (même profil)</p>{/if}
                {#if l.greyedOut}<p class="note">{l.greyedOut}</p>{/if}
              </div>
            {/each}
          {/if}
          {#if extensionError}<p class="note alert" role="alert" data-testid="extension-error">{extensionError}</p>{/if}
          {#if draft.private && warned.sharedPrivate.length > 0}
            <p class="note" data-testid="private-extensions-warning">
              Cet espace privé partage son profil avec « {warned.sharedPrivate.join(", ")} » : les extensions actives dans ce profil tournent aussi ici. Pour qu'elles n'y tournent jamais, donne-lui son propre profil.
            </p>
          {/if}
          {#if warned.agentDisabled.length > 0}
            <p class="note alert" data-testid="extensions-disabled">En enregistrant, ces extensions de l'agent seront désactivées pour ce profil : {warned.agentDisabled.join(", ")}. Les onglets ouverts où elles tournent seront rechargés.</p>
          {/if}
        </div>
      {/if}
      <div class="actions">
        <button type="button" onclick={close}>Annuler</button>
        <button type="submit" class="main" disabled={!valid}>{fresh ? "Créer" : "Enregistrer"}</button>
      </div>
    </form>
  </div>
</div>

<style>
  .modal { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; -webkit-app-region: no-drag; }
  .card {
    position: relative;
    width: min(400px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 18px 20px;
    /* Over the live page (no blur reaches it): dense glass, the aura's light washing its top. */
    background: radial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--a1) 20%, transparent), transparent 60%), radial-gradient(110% 80% at 100% 0%, color-mix(in oklab, var(--a2) 14%, transparent), transparent 55%), var(--glass-dense);
    backdrop-filter: blur(30px) saturate(1.8);
    color: var(--text);
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    box-shadow: var(--modal-shadow);
    font-size: 13px;
    line-height: 1.45;
    opacity: 0;
    transform: translateY(-10px) scale(0.96);
    transition: opacity 200ms var(--out), transform var(--spring-d) var(--spring);
  }
  .ready .card { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .card { transition: opacity 150ms ease-out; transform: none; }
  }
  form { display: flex; flex-direction: column; gap: 10px; margin: 0; }
  h2 { margin: 0 0 2px; font: 600 18px/1.2 var(--font-display); letter-spacing: -0.01em; }
  .field { display: flex; gap: 6px; }
  input:not([type="checkbox"]), select {
    min-width: 0;
    padding: 7px 9px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--glass-hi);
    color: var(--text);
    font: inherit;
  }
  .field input { flex: 1; }
  .field .icon { flex: none; width: 2.5em; text-align: center; }
  select { width: 100%; }
  .block { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 10px; }
  .case { display: flex; align-items: center; gap: 6px; }
  .label { font-size: 11.5px; color: var(--text-muted); }
  .note { margin: 0; font-size: 11.5px; color: var(--text-muted); }
  .extension { display: flex; flex-direction: column; gap: 2px; }
  .source { font-size: 11px; color: var(--text-muted); }
  .alert { color: var(--text); font-weight: 600; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .auras { display: flex; gap: 8px; }
  .auras .aura { padding: 3px; border-radius: 50%; border: 2px solid transparent; background: none; line-height: 0; transition: transform var(--tap), border-color var(--tap); }
  .auras .aura:hover:not(:disabled) { background: none; }
  .auras .aura :global(*) { transition: transform var(--spring-d) var(--spring); }
  .auras .aura:hover :global(*) { transform: scale(1.12); }
  .auras .aura[aria-checked="true"] { border-color: var(--accent); }
  .auras .aura[aria-checked="true"] :global(*) { transform: scale(1.2); }
  .main { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .main:hover:not(:disabled) { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
</style>
