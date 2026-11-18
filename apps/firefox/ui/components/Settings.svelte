<script lang="ts" module>
  import type { IconName } from "./Icon.svelte";
  import { SETTINGS_SECTIONS, type SettingsSection } from "../../shared/commands";

  // The sections' list is shared with ⌘T and the menu's « Réglages › … » (shared/commands.ts): only their icons here.
  const ICONS: Record<SettingsSection, IconName> = { general: "settings", agent: "agent", ai: "cpu", workshop: "box", shortcuts: "keyboard", privacy: "lock", data: "database", about: "info" };
  const SECTIONS = SETTINGS_SECTIONS.map((id) => ({ id, icon: ICONS[id] }));
  export { showSection } from "./settings-section.svelte";
</script>

<script lang="ts">
  import { t } from "../i18n.svelte";
  import Icon from "./Icon.svelte";
  import { currentSection, showSection } from "./settings-section.svelte";
  import SettingsGeneral from "./SettingsGeneral.svelte";
  import SettingsAgent from "./SettingsAgent.svelte";
  import SettingsLocalAi from "./SettingsLocalAi.svelte";
  import SettingsWorkshop from "./SettingsWorkshop.svelte";
  import SettingsShortcuts from "./SettingsShortcuts.svelte";
  import SettingsPrivacy from "./SettingsPrivacy.svelte";
  import SettingsData from "./SettingsData.svelte";
  import SettingsAbout from "./SettingsAbout.svelte";

  const PAGES = { general: SettingsGeneral, agent: SettingsAgent, ai: SettingsLocalAi, workshop: SettingsWorkshop, shortcuts: SettingsShortcuts, privacy: SettingsPrivacy, data: SettingsData, about: SettingsAbout };
  const Page = $derived(PAGES[currentSection()]);
</script>

<section class="settings" data-testid="settings-page" aria-label={t("settings-title")}>
  <nav aria-label={t("settings-nav-label")}>
    <h1>{t("settings-title")}</h1>
    <div class="tabs">
      {#each SECTIONS as sec (sec.id)}
        <button data-testid="settings-nav-{sec.id}" aria-current={currentSection() === sec.id ? "page" : undefined} onclick={() => showSection(sec.id)}>
          <Icon name={sec.icon} size={18} /><span>{t(`settings-section-${sec.id}`)}</span>
        </button>
      {/each}
    </div>
  </nav>

  <div class="content">
    <h2 class="visually-hidden">{t(`settings-section-${currentSection()}`)}</h2>
    <Page />
  </div>
</section>

<style>
  /* The page: icon tabs on top, then one centred column of groups. Each setting is a two-column row (SettingsRow). */
  .settings { display: flex; flex-direction: column; height: 100%; color: var(--text); font-size: 13px; }
  nav { flex: none; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 18px 16px 12px; border-bottom: 1px solid var(--border); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  h1 { margin: 0; font: 600 13px/1.2 var(--font-ui); color: var(--text-muted); }
  .tabs { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; }
  .tabs button { all: unset; display: flex; flex-direction: column; align-items: center; gap: 5px; min-width: 56px; padding: 8px 6px 7px; border-radius: 10px; color: var(--text-muted); font-size: 11.5px; font-weight: 500; cursor: default; transition: transform var(--tap), background var(--tap), color var(--tap); }
  .tabs button :global(svg) { color: var(--text-muted); transition: color var(--tap); }
  .tabs button:hover { background: var(--bg-hover); color: var(--text); }
  .tabs button:active { transform: scale(0.97); }
  .tabs button[aria-current="page"] { background: var(--glass-hi); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); color: var(--text); }
  .tabs button[aria-current="page"] :global(svg) { color: var(--accent); }
  .settings :global(:is(button, input, select, textarea):focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }

  .content { flex: 1; min-height: 0; overflow-y: auto; padding: 28px 16px 48px; container-type: inline-size; }
  .content > :global(section) { max-width: 720px; margin: 0 auto; animation: ressac-rise var(--spring-d) var(--spring) backwards; }

  /* Groups: soft, lightly filled, no heavy border; rows inside split by a hairline. */
  .settings :global(.group) { margin: 0 0 22px; border-radius: 16px; background: color-mix(in srgb, var(--sheet) 58%, transparent); box-shadow: inset 0 0 0 1px var(--glass-edge), var(--lift); overflow: hidden; }
  .settings :global(.group.credits > * + *) { border-top: 0; }
  .settings :global(.group > * + *) { border-top: 1px solid var(--border); }
  .settings :global(.group-title) { margin: 0 0 8px; padding: 0 4px; font: 600 12px/1.3 var(--font-ui); color: var(--text-muted); }
  .settings :global(.group-head) { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 0 0 8px; padding: 0 0 0 4px; }
  .settings :global(.group-head .group-title) { margin: 0; padding: 0 0 4px; }
  .settings :global(.danger-zone) { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--in-error) 28%, transparent); }
  .settings :global(.intro), .settings :global(.caption) { margin: -6px 4px 22px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
  .settings :global(.intro) { margin: 0 4px 18px; }
  .settings :global(.status) { margin: 0 4px 22px; }

  /* A setting: its name right-aligned on the left, the control and its help on the right. */
  .settings :global(.setting) { display: grid; grid-template-columns: minmax(120px, 32%) 1fr; column-gap: 24px; align-items: start; padding: 16px 20px; }
  .settings :global(.setting .name) { padding-top: 6px; text-align: right; color: var(--text-muted); font-weight: 500; overflow-wrap: anywhere; }
  .settings :global(.setting .control) { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .settings :global(.setting .line) { align-self: stretch; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 28px; max-width: 100%; }
  .settings :global(.setting .control > .confirmation) { align-self: stretch; }
  @container (max-width: 520px) {
    .settings :global(.setting) { grid-template-columns: 1fr; row-gap: 8px; }
    .settings :global(.setting .name) { padding-top: 0; text-align: left; color: var(--text); }
  }
  .settings :global(.help) { color: var(--text-muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
  .settings :global(.state) { line-height: 1.4; }

  /* A list row (models, permissions, backups, shortcuts): name and detail on the left, its state and buttons on the right. */
  .settings :global(.row) { display: flex; align-items: center; gap: 10px; padding: 12px 20px; min-height: 28px; }
  .settings :global(.grow) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .settings :global(.grow b), .settings :global(b.grow) { font-weight: 600; }
  .settings :global(.grow .muted) { font-size: 12px; }

  .settings :global(p) { margin: 0; overflow-wrap: anywhere; }
  .settings :global(.credits) { display: flex; flex-direction: column; gap: 8px; padding: 16px 20px; line-height: 1.5; }
  .settings :global(code) { font: 12px var(--font-mono); overflow-wrap: anywhere; }
  .settings :global(kbd) { display: inline-block; min-width: 14px; padding: 2px 6px; border-radius: 6px; background: var(--bg-hover); box-shadow: inset 0 0 0 1px var(--border); font: 12px var(--font-mono); text-align: center; color: var(--text-muted); }
  .settings :global(.muted) { color: var(--text-muted); }
  .settings :global(.alert) { color: var(--in-error); font-size: 12px; overflow-wrap: anywhere; }
  .settings :global(.appear) { animation: ressac-rise var(--spring-d) var(--spring) backwards; }

  /* A state: a dot of its tone and the text. */
  .settings :global(.pill) { --tone: var(--stopped); display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 9px; border-radius: 10px; background: color-mix(in srgb, var(--tone) 14%, transparent); font-size: 12px; line-height: 1.35; flex: none; }
  .settings :global(.pill::before) { content: ""; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--tone); }
  .settings :global(.pill[data-tone="ok"]) { --tone: var(--running); }
  .settings :global(.pill[data-tone="warn"]) { --tone: var(--in-progress); }
  .settings :global(.pill[data-tone="error"]) { --tone: var(--in-error); }

  /* Controls. */
  .content :global(button) { flex: none; padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  .content :global(button:hover:not(:disabled)) { background: var(--bg-active); }
  .content :global(button:active:not(:disabled)) { transform: scale(0.97); }
  .content :global(button:disabled) { opacity: 0.5; }
  .content :global(button.primary) { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .content :global(button.primary:hover:not(:disabled)) { background: color-mix(in oklab, var(--accent) 88%, var(--text)); }
  .content :global(button.danger) { color: var(--in-error); }
  .content :global(:is(select, input:not([type="radio"], [type="checkbox"]), textarea)) { box-sizing: border-box; max-width: 100%; padding: 5px 9px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-hover); color: var(--text); font: 12px var(--font-ui); }
  .content :global(textarea) { display: block; width: 100%; font-family: var(--font-mono); resize: vertical; }
  .content :global(.wide) { width: 100%; }
  .settings :global(.kinds) { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .settings :global(.kinds label) { display: inline-flex; align-items: center; gap: 6px; }
  /* macOS draws native radios in the system blue: ours, in the accent. */
  .settings :global(input[type="radio"]) { appearance: none; width: 15px; height: 15px; margin: 0; flex: none; border-radius: 50%; border: 1px solid var(--border); background: var(--glass-hi); transition: border-width var(--tap); }
  .settings :global(input[type="radio"]:checked) { border: 4.5px solid var(--accent); background: var(--accent-ink); }
  .settings :global(.switch) { appearance: none; position: relative; width: 34px; height: 20px; margin: 4px 0; flex: none; border-radius: 10px; background: var(--bg-active); transition: background var(--tap); }
  .settings :global(.switch::after) { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--on-color); box-shadow: var(--float); transition: left var(--spring-d) var(--spring); }
  .settings :global(.switch:checked) { background: var(--accent); }
  .settings :global(.switch:checked::after) { left: 16px; }
  .settings :global(.switch:disabled) { opacity: 0.5; }

  /* A confirmation, under the row that asked. */
  .settings :global(.buttons) { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .settings :global(.confirmation) { margin: 4px 0 0; padding: 14px 16px; border-radius: 12px; background: var(--bg-hover); box-shadow: inset 0 0 0 1px var(--border); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .settings :global(.confirmation p) { margin: 0 0 12px; line-height: 1.45; }
  .settings :global(.group > * > .confirmation), .settings :global(.group > .confirmation) { margin: 0 20px 14px; }
</style>
