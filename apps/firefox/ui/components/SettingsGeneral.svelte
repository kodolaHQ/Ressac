<script lang="ts">
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import { LOCALES, languageName } from "../../shared/i18n";
  import { SEARCH_ENGINES, customEngineError, type SearchEngine } from "../../shared/search";
  import { APPEARANCES } from "../../shared/model";
  import SettingsRow from "./SettingsRow.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  const settings = $derived(appState.value?.settings);
  let languageChanged = $state(false);

  let isDefault = $state<boolean | null>(null);
  /** Set by « Définir par défaut »: macOS asks in its own dialog, so the answer is awaited. */
  let askedDefault = $state(false);
  const loadDefault = () => s.defaultBrowser().then((d) => (isDefault = d));
  $effect(() => void loadDefault());
  $effect(() => {
    if (!askedDefault || isDefault) return;
    const t = setInterval(() => void loadDefault(), 1_000);
    return () => clearInterval(t);
  });

  // « Autre… » shows its field before any valid address: the engine only changes once the address is accepted.
  let customOpen = $state(false);
  let engineError = $state<string | null>(null);
  const shownEngine = $derived<SearchEngine>(customOpen ? "custom" : (settings?.engine ?? "google"));
  function pickEngine(engine: SearchEngine) {
    engineError = null;
    const kept = settings?.customEngine;
    customOpen = engine === "custom" && (!kept || !!customEngineError(kept));
    if (!customOpen) api.dispatch({ type: "chooseEngine", engine });
  }
  function saveCustomEngine(url: string) {
    engineError = customEngineError(url);
    if (engineError) return;
    customOpen = false;
    api.dispatch({ type: "chooseEngine", engine: "custom", custom: url.trim() });
  }
  const focusField = (node: HTMLInputElement) => {
    if (customOpen) node.focus();
  };
</script>

{#snippet toggle(id: string, testid: string, checked: boolean, set: (on: boolean) => void)}
  <input {id} class="switch" type="checkbox" role="switch" data-testid={testid} aria-describedby="{id}-help" {checked} onchange={(e) => set(e.currentTarget.checked)} />
{/snippet}

<section data-testid="settings-general" aria-label={t("settings-section-general")}>
  <div class="group">
    <SettingsRow label={t("settings-language-label")} id="settings-language">
      <select id="settings-language" data-testid="settings-language" value={settings?.language ?? "system"} onchange={(e) => { languageChanged = true; api.dispatch({ type: "chooseLanguage", language: e.currentTarget.value }); }}>
        <option value="system">{settings?.language === "system" && appState.value ? t("settings-language-system-named", { name: languageName(appState.value.locale) }) : t("settings-language-system")}</option>
        {#each LOCALES as code (code)}<option value={code}>{languageName(code)}</option>{/each}
      </select>
      {#snippet below()}
        {#if languageChanged && appState.value}
          <span class="help appear" data-testid="settings-language-note">{t("settings-language-agent-note", { language: new Intl.DisplayNames([appState.value.locale], { type: "language" }).of(appState.value.locale) ?? appState.value.locale })}</span>
        {/if}
      {/snippet}
    </SettingsRow>
    <SettingsRow label={t("settings-appearance-label")} labelId="appearance-label">
      <div role="radiogroup" aria-labelledby="appearance-label" class="kinds">
        {#each APPEARANCES as appearance (appearance)}
          <label>
            <input type="radio" name="appearance" data-testid="settings-appearance-{appearance}" checked={(settings?.appearance ?? "system") === appearance} onchange={() => api.dispatch({ type: "chooseAppearance", appearance })} />{t(`settings-appearance-${appearance}`)}
          </label>
        {/each}
      </div>
    </SettingsRow>
    <SettingsRow label={t("settings-aura-motion-label")} id="aura-motion-switch" help={t("settings-aura-motion-help")}>
      {@render toggle("aura-motion-switch", "settings-aura-motion", settings?.auraMotion ?? true, (enabled) => api.dispatch({ type: "setAuraMotion", enabled }))}
    </SettingsRow>
    <SettingsRow label={t("settings-sidebar-label")} labelId="sidebar-side-label">
      <div role="radiogroup" aria-labelledby="sidebar-side-label" class="kinds">
        {#each [["left", "settings-sidebar-left"], ["right", "settings-sidebar-right"]] as const as [side, name]}
          <label>
            <input type="radio" name="sidebar-side" data-testid="settings-sidebar-{side}" checked={(settings?.sidebarSide ?? "left") === side} onchange={() => api.dispatch({ type: "setSidebarSide", side })} />{t(name)}
          </label>
        {/each}
      </div>
    </SettingsRow>
  </div>

  <div class="group">
    <SettingsRow label={t("settings-save-memory-label")} id="save-memory-switch" help={t("settings-save-memory-help")}>
      {@render toggle("save-memory-switch", "settings-save-memory", settings?.saveMemory ?? false, (enabled) => api.dispatch({ type: "setSaveMemory", enabled }))}
    </SettingsRow>
  </div>

  <div class="group">
    <SettingsRow label={t("settings-start-home-label")} id="start-home-switch" help={t("settings-start-home-help")}>
      {@render toggle("start-home-switch", "settings-start-home", settings?.startOnHome ?? true, (enabled) => api.dispatch({ type: "setStartOnHome", enabled }))}
    </SettingsRow>
    <SettingsRow label={t("settings-hints-label")} id="hints-switch" help={t("settings-hints-help")}>
      {@render toggle("hints-switch", "settings-hints", settings?.hints.enabled ?? true, (enabled) => api.dispatch({ type: "setHintsEnabled", enabled }))}
    </SettingsRow>
  </div>

  <div class="group">
    <SettingsRow label={t("settings-engine-label")} id="settings-engine" help={t("settings-engine-help")} testid="settings-search">
      <select id="settings-engine" data-testid="settings-engine" aria-describedby="settings-engine-help" value={shownEngine} onchange={(e) => pickEngine(e.currentTarget.value as SearchEngine)}>
        {#each Object.entries(SEARCH_ENGINES) as [id, e] (id)}<option value={id}>{e.label}</option>{/each}
        <option value="custom">{t("settings-engine-other")}</option>
      </select>
    </SettingsRow>
    {#if shownEngine === "custom"}
      <div class="appear">
        <SettingsRow label={t("settings-engine-custom-label")} id="settings-engine-custom">
          <input
            id="settings-engine-custom"
            class="wide"
            data-testid="settings-engine-custom"
            placeholder="https://kagi.com/search?q=%s"
            spellcheck="false"
            value={settings?.customEngine ?? ""}
            use:focusField
            onchange={(e) => saveCustomEngine(e.currentTarget.value)}
            onkeydown={(e) => e.key === "Enter" && saveCustomEngine(e.currentTarget.value)}
          />
          {#snippet below()}
            {#if engineError}<span class="alert appear" data-testid="settings-engine-error">{t(engineError)}</span>{/if}
          {/snippet}
        </SettingsRow>
      </div>
    {/if}
    <SettingsRow label={t("settings-default-browser-label")} help={t("settings-default-browser-help")} testid="settings-default-browser">
      {#if isDefault}
        <span class="pill" data-tone="ok" data-testid="default-browser-state">{t("settings-default-browser-is")}</span>
      {:else if isDefault === false}
        <button data-testid="default-browser-set" onclick={() => (s.setDefaultBrowser(), (askedDefault = true))}>{t("settings-default-browser-set")}</button>
      {/if}
    </SettingsRow>
  </div>
</section>
