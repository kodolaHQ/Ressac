<script lang="ts">
  import { onDestroy } from "svelte";
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { fade } from "svelte/transition";
  import type { PasswordResult, SavedLogin } from "../../shared/api";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import Icon from "./Icon.svelte";
  import { onLeavingPasswords, showSection } from "./settings-section.svelte";

  // Styles of groups, rows and buttons come from Settings.svelte. A password reaches this page only on « Afficher » or
  // « Modifier », one login at a time, with this page's Touch ID token (chrome/passwords/settings.ts).
  const p = api.settings.passwords!;
  type Draft = { username: string; password: string; error: string | null };

  let logins = $state<SavedLogin[] | null>(null);
  const primary = p.primaryPassword();
  let query = $state("");
  let session = $state<{ token: string; until: number; showMs: number } | null>(null);
  /** The passwords on screen, by guid: each hides after `showMs`, and all at a relock. */
  let shown = $state<Record<string, string>>({});
  let editing = $state<(Draft & { guid: string }) | null>(null);
  let adding = $state<(Draft & { origin: string }) | null>(null);
  let deleting = $state<string | null>(null);
  /** A page message: `alert` for a refusal or a failure, else a status (« Copié »). */
  let notice = $state<{ key: string; alert: boolean } | null>(null);
  /** Touch ID or the chrome is answering: the buttons wait (no second prompt). */
  let busy = $state(false);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (f: () => void, ms: number) => {
    const x = setTimeout(() => {
      timers.delete(x);
      f();
    }, ms);
    timers.add(x);
  };

  const load = async () => (logins = await p.list());
  $effect(() => void load());

  const shownList = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return (logins ?? []).filter((l) => !q || l.host.toLowerCase().includes(q) || l.username.toLowerCase().includes(q));
  });

  function relock() {
    if (session) p.lock();
    session = null;
    for (const x of timers) clearTimeout(x);
    timers.clear();
    shown = {};
    editing = null;
    deleting = null;
  }
  // The token's 5 minutes, then the relock.
  $effect(() => {
    if (!session) return;
    const x = setTimeout(relock, Math.max(0, session.until - Date.now()));
    return () => clearTimeout(x);
  });
  // The Mac slept or its screen locked (chrome), the page hid or closed, the section was left: relocked.
  $effect(() => p.onLocked(relock));
  $effect(() => {
    const hidden = () => document.visibilityState === "hidden" && relock();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", relock);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", relock);
    };
  });
  $effect(() => onLeavingPasswords(relock));
  onDestroy(relock);

  const say = (key: string, alert = true) => void (notice = { key, alert });
  /** This page's live token, asking Touch ID when there is none; null (and the refusal said) when refused. */
  async function token(): Promise<string | null> {
    if (session && Date.now() < session.until) return session.token;
    const u = await p.unlock();
    if (!u) return say("settings-passwords-refused"), null;
    session = u;
    return u.token;
  }
  /** Runs one token action, the buttons waiting meanwhile. */
  async function act(f: (token: string) => Promise<void>) {
    if (busy || primary) return;
    busy = true;
    notice = null;
    try {
      const k = await token();
      if (k) await f(k);
    } finally {
      busy = false;
    }
  }
  const ERRORS: Record<Exclude<PasswordResult, { ok: true }>["error"], string> = {
    locked: "settings-passwords-error-locked",
    origin: "settings-passwords-error-origin",
    password: "settings-passwords-error-password",
    duplicate: "settings-passwords-error-duplicate",
    missing: "settings-passwords-error-missing",
    primary: "settings-passwords-primary",
    write: "settings-passwords-error-write",
  };
  /** A refused write: a dead token relocks the page. */
  function failed(r: Exclude<PasswordResult, { ok: true }>, draft?: Draft | null) {
    if (r.error === "locked") relock();
    if (draft && r.error !== "locked" && r.error !== "missing") draft.error = ERRORS[r.error];
    else say(ERRORS[r.error]);
    if (r.error === "missing") void load();
  }
  /** A password the chrome did not give: the login is gone, or the token died there. */
  async function lost(guid: string) {
    await load();
    if (logins?.some((l) => l.guid === guid)) {
      relock();
      say("settings-passwords-error-locked");
    } else say("settings-passwords-error-missing");
  }

  const show = (l: SavedLogin) => {
    if (l.guid in shown) return void delete shown[l.guid];
    return act(async (k) => {
      const v = await p.reveal(k, l.guid);
      if (v === null) return lost(l.guid);
      shown[l.guid] = v;
      later(() => delete shown[l.guid], session?.showMs ?? 20_000);
    });
  };
  const copy = (l: SavedLogin) =>
    act(async (k) => {
      if (!(await p.copyPassword(k, l.guid))) return lost(l.guid);
      say("settings-passwords-copied", false);
    });
  async function copyUsername(l: SavedLogin) {
    notice = null;
    if (await p.copyUsername(l.guid)) say("settings-passwords-copied", false);
    else await lost(l.guid);
  }
  const edit = (l: SavedLogin) =>
    act(async (k) => {
      const v = await p.reveal(k, l.guid);
      if (v === null) return lost(l.guid);
      adding = null;
      deleting = null;
      editing = { guid: l.guid, username: l.username, password: v, error: null };
    });
  const save = () =>
    act(async (k) => {
      const d = editing;
      if (!d) return;
      const r = await p.edit(k, d.guid, { username: d.username, password: d.password });
      if (!r.ok) return failed(r, d);
      if (editing === d) editing = null;
      delete shown[d.guid];
      await load();
    });
  const remove = (l: SavedLogin) =>
    act(async (k) => {
      const r = await p.remove(k, l.guid);
      deleting = null;
      if (!r.ok) return failed(r);
      await load();
    });
  function startAdd() {
    notice = null;
    editing = null;
    adding = { origin: "", username: "", password: "", error: null };
  }
  const commitAdd = () =>
    act(async (k) => {
      const d = adding;
      if (!d) return;
      const r = await p.add(k, { origin: d.origin, username: d.username, password: d.password });
      if (!r.ok) return failed(r, d);
      if (adding === d) adding = null;
      await load();
    });
  /** Enter saves, Escape cancels, from any field of a form. */
  const keys = (commit: () => unknown, cancel: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      void commit();
    }
  };
  const focusFirst = (node: HTMLElement) => void (node.querySelector("input") as HTMLElement | null)?.focus();
  const named = (l: SavedLogin) => l.username || t("settings-passwords-no-username");
</script>

<section data-testid="settings-passwords" aria-label={t("settings-section-passwords")}>
  <div class="head">
    <h3>{t("settings-section-passwords")}</h3>
    <div class="buttons">
      {#if session}
        <button data-testid="passwords-lock" onclick={relock}><Icon name="lock" size={14} />{t("settings-passwords-lock")}</button>
      {:else}
        <button data-testid="passwords-unlock" disabled={busy || primary} onclick={() => act(async () => {})}><Icon name="lock-open" size={14} />{t("settings-passwords-unlock")}</button>
      {/if}
      <button class="primary" data-testid="passwords-add" disabled={busy || primary} onclick={startAdd}><Icon name="plus" size={14} />{t("settings-passwords-add")}</button>
    </div>
  </div>
  <p class="intro">{t("settings-passwords-shared")}</p>
  {#if primary}<p class="status alert" role="status" data-testid="passwords-primary">{t("settings-passwords-primary")}</p>{/if}
  {#if notice}
    <p class="status appear" class:alert={notice.alert} role={notice.alert ? "alert" : "status"} data-testid="passwords-notice" out:fade={{ duration: 150 }}>{t(notice.key)}</p>
  {/if}

  {#if adding}
    {@const d = adding}
    <div class="group" out:fade={{ duration: 150 }}>
      <!-- svelte-ignore a11y_no_static_element_interactions: Enter saves and Escape cancels from any of its fields -->
      <div class="editor" data-testid="passwords-add-form" onkeydown={keys(commitAdd, () => (adding = null))} use:focusFirst>
        <h4>{t("settings-passwords-add-title")}</h4>
        <label class="field"><span>{t("settings-passwords-site")}</span><input data-testid="passwords-add-site" bind:value={d.origin} placeholder="https://exemple.fr" spellcheck="false" autocomplete="off" /></label>
        <div class="pair">
          <label class="field"><span>{t("settings-passwords-username")}</span><input data-testid="passwords-add-username" bind:value={d.username} spellcheck="false" autocomplete="off" /></label>
          <label class="field"><span>{t("settings-passwords-password")}</span><input data-testid="passwords-add-password" type="password" bind:value={d.password} autocomplete="new-password" /></label>
        </div>
        {#if d.error}<p class="alert" role="alert" data-testid="passwords-add-error">{t(d.error)}</p>{/if}
        <div class="buttons">
          <button data-testid="passwords-add-cancel" onclick={() => (adding = null)}>{t("settings-passwords-cancel")}</button>
          <button class="primary" data-testid="passwords-add-save" disabled={busy || !d.password} onclick={commitAdd}>{t("settings-passwords-save")}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if logins && (logins.length || !primary)}
    {#if logins.length}
      <input class="wide search" type="search" data-testid="passwords-search" aria-label={t("settings-passwords-search")} placeholder={t("settings-passwords-search")} bind:value={query} />
    {/if}
    {#if !logins.length}
      <div class="group empty" data-testid="passwords-empty">
        <p>{t("settings-passwords-empty")}</p>
        <p class="muted">{t("settings-passwords-empty-import")}</p>
        <div class="buttons"><button data-testid="passwords-go-import" onclick={() => showSection("data")}>{t("settings-passwords-go-import")}</button></div>
      </div>
    {:else if !shownList.length}
      <p class="caption" data-testid="passwords-no-match">{t("settings-passwords-no-match")}</p>
    {:else}
      <div class="group">
        {#each shownList as l (l.guid)}
          <div animate:flip={{ duration: 120, easing: cubicOut }} out:fade={{ duration: 150 }}>
            {#if editing?.guid === l.guid}
              {@const d = editing}
              <!-- svelte-ignore a11y_no_static_element_interactions: Enter saves and Escape cancels from any of its fields -->
              <div class="editor" data-testid="password-editor" onkeydown={keys(save, () => (editing = null))} use:focusFirst out:fade={{ duration: 150 }}>
                <h4>{l.host}</h4>
                <div class="pair">
                  <label class="field"><span>{t("settings-passwords-username")}</span><input data-testid="password-edit-username" bind:value={d.username} spellcheck="false" autocomplete="off" /></label>
                  <label class="field"><span>{t("settings-passwords-password")}</span><input data-testid="password-edit-password" type="password" bind:value={d.password} autocomplete="new-password" /></label>
                </div>
                {#if d.error}<p class="alert" role="alert" data-testid="password-edit-error">{t(d.error)}</p>{/if}
                <div class="buttons">
                  <button data-testid="password-edit-cancel" onclick={() => (editing = null)}>{t("settings-passwords-cancel")}</button>
                  <button class="primary" data-testid="password-edit-save" disabled={busy || !d.password} onclick={save}>{t("settings-passwords-save")}</button>
                </div>
              </div>
            {:else}
              <div class="row login" data-testid="password-row" data-host={l.host}>
                <div class="grow">
                  <b>{l.host}</b>
                  <span class="muted">{named(l)}</span>
                  {#if l.guid in shown}<span class="val" data-testid="password-shown" in:fade={{ duration: 150 }} out:fade={{ duration: 150 }}>{shown[l.guid]}</span>{/if}
                </div>
                <div class="actions">
                  <button class="link" aria-pressed={l.guid in shown} data-testid="password-show" disabled={busy || primary} onclick={() => show(l)}>{t(l.guid in shown ? "settings-passwords-hide" : "settings-passwords-show")}</button>
                  <button class="link" data-testid="password-copy" disabled={busy || primary} onclick={() => copy(l)}>{t("settings-passwords-copy")}</button>
                  <button class="link" data-testid="password-copy-username" disabled={busy || primary || !l.username} onclick={() => copyUsername(l)}>{t("settings-passwords-copy-username")}</button>
                  <button class="link" data-testid="password-edit" disabled={busy || primary} onclick={() => edit(l)}>{t("settings-passwords-edit")}</button>
                  <button class="link danger" data-testid="password-delete" disabled={busy || primary} onclick={() => ((deleting = l.guid), (notice = null))}>{t("settings-passwords-delete")}</button>
                </div>
              </div>
              {#if deleting === l.guid}
                <div class="confirmation" role="alert" data-testid="password-delete-confirm" out:fade={{ duration: 150 }}>
                  <p>{t(l.username ? "settings-passwords-delete-confirm" : "settings-passwords-delete-confirm-anonymous", { username: l.username, site: l.host })}</p>
                  <div class="buttons">
                    <button data-testid="password-delete-keep" onclick={() => (deleting = null)}>{t("settings-passwords-keep")}</button>
                    <button class="danger" data-testid="password-delete-yes" disabled={busy} onclick={() => remove(l)}>{t("settings-passwords-delete")}</button>
                  </div>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 10px; }
  .head h3 { margin: 0; font: 600 20px/1.2 var(--font-display); letter-spacing: -0.015em; }
  .head button { display: inline-flex; align-items: center; gap: 6px; }
  .search { margin: 0 0 14px; }
  .login { flex-wrap: wrap; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 6px; }
  .val { font: 500 12.5px/1.45 var(--font-mono); overflow-wrap: anywhere; user-select: text; }
  .link { border: 0 !important; background: none !important; padding: 2px 4px !important; color: var(--text-muted) !important; font-weight: 500 !important; text-decoration: underline; text-underline-offset: 2px; }
  .link.danger { color: var(--in-error) !important; }
  .empty { display: flex; flex-direction: column; gap: 8px; padding: 18px 20px; }
  .empty.group > * + * { border-top: 0; }
  .empty .buttons { justify-content: flex-start; margin-top: 4px; }
  .editor { display: grid; gap: 12px; padding: 16px 20px 18px; background: color-mix(in srgb, var(--sheet) 70%, transparent); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .editor h4 { margin: 0; font: 600 13.5px/1.3 var(--font-display); }
  .field { display: grid; gap: 5px; min-width: 0; }
  .field > span:first-child { font-size: 12px; font-weight: 500; color: var(--text-muted); }
  .field input { width: 100%; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @container (max-width: 520px) { .pair { grid-template-columns: 1fr; } }
</style>
