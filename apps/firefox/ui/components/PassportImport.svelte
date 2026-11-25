<script lang="ts">
  import { fade } from "svelte/transition";
  import type { PassportProposal, PassportImportResult } from "../../shared/api";
  import { passportName } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";

  /**
   * The saved addresses of one browser, one line each: tick what to keep, « Ajouter » (Touch ID). The values are read here
   * for display only; the add sends keys, never a value. `quiet`: nothing is shown when the browser has no address (the
   * welcome); Réglages says so instead. Design § 4.3.
   */
  let { source, profile: wanted, quiet = false, onclose, onadded }: { source: string; profile?: string; quiet?: boolean; onclose?: () => void; onadded?: () => void } = $props();

  const pi = api.settings.passportImport!;
  let name = $state("");
  let lines = $state<(PassportProposal & { on: boolean; as: "me" | "proche" })[] | null>(null);
  let incomplete = $state(0);
  let erase = $state(false);
  let busy = $state(false);
  let result = $state<PassportImportResult | null>(null);
  let chosen = $state<string | null>(null);
  /** macOS wants the person's consent for this browser's folder before it is read. */
  let ask = $state(false);
  let denied = $state<string | null>(null);
  // A new profile asked from outside (Réglages changed section) wins over an earlier pick.
  $effect(() => void (wanted, (chosen = null)));

  /** The spaces' login profiles, named as Réglages names their passports (private spaces have none). */
  const profiles = $derived.by(() => {
    const spaces = appState.value?.spaces ?? [];
    return [...new Set(spaces.filter((s) => !s.private).map((s) => s.profile))].map((id) => ({ id, name: passportName(spaces, id, t("settings-passport-no-space")) }));
  });
  const target = $derived.by(() => [chosen, wanted].find((id) => id && profiles.some((p) => p.id === id)) ?? profiles[0]?.id ?? null);
  const ticked = $derived(lines?.filter((l) => l.on) ?? []);

  function load(id: string) {
    void pi.proposals(id).then((r) => {
      if (id !== source) return;
      [name, ask] = [r.name, r.access === "ask"];
      lines = ask ? null : r.proposals.map((p) => ({ ...p, on: p.ticked, as: "proche" }));
      incomplete = r.incomplete;
      erase = false;
      result = null;
    }, () => (lines = []));
  }
  $effect(() => {
    const id = source;
    [lines, ask, denied] = [null, false, null];
    load(id);
  });
  async function grant() {
    const id = source;
    const r = await api.browserImport.grantAccess(id as never);
    if (id !== source) return;
    if (r.ok) [ask, denied] = [false, null], load(id);
    else denied = r.error;
  }

  async function add() {
    if (!target || busy || !ticked.length) return;
    busy = true;
    // The chrome refuses nothing here: it asks Touch ID, then writes.
    result = await pi.add(target, ticked.map((l) => ({ key: l.key, as: l.other ? l.as : "me" })), source, erase).catch(() => ({ ok: false as const, error: "write" as const })).finally(() => (busy = false));
    if (result.ok && result.added + result.variants > 0) onadded?.();
  }
  const added = $derived(result?.ok ? result.added + result.variants : 0);
  const summary = (p: PassportProposal) => [p.address.replace("\n", ", "), p.tel, p.email].filter(Boolean).join(" · ");
</script>

{#if ask}
  <div class="card appear" data-testid="passport-import-access" out:fade={{ duration: 150 }}>
    <p>{t("home-import-access", { name })}</p>
    <div class="row"><button type="button" data-testid="passport-import-grant" onclick={() => void grant()}>{t("home-import-access-grant")}</button></div>
    {#if denied}<p class="alert" role="status">{denied}</p>{/if}
  </div>
{:else if lines && !(quiet && !lines.length)}
  <div class="card appear" data-testid="passport-import" out:fade={{ duration: 150 }}>
    {#if !lines.length}
      <p data-testid="passport-import-none">{t("settings-passport-import-none", { name })}</p>
    {:else if !result?.ok}
      <p>{t("settings-passport-import-intro", { name })}</p>
      <div class="lines">
        {#each lines as l (l.key)}
          <div class="line" data-testid="passport-import-line">
            <label class="grow">
              <input type="checkbox" data-testid="passport-import-tick" bind:checked={l.on} />
              <span><b>{`${l.given} ${l.family}`.trim()}</b><span class="muted">{summary(l)}</span></span>
            </label>
            {#if l.other}
              <select aria-label={t("settings-passport-import-as")} data-testid="passport-import-as" bind:value={l.as}>
                <option value="proche">{t("settings-passport-import-other")}</option>
                <option value="me">{t("settings-passport-import-me")}</option>
              </select>
            {/if}
          </div>
        {/each}
      </div>
      {#if incomplete}<p class="muted" data-testid="passport-import-incomplete">{t("settings-passport-import-incomplete", { n: incomplete })}</p>{/if}
      {#if source === "ressac"}
        <label class="erase"><input type="checkbox" data-testid="passport-import-erase" bind:checked={erase} />{t("settings-passport-import-erase")}</label>
      {/if}
      {#if result}<p class="alert" role="status" data-testid="passport-import-error" out:fade={{ duration: 150 }}>{t(result.error === "cancelled" ? "settings-passport-import-cancelled" : "settings-passport-import-error")}</p>{/if}
      <div class="row">
        {#if profiles.length > 1}
          <label class="muted">{t("settings-passport-import-profile")}
            <select data-testid="passport-import-profile" value={target} onchange={(e) => (chosen = e.currentTarget.value)}>
              {#each profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
            </select>
          </label>
        {/if}
        <span class="grow"></span>
        <button type="button" data-testid="passport-import-later" onclick={() => onclose?.()}>{t("settings-passport-import-later")}</button>
        <button type="button" class="primary" data-testid="passport-import-add" disabled={busy || !ticked.length || !target} onclick={() => void add()}>{t("settings-passport-import-add")}</button>
      </div>
    {:else}
      <div role="status" data-testid="passport-import-done" class="appear">
        {#if added}<p>{t("settings-passport-import-done", { n: added })}</p>
        {:else if !result.full && !result.invalid}<p data-testid="passport-import-nothing">{t("settings-passport-import-nothing")}</p>{/if}
        {#if result.invalid}<p class="alert" data-testid="passport-import-invalid">{t("settings-passport-import-invalid", { n: result.invalid })}</p>{/if}
        {#if result.full}<p class="alert" data-testid="passport-import-full">{t("settings-passport-import-full", { n: result.full })}</p>{/if}
      </div>
      <div class="row"><span class="grow"></span><button type="button" data-testid="passport-import-close" onclick={() => onclose?.()}>{t("settings-passport-import-close")}</button></div>
    {/if}
  </div>
{/if}

<style>
  .card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: 16px; background: var(--glass-hi); border: 1px solid var(--glass-edge); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .card p { margin: 0; }
  .lines { display: flex; flex-direction: column; gap: 8px; }
  .line, .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .grow { flex: 1 1 200px; min-width: 0; }
  label.grow { display: flex; align-items: flex-start; gap: 9px; }
  label.grow > span { display: flex; flex-direction: column; min-width: 0; }
  .muted { color: var(--text-muted); font-size: 13px; overflow-wrap: anywhere; }
  .erase { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .alert { color: var(--in-progress); }
  select { padding: 5px 8px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 13px var(--font-ui); }
  input[type="checkbox"] { appearance: auto; accent-color: var(--accent); margin: 2px 0 0; flex: none; }
  button { padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 13px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  :is(button, input, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
