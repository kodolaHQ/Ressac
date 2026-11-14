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
  import { fade } from "svelte/transition";
  import { t } from "../i18n.svelte";

  /**
   * Creation or settings of a space: the `spaceSettings` draft, mounted as long as it exists. `ongletId`: the page
   * shown at opening, captured for the background (null: none, or a panel hides it).
   */
  let { windowId: windowId, tabId: tabId }: { windowId: WindowId; tabId: TabId | null } = $props();
  // The draft is shared state: the fields modify it in place.
  const draft = untrack(() => spaceSettings.draft)!;

  let card: HTMLElement;
  let nameField: HTMLInputElement;
  let iconField: HTMLInputElement;
  let picker = $state<HTMLElement>();
  /** The emoji grid under the icon field is open. */
  let picking = $state(false);
  const COLUMNS = 8;
  const EMOJIS: [string, string][] = [
    ["🏠", "sidebar-emoji-home"], ["💼", "sidebar-emoji-work"], ["🎓", "sidebar-emoji-school"], ["📚", "sidebar-emoji-reading"], ["✏️", "sidebar-emoji-writing"], ["💻", "sidebar-emoji-code"], ["🧪", "sidebar-emoji-science"], ["💡", "sidebar-emoji-ideas"],
    ["🎮", "sidebar-emoji-games"], ["🎵", "sidebar-emoji-music"], ["🎬", "sidebar-emoji-movies"], ["📺", "sidebar-emoji-tv-shows"], ["📷", "sidebar-emoji-photo"], ["🎨", "sidebar-emoji-art"], ["🧶", "sidebar-emoji-crafts"], ["🎲", "sidebar-emoji-board-games"],
    ["✈️", "sidebar-emoji-travel"], ["🗺️", "sidebar-emoji-map"], ["🏖️", "sidebar-emoji-holidays"], ["🚗", "sidebar-emoji-car"], ["🛒", "sidebar-emoji-groceries"], ["🛍️", "sidebar-emoji-shopping"], ["🍳", "sidebar-emoji-cooking"], ["☕", "sidebar-emoji-coffee"],
    ["💰", "sidebar-emoji-money"], ["📈", "sidebar-emoji-stocks"], ["🏦", "sidebar-emoji-bank"], ["🧾", "sidebar-emoji-bills"], ["📅", "sidebar-emoji-calendar"], ["📌", "sidebar-emoji-projects"], ["📁", "sidebar-emoji-folder"], ["📰", "sidebar-emoji-news"],
    ["❤️", "sidebar-emoji-health"], ["🏃", "sidebar-emoji-sport"], ["🧘", "sidebar-emoji-wellbeing"], ["🌱", "sidebar-emoji-garden"], ["🐾", "sidebar-emoji-pets"], ["👪", "sidebar-emoji-family"], ["👶", "sidebar-emoji-baby"], ["🎁", "sidebar-emoji-gifts"],
    ["⚽", "sidebar-emoji-football"], ["🚀", "sidebar-emoji-side-project"], ["🔧", "sidebar-emoji-diy"], ["🏡", "sidebar-emoji-real-estate"], ["🌍", "sidebar-emoji-world"], ["⭐", "sidebar-emoji-favorites"], ["🔒", "sidebar-emoji-private"], ["🧳", "sidebar-emoji-commuting"],
  ];
  function pick(emoji: string) {
    draft.icon = emoji;
    picking = false;
    iconField.focus();
    iconField.select();
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
    if (picking && e.target instanceof Node && e.target !== iconField && !picker?.contains(e.target)) picking = false;
  }
  let ready = $state(false);

  const spaces = $derived(appState.value?.spaces ?? []);
  const options = $derived(profileOptions(spaces, appState.value?.profiles ?? [], draft.id, appState.value?.locale ?? "fr"));
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
      if (picking) {
        picking = false;
        iconField.focus();
      } else close();
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

<svelte:window onkeydown={clavier} onpointerdown={outside} onfocusin={outside} />

<!-- Under the command bar, nothing in the modal can take focus (native Tab from the page body). -->
<div class="modal" class:ready={ready} data-testid="space-modal" inert={!!command.open} style={Object.entries(auraVariables(draft.aura)).map(([k, v]) => `${k}:${v}`).join(";")}>
  <FrozenBackground tabId={tabId} onReady={() => (ready = true)} />
  <div class="card" bind:this={card} role="dialog" aria-modal="true" aria-labelledby="space-title">
    <form onsubmit={validate}>
      <h2 id="space-title">{t(fresh ? "sidebar-space-new" : "sidebar-space-settings-title")}</h2>
      <div class="field">
        <div class="icon-pick">
          <!-- Typing any emoji replaces the current one (selected on focus); the grid offers common ones. -->
          <input
            class="icon"
            bind:this={iconField}
            bind:value={draft.icon}
            aria-label={t("sidebar-space-icon")}
            maxlength="4"
            aria-haspopup="true"
            aria-expanded={picking}
            aria-controls="space-emojis"
            onfocus={(e) => e.currentTarget.select()}
            onclick={(e) => {
              // Selected on click too: the release would otherwise drop the selection made on focus.
              e.currentTarget.select();
              picking = true;
            }}
            oninput={() => (picking = false)}
            onkeydown={(e) => {
              if (e.key !== "ArrowDown") return;
              e.preventDefault();
              picking = true;
              requestAnimationFrame(() => picker?.querySelector("button")?.focus());
            }}
          />
          {#if picking}
            <div class="emojis" id="space-emojis" role="group" aria-label={t("sidebar-space-icons")} data-testid="emoji-grid" bind:this={picker} out:fade={{ duration: 120 }}>
              {#each EMOJIS as [emoji, id] (emoji)}
                <button type="button" aria-label={t(id)} title={t(id)} aria-pressed={draft.icon === emoji} onkeydown={gridKeys} onclick={() => pick(emoji)}>{emoji}</button>
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
      </div>
      {#if !fresh}
        <div class="block" data-testid="space-extensions">
          <span class="label">{t("sidebar-space-extensions")}</span>
          {#if profileChanged}
            <p class="note">{t("sidebar-space-extensions-save-first")}</p>
          {:else if lines && lines.length === 0}
            <p class="note">{t("sidebar-space-extensions-none")}</p>
          {:else if lines}
            {#each lines as l (l.key)}
              <div class="extension" data-testid="extension-row" data-key={l.key}>
                <label class="case">
                  <input type="checkbox" role="switch" checked={l.active} disabled={l.greyedOut !== null} onchange={(e) => void toggle(l, e.currentTarget)} />
                  <b>{l.name}</b>
                  <span class="source">{l.source === "agent" ? t("sidebar-space-extension-agent") : "addons.mozilla.org"}</span>
                </label>
                {#if l.active && l.alsoIn.length > 0}<p class="note">{t("sidebar-space-extension-also", { spaces: l.alsoIn.join(", ") })}</p>{/if}
                {#if l.greyedOut}<p class="note">{l.greyedOut}</p>{/if}
              </div>
            {/each}
          {/if}
          {#if extensionError}<p class="note alert" role="alert" data-testid="extension-error">{extensionError}</p>{/if}
          {#if draft.private && warned.sharedPrivate.length > 0}
            <p class="note" data-testid="private-extensions-warning">
              {t("sidebar-space-private-shared", { spaces: warned.sharedPrivate.join(", ") })}
            </p>
          {/if}
          {#if warned.agentDisabled.length > 0}
            <p class="note alert" data-testid="extensions-disabled">{t("sidebar-space-extensions-disabled", { names: warned.agentDisabled.join(", ") })}</p>
          {/if}
        </div>
      {/if}
      <div class="actions">
        <button type="button" onclick={close}>{t("sidebar-cancel")}</button>
        <button type="submit" class="main" disabled={!valid}>{t(fresh ? "sidebar-create" : "sidebar-save")}</button>
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
  /* Wide enough for any emoji (a variation selector widens some): never clipped. */
  .field .icon { flex: none; width: 44px; padding: 0; text-align: center; font-size: 18px; cursor: pointer; }
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
  .emojis button { width: 32px; height: 32px; padding: 0; border: none; border-radius: 8px; background: none; font: 18px/1 var(--font-ui); display: grid; place-items: center; }
  .emojis button:hover:not(:disabled) { background: var(--glass-hi); }
  .emojis button:active:not(:disabled) { transform: scale(0.9); }
  .emojis button[aria-pressed="true"] { background: var(--bg-active); box-shadow: inset 0 0 0 1px var(--accent); }
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
