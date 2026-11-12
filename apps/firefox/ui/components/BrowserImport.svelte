<script lang="ts">
  import { fade } from "svelte/transition";
  import type { ImportProgress, ImportSource, ImportSourceId, ImportType } from "../../shared/api";
  import { api } from "../state.svelte";

  /**
   * Import from another browser on this Mac: welcome page 2 and Réglages › Données. The run goes on in the host;
   * `sources` is bound so the welcome can drop « Plus tard » when nothing is found. No source is preselected: a
   * browser's profiles (its account names) are read only once the person picks it.
   */
  let { sources = $bindable() }: { sources?: ImportSource[] } = $props();

  const LABELS: Record<ImportType, string> = { bookmarks: "Favoris", history: "Historique", passwords: "Mots de passe", spaces: "Espaces et onglets épinglés", tabs: "Onglets ouverts" };
  const bi = api.browserImport;

  let chosen = $state<ImportSourceId | null>(null);
  let profile = $state<string | null>(null);
  let profiles = $state<{ id: string; name: string }[]>([]);
  let unchecked = $state<ImportType[]>([]);
  /** This screen launched the run or saw it running: it shows its status, then what failed. */
  let watching = $state(false);
  let progress = $state<ImportProgress | null>(null);
  let refusal = $state<string | null>(null);
  let csv = $state<string | null>(null);

  const source = $derived(sources?.find((s) => s.id === chosen));
  const types = $derived(source?.types.filter((t) => !(t === "passwords" && source.passwordsByCsv)) ?? []);
  const failures = $derived(progress?.done ? (Object.entries(progress.failed) as [ImportType, string][]) : []);
  const diskAccess = $derived(progress?.source === "safari" && failures.some(([, why]) => why.includes("Accès complet au disque")));

  function choose(s: ImportSource) {
    [chosen, profile, profiles, unchecked] = [s.id, null, [], []];
    // null until read: the host then takes the last used profile.
    void bi.profiles(s.id).then((list) => {
      if (chosen === s.id) [profiles, profile] = [list, list[0]?.id ?? null];
    }, () => {});
  }
  /** Bumped by each start: a progress answer asked before it belongs to an older run and is dropped. */
  let generation = 0;
  const readProgress = (then: (p: ImportProgress | null) => void) => {
    const g = generation;
    void bi.progress().then((p) => g === generation && then(p), () => {});
  };
  $effect(() => {
    void bi.sources().then((list) => (sources = list));
    readProgress((p) => {
      if (p && !p.done) [progress, watching] = [p, true];
    });
  });
  $effect(() => {
    if (!watching || progress?.done) return;
    const t = setInterval(() => readProgress((p) => (progress = p)), 1_000);
    return () => clearInterval(t);
  });

  async function start() {
    if (!source) return;
    generation++;
    [progress, watching] = [null, false];
    try {
      const r = await bi.start({ source: source.id, profile, types: types.filter((t) => !unchecked.includes(t)) });
      refusal = r.ok ? null : r.error;
      watching = r.ok;
    } catch (e) {
      refusal = `L'import n'a pas pu démarrer : ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  async function pickCsv() {
    const r = await bi.importPasswordsCsv();
    csv = !r.ok ? r.error : r.count < 2 ? `${r.count} mot de passe importé` : `${r.count.toLocaleString("fr-FR")} mots de passe importés`;
  }
  const guide = (s: ImportSource) =>
    s.id === "safari"
      ? ["Ouvrez l'app Mots de passe.", "Fichier › Exporter tous les mots de passe…"]
      : [`Dans ${s.name}, ouvrez about:logins`, "⋯ › Exporter les identifiants"];
</script>

{#snippet status(id: string, tone: string, text: string)}
  <div class="status" data-testid={id} data-tone={tone} role="status" out:fade={{ duration: 150 }}>{text}</div>
{/snippet}

<div class="import" data-testid="browser-import">
  {#if !sources}
    {@render status("import-status", "warn", "Vérification…")}
  {:else if !sources.length}
    {@render status("import-none", "off", "Aucun autre navigateur trouvé sur ce Mac.")}
  {:else}
    <div class="sources" role="radiogroup" aria-label="Navigateur">
      {#each sources as s (s.id)}
        <label class="source">
          <input type="radio" name="import-source" data-testid="import-source-{s.id}" checked={chosen === s.id} onchange={() => choose(s)} />
          {#if s.icon}<img src={s.icon} alt="" width="20" height="20" onerror={(e) => ((e.currentTarget as HTMLImageElement).hidden = true)} />{/if}
          {s.name}
        </label>
      {/each}
    </div>
    {#if source}
      <div class="options">
        {#if profiles.length > 1}
          <label class="profile" out:fade={{ duration: 150 }}>Profil
            <select data-testid="import-profile" bind:value={profile}>
              {#each profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </label>
        {/if}
        <div class="types">
          {#each types as t (t)}
            <label out:fade={{ duration: 150 }}>
              <input type="checkbox" data-testid="import-type-{t}" checked={!unchecked.includes(t)} onchange={(e) => (unchecked = e.currentTarget.checked ? unchecked.filter((u) => u !== t) : [...unchecked, t])} />
              {LABELS[t]}
            </label>
          {/each}
        </div>
        {#if source.passwordsByCsv}
          <div class="guide" data-testid="import-guide" out:fade={{ duration: 150 }}>
            <b>Mots de passe</b>
            <ol>
              {#each [...guide(source), "Choisissez le fichier ci-dessous.", "Supprimez ensuite le fichier exporté : il n'est pas chiffré."] as step (step)}<li>{step}</li>{/each}
            </ol>
            <div class="row">
              <button type="button" data-testid="import-csv" onclick={() => void pickCsv()}>Choisir le fichier CSV…</button>
              {#if csv}<span class="note" data-testid="import-csv-result" role="status">{csv}</span>{/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}
    <div class="row">
      <button type="button" data-testid="import-start" disabled={!types.some((t) => !unchecked.includes(t))} onclick={() => void start()}>Importer</button>
    </div>
    {#if refusal}{@render status("import-refusal", "warn", refusal)}{/if}
    {#if watching && progress?.done}{@render status("import-done", "ok", "Import terminé.")}
    {:else if watching}{@render status("import-started", "ok", "Import lancé : une notification vous préviendra à la fin.")}{/if}
    {#each failures as [t, why] (t)}{@render status(`import-failed-${t}`, "warn", `${LABELS[t]} : ${why}`)}{/each}
    {#if diskAccess}
      <div class="row" out:fade={{ duration: 150 }}>
        <button type="button" data-testid="import-disk-access" onclick={() => api.settings.openFullDiskAccessSettings()}>Ouvrir les réglages</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* Buttons as on the welcome; Réglages styles its own over these (its rules are more specific). */
  .import { display: flex; flex-direction: column; gap: 12px; }
  .import > *, .guide .note { animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .note { color: var(--text-muted); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

  .status { --tone: var(--stopped); display: flex; align-items: center; gap: 8px; }
  .status::before { content: ""; width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--tone); }
  .status[data-tone="ok"] { --tone: var(--running); }
  .status[data-tone="warn"] { --tone: var(--in-progress); }

  .sources { display: flex; flex-wrap: wrap; gap: 8px; }
  .source { flex: 1 1 auto; white-space: nowrap; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--glass-hi); font-weight: 600; transition: border-color var(--tap), transform var(--tap); }
  .source:has(:checked) { border-color: var(--accent); }
  .source:active { transform: scale(0.97); }
  /* macOS draws native controls in the system blue: ours, in the accent. */
  .source input { appearance: none; width: 15px; height: 15px; margin: 0; flex: none; border-radius: 50%; border: 1px solid var(--border); background: var(--glass-hi); transition: border-width var(--tap); }
  .source input:checked { border: 4.5px solid var(--accent); background: var(--accent-ink); }
  /* The tick in --accent-ink (dark on the dark theme's accent, white on the light one's). */
  input[type="checkbox"] { --tick: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.5 2.5L12 5.5' fill='none' stroke='%230E1014' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); appearance: none; width: 15px; height: 15px; margin: 0; flex: none; border-radius: 4px; border: 1px solid var(--border); background: var(--glass-hi) center / 100% no-repeat; transition: background-color var(--tap), border-color var(--tap); }
  @media (prefers-color-scheme: light) { input[type="checkbox"] { --tick: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 8.5l2.5 2.5L12 5.5' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); } }
  input[type="checkbox"]:checked { border-color: var(--accent); background-color: var(--accent); background-image: var(--tick); }

  .options { display: flex; flex-direction: column; gap: 12px; }
  .profile, .guide { animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .profile { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 13px; }
  select { padding: 5px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 13px var(--font-ui); }
  .types { display: flex; flex-wrap: wrap; gap: 8px 18px; }
  .types label { display: inline-flex; align-items: center; gap: 7px; animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .guide { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 16px; background: var(--glass-hi); border: 1px solid var(--glass-edge); }
  .guide ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }

  button { padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 13px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  :is(button, input, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
