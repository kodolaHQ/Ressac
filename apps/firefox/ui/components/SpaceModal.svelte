<script lang="ts">
  import { AURA_IDS, AURAS, auraVariables } from "../../shared/aura";
  import AuraDot from "./AuraDot.svelte";
  import { command } from "./command.svelte";
  import { onMount, untrack } from "svelte";
  import type { WindowId, TabId } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import FrozenBackground from "./FrozenBackground.svelte";
  import { choiceLosesConnections, profileOptions, PROFILE_TO_CHOOSE } from "./spaceProfiles";
  import { removePassport, spaceSettings } from "./spaceSettings.svelte";
  import { fade } from "svelte/transition";
  import { t } from "../i18n.svelte";
  import AuraEmoji from "./AuraEmoji.svelte";
  import Icon from "./Icon.svelte";
  import { SPACE_ICONS } from "./spaceIcons";

  /**
   * Creation or settings of a space: the `spaceSettings` draft, mounted as long as it exists. `ongletId`: the page
   * shown at opening, captured for the background (null: none, or a panel hides it).
   */
  let { windowId, tabId }: { windowId: WindowId; tabId: TabId | null } = $props();
  // The draft is shared state: the fields modify it in place.
  const draft = untrack(() => spaceSettings.draft)!;

  let card: HTMLElement;
  let nameField: HTMLInputElement;
  let iconField: HTMLButtonElement;
  let picker = $state<HTMLElement>();
  /** The emoji grid under the icon field is open. */
  let picking = $state(false);
  const COLUMNS = 8;
  function pick(emoji: string) {
    draft.icon = emoji;
    picking = false;
    iconField.focus();
  }
  /** Arrows move across the grid (row-wise), Home / End to its ends; ↑ from the first row goes back to the field. */
  function gridKeys(e: KeyboardEvent) {
    const buttons = [...picker!.querySelectorAll("button")];
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[e.key];
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : step === undefined ? null : i + step;
    if (next === null) return;
    e.preventDefault();
    if (next < 0 && e.key === "ArrowUp") iconField.focus();
    else buttons[Math.max(0, Math.min(buttons.length - 1, next))]!.focus();
  }
  /** A click or focus anywhere outside the field and its grid closes the grid. */
  function outside(e: Event) {
    if (picking && e.target instanceof Node && !iconField.contains(e.target) && !picker?.contains(e.target)) picking = false;
  }
  let ready = $state(false);

  const spaces = $derived(appState.value?.spaces ?? []);
  const options = $derived(profileOptions(spaces, appState.value?.profiles ?? [], draft.id, appState.value?.locale ?? "fr"));
  const fresh = $derived(draft.id === null);
  const valid = $derived(draft.name.trim() !== "" && draft.profile !== PROFILE_TO_CHOOSE);
  const saved = $derived(spaces.find((e) => e.id === draft.id));
  /** The entries of the saved profile's passport, lost with it when the space leaves it (design § 4.4). */
  let passportCount = $state(0);
  $effect(() => {
    const profile = saved?.profile;
    if (!profile) return;
    void api.settings.passport
      ?.profiles()
      .then((all) => (passportCount = all.find((p) => p.id === profile)?.count ?? 0))
      .catch(() => {});
  });
  const losesConnections = $derived(choiceLosesConnections(spaces, draft.id, draft.profile, passportCount));
  /** « Supprimer aussi son passeport »: unticked, the passport is kept (design § 4.4). */
  let dropPassport = $state(false);
  /** A drop that failed (nothing changed), or one done for a change the state then refused. */
  let failure = $state<"failed" | "space-kept" | null>(null);
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
    return () => {
      // Focus goes back where it was, if it is still in the interface, when the rest is no longer inert.
      queueMicrotask(() => {
        if (before?.isConnected && before !== document.body) before.focus();
      });
    };
  });

  function close() {
    spaceSettings.draft = null;
  }

  /** A drop pending: the modal takes no other press, nor Escape. */
  let saving = $state(false);
  async function validate(e?: SubmitEvent) {
    e?.preventDefault();
    if (!valid || saving) return;
    const name = draft.name.trim();
    const icon = draft.icon.trim() || "📁";
    const { id, private: isPrivate, profile, aura } = draft;
    // The passport goes first: a failed drop keeps the space as it was and says so.
    if (saved && losesConnections?.passport && dropPassport) {
      saving = true;
      const ok = await removePassport(saved.profile).finally(() => (saving = false));
      // Closed meanwhile (the space deleted from another window), or Touch ID refused: nothing done.
      if (spaceSettings.draft !== draft || ok === null) return;
      if (!ok) return void (failure = "failed");
      passportCount = 0;
      // The reducer's refusals (core/state/actions.ts updateSpace): the space gone, or its chosen profile gone.
      if (!spaces.some((e) => e.id === id) || (profile !== "new" && !appState.value?.profiles.some((p) => p.id === profile))) return void (failure = "space-kept");
    }
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
      if (saving) return;
      if (picking) {
        picking = false;
        iconField.focus();
      } else close();
    } else if (e.key === "Enter") {
      // A focused button keeps its own action; everywhere else, Enter saves.
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      e.preventDefault();
      if (!e.repeat) void validate();
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

<svelte:window onkeydown={clavier} onpointerdown={outside} onfocusin={outside} />

<!-- Under the command bar, nothing in the modal can take focus (native Tab from the page body). -->
<div class="modal" class:ready={ready} data-testid="space-modal" inert={!!command.open} style={Object.entries(auraVariables(draft.aura)).map(([k, v]) => `${k}:${v}`).join(";")}>
  <FrozenBackground tabId={tabId} onReady={() => (ready = true)} />
  <div class="card" bind:this={card} role="dialog" aria-modal="true" aria-labelledby="space-title">
    <form onsubmit={validate}>
      <h2 id="space-title">{t(fresh ? "sidebar-space-new" : "sidebar-space-settings-title")}</h2>
      <div class="field">
        <div class="icon-pick">
          <button
            type="button"
            class="icon"
            bind:this={iconField}
            value={draft.icon}
            aria-label={t("sidebar-space-icon")}
            title={t(SPACE_ICONS.find(([e]) => e === draft.icon)?.[1] ?? "sidebar-space-icon")}
            aria-haspopup="true"
            aria-expanded={picking}
            aria-controls="space-emojis"
            onclick={() => (picking = !picking)}
            onkeydown={(e) => {
              if (e.key !== "ArrowDown") return;
              e.preventDefault();
              picking = true;
              requestAnimationFrame(() => picker?.querySelector("button")?.focus());
            }}><AuraEmoji icon={draft.icon} aura={draft.aura} /></button
          >
          {#if picking}
            <div class="emojis" id="space-emojis" role="group" aria-label={t("sidebar-space-icons")} data-testid="emoji-grid" bind:this={picker} out:fade={{ duration: 120 }}>
              {#each SPACE_ICONS as [emoji, id, icon] (emoji)}
                <button type="button" aria-label={t(id)} title={t(id)} aria-pressed={draft.icon === emoji} onkeydown={gridKeys} onclick={() => pick(emoji)}><Icon name={icon} size={18} /></button>
              {/each}
            </div>
          {/if}
        </div>
        <input bind:this={nameField} bind:value={draft.name} aria-label={t("sidebar-space-name")} placeholder={t("sidebar-space-name-placeholder")} />
      </div>
      <div class="block">
        <span class="label" id="aura-label">{t("sidebar-space-aura")}</span>
        <div class="auras" role="radiogroup" aria-labelledby="aura-label">
          {#each AURA_IDS as id (id)}
            <button type="button" class="aura" role="radio" aria-checked={draft.aura === id} aria-label={t("sidebar-space-aura-named", { name: AURAS[id].name })} title={AURAS[id].name} onclick={() => (draft.aura = id)}>
              <AuraDot aura={id} size={18} />
            </button>
          {/each}
        </div>
      </div>
      <div class="block">
        <label class="case"><input type="checkbox" bind:checked={draft.private} aria-describedby="private-note" /> <b>{t("sidebar-space-private-label")}</b></label>
        <p class="note" id="private-note">{t("sidebar-space-private-note")}</p>
      </div>
      <div class="block">
        <label class="label" for="space-profile">{t("sidebar-space-profile")}</label>
        <select id="space-profile" bind:value={draft.profile} aria-describedby="profile-note">
          {#if fresh}<option value={PROFILE_TO_CHOOSE} disabled>{t("sidebar-space-profile-choose")}</option>{/if}
          {#each options as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </select>
        <p class="note" id="profile-note">
          {t("sidebar-space-profile-note")}
        </p>
        {#if losesConnections}<p class="note alert" role="alert" data-testid="connections-lost">{t("sidebar-space-delete-logins")}</p>{/if}
        {#if losesConnections?.passport}
          <div class="rise" out:fade={{ duration: 120 }}>
            <p class="note alert" data-testid="passport-lost">{t("sidebar-space-passport-count", { count: losesConnections.passport })}</p>
            <label class="case"><input type="checkbox" data-testid="space-modal-drop-passport" disabled={saving} bind:checked={dropPassport} /> {t("sidebar-space-passport-drop")}</label>
          </div>
        {/if}
        {#if failure}<p class="note alert rise" role="alert" data-testid="space-modal-drop-failed" out:fade={{ duration: 120 }}>{t(failure === "failed" ? "sidebar-space-passport-drop-failed" : "sidebar-space-passport-dropped-only")}</p>{/if}
      </div>
      <div class="actions">
        <button type="button" disabled={saving} onclick={close}>{t("sidebar-cancel")}</button>
        <button type="submit" class="main" disabled={!valid || saving}>{t(fresh ? "sidebar-create" : "sidebar-save")}</button>
      </div>
    </form>
  </div>
</div>

<style>
  /* The accent follows the previewed aura (its accents are set inline), not the active space's. */
  .modal { --accent: var(--aura-accent-dark); position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; -webkit-app-region: no-drag; }
  @media (prefers-color-scheme: light) { .modal { --accent: var(--aura-accent-light); } }
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
  .icon-pick { position: relative; flex: none; display: flex; }
  .field .icon { flex: none; width: 44px; display: grid; place-items: center; padding: 0; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font-size: 18px; cursor: pointer; }
  /* The emoji grid: a popover dropping under the field on the spring. */
  .emojis {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 1;
    display: grid;
    grid-template-columns: repeat(8, 32px);
    gap: 2px;
    padding: 6px;
    /* Opaque: a backdrop blur does not reach through the card's own (backdrop root), the fields would show through. */
    background: var(--sheet);
    border: 1px solid var(--glass-edge);
    border-radius: 14px;
    box-shadow: var(--modal-shadow);
    /* A short drop without overshoot: the spring's bounce made the 48 emojis judder at its end. */
    animation: emojis-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
  }
  @keyframes emojis-in { from { opacity: 0; transform: translateY(-4px); } }
  @media (prefers-reduced-motion: reduce) {
    @keyframes emojis-in { from { opacity: 0; } }
  }
  .emojis button { width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px; background: none; color: var(--text); display: grid; place-items: center; }
  .emojis button:hover:not(:disabled) { background: var(--glass-hi); }
  .emojis button:active:not(:disabled) { transform: scale(0.9); }
  .emojis button[aria-pressed="true"] { background: var(--bg-active); box-shadow: inset 0 0 0 1px var(--accent); }
  select { width: 100%; }
  .block { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 10px; }
  .case { display: flex; align-items: center; gap: 6px; }
  .label { font-size: 11.5px; color: var(--text-muted); }
  .note { margin: 0; font-size: 11.5px; color: var(--text-muted); }
  .alert { color: var(--text); font-weight: 600; }
  .rise { display: flex; flex-direction: column; gap: 6px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
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
