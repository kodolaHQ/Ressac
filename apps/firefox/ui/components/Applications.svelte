<script lang="ts">
  import type { ActionApplication, ApplicationShown, ApplicationList } from "../../shared/api";
  import type { ActionSite, ShownSite } from "../../shared/sites";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import Icon from "./Icon.svelte";
  import ExternalProjects from "./ExternalProjects.svelte";
  import { openMenu, type MenuEntry } from "./menu.svelte";

  type Filter = "all" | "app" | "poc" | "no-manifest" | "running" | "stopped" | "error";

  /** Running in the panel's sense: everything that is neither stopped nor in error. */
  const active = (a: ApplicationShown) => a.state === "running" || a.state === "launching" || a.state === "preparing";
  const FILTERS: Record<Filter, (a: ApplicationShown) => boolean> = {
    all: () => true,
    app: (a) => a.type === "app",
    poc: (a) => a.type === "poc",
    "no-manifest": (a) => a.type === "no-manifest",
    running: active,
    stopped: (a) => a.state === "stopped",
    error: (a) => a.state === "error",
  };
  /** « No manifest » and « Failed » only appear if they hold at least one project. Ids: home-apps-group-<title>, home-apps-filter-<id>. */
  const GROUPS: { title: "type" | "state"; filters: { id: Filter; ifPresent?: boolean }[] }[] = [
    {
      title: "type",
      filters: [{ id: "all" }, { id: "app" }, { id: "poc" }, { id: "no-manifest", ifPresent: true }],
    },
    {
      title: "state",
      filters: [{ id: "running" }, { id: "stopped" }, { id: "error", ifPresent: true }],
    },
  ];

  let data = $state<ApplicationList>({ workshop: "ok", apps: [] });
  let loaded = $state(false);
  let filter = $state<Filter>("all");
  let text = $state("");
  let field: HTMLInputElement;
  let request = 0;
  /** Project whose deletion awaits the user's confirmation. */
  let toDelete = $state<ApplicationShown | null>(null);

  /** The site apps (« Sites » section): re-read on each change of the list or of their state. */
  let sites = $state<ShownSite[]>([]);
  let sitesRequest = 0;
  /** Site app whose forgetting or deletion awaits the user's confirmation. */
  let siteToForget = $state<ShownSite | null>(null);
  let siteToDelete = $state<ShownSite | null>(null);

  async function loadSites() {
    const n = ++sitesRequest;
    const r = await api.sites.list();
    if (n === sitesRequest) sites = r;
  }

  $effect(() => {
    void loadSites();
    return api.sites.onChange(() => void loadSites());
  });

  const actSite = (s: ShownSite, action: ActionSite) => api.sites.act(s.id, action);
  const siteRows = $derived.by(() => {
    const searches = text.trim().toLowerCase();
    return sites.filter((s) => !searches || [s.name, s.id, s.domain ?? "", s.description].some((x) => x.toLowerCase().includes(searches)));
  });

  async function load() {
    const n = ++request;
    const r = await api.apps.list();
    if (n !== request) return;
    data = r;
    loaded = true;
  }

  $effect(() => {
    void load();
    return api.apps.onChange(() => void load());
  });
  $effect(() => field.focus());

  const account = (f: Filter) => data.apps.filter(FILTERS[f]).length;
  // A filter that disappears from the panel (no app in error anymore…) gives way to Tout.
  const effectiveFilter = $derived(GROUPS.flatMap((g) => g.filters).some((x) => x.id === filter && (!x.ifPresent || account(x.id) > 0)) ? filter : "all");

  /** Running first, then the most recent last launch, then the most recent creation. */
  const lines = $derived.by(() => {
    const searches = text.trim().toLowerCase();
    return data.apps
      .filter(FILTERS[effectiveFilter])
      .filter((a) => !searches || [a.name, a.folder, a.origin ?? ""].some((x) => x.toLowerCase().includes(searches)))
      .sort(
        (a, b) =>
          Number(active(b)) - Number(active(a)) ||
          (b.lastLaunch ?? "").localeCompare(a.lastLaunch ?? "") ||
          b.createdAt.localeCompare(a.createdAt),
      );
  });

  const withoutDocker = $derived(data.workshop === "docker-absent");

  /** « yesterday », « 3d ago », « Oct 22 » */
  function when(iso: string): string {
    const d = new Date(iso);
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const gap = Math.round((day(new Date()) - day(d)) / 86_400_000);
    if (gap <= 0) return t("home-apps-today");
    if (gap === 1) return t("home-apps-yesterday");
    if (gap < 7) return t("home-apps-days-ago", { days: gap });
    return d.toLocaleDateString(appState.value?.locale ?? "fr", { day: "numeric", month: "short" });
  }

  function details(a: ApplicationShown): string {
    const chunks: string[] = [t(`home-apps-type-${a.type}`)];
    if (a.origin) chunks.push(t("home-apps-from", { origin: a.origin.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") }));
    chunks.push(a.port !== undefined && active(a) ? t("home-apps-port", { port: String(a.port) }) : when(a.createdAt));
    return chunks.join(" · ");
  }

  /**
   * First line of a reason or an error, for a tooltip. A manifest refused by zod carries the list of problems as
   * multi-line JSON: we keep the first one.
   */
  function short(reason: string | undefined): string | undefined {
    if (!reason) return undefined;
    const m = /^(ressac\.json invalide : )(\[[\s\S]*)$/.exec(reason);
    if (m) {
      try {
        const [p] = JSON.parse(m[2]!) as { path?: (string | number)[]; message?: string }[];
        if (p?.message) return `${m[1]}${p.path?.length ? `${p.path.join(".")} : ` : ""}${p.message}`;
      } catch {
        // Not JSON: first line.
      }
    }
    return reason.split("\n")[0];
  }

  const act = (a: ApplicationShown, action: ActionApplication) => api.apps.act(a.folder, action);

  /** Visible buttons and ⋯ menu entries depending on the state (spec §5). */
  function actions(a: ApplicationShown): { buttons: { label: string; action: ActionApplication; launched?: boolean }[]; menu: MenuEntry[] } {
    const entry = (label: string, action: ActionApplication): MenuEntry => ({
      label: label,
      dispatch: () => (action === "delete" ? (toDelete = a) : act(a, action)),
    });
    const promote = a.type === "poc" ? [entry(t("home-apps-promote"), "promote")] : [];
    if (a.type === "no-manifest") return { buttons: [{ label: t("home-apps-debug"), action: "debug" }], menu: [entry(t("home-delete"), "delete")] };
    switch (a.state) {
      case "preparing":
      case "launching":
        return { buttons: [{ label: t("home-apps-stop"), action: "stop" }], menu: [entry(t("home-apps-debug"), "debug"), entry(t("home-apps-changes"), "review")] };
      case "running":
        return {
          buttons: [
            { label: t("home-apps-open"), action: "open" },
            { label: t("home-apps-stop"), action: "stop" },
          ],
          menu: [entry(t("home-apps-relaunch"), "relaunch"), entry(t("home-apps-debug"), "debug"), entry(t("home-apps-changes"), "review")],
        };
      case "error":
        return {
          buttons: [
            { label: t("home-apps-relaunch"), action: "relaunch", launched: true },
            { label: t("home-apps-debug"), action: "debug" },
            { label: t("home-apps-changes"), action: "review" },
          ],
          menu: [entry(t("home-delete"), "delete"), ...promote],
        };
      case "stopped":
        return {
          buttons: [
            { label: t("home-apps-launch"), action: "launch", launched: true },
            { label: t("home-apps-debug"), action: "debug" },
            { label: t("home-apps-changes"), action: "review" },
          ],
          menu: [entry(t("home-delete"), "delete"), ...promote, entry(t("home-apps-folder"), "folder")],
        };
    }
  }
</script>

<section class="applications" data-testid="page-applications" aria-label={t("home-apps-title")}>
  <nav class="pane" aria-label={t("home-apps-filters")}>
    <h1>{t("home-apps-title")}</h1>
    {#each GROUPS as g (g.title)}
      <h2>{t(`home-apps-group-${g.title}`)}</h2>
      {#each g.filters.filter((x) => !x.ifPresent || account(x.id) > 0) as x (x.id)}
        <button data-testid="filter-{x.id}" class:active={effectiveFilter === x.id} aria-pressed={effectiveFilter === x.id} onclick={() => (filter = x.id)}
          >{t(`home-apps-filter-${x.id}`)} <span class="n">{account(x.id)}</span></button
        >
      {/each}
    {/each}
  </nav>
  <div class="main">
    <label class="search-box">
      <Icon name="find" size={14} />
      <input bind:this={field} bind:value={text} type="search" data-testid="applications-search" placeholder={t("home-apps-search")} spellcheck="false" />
    </label>
    {#if withoutDocker}
      <p class="banner" role="status">{t("home-apps-no-docker")}</p>
    {/if}
    {#if loaded && data.apps.length === 0 && sites.length === 0}
      <p class="empty">{t("home-apps-empty")}</p>
    {:else}
      <ul>
        {#each lines as a (a.folder)}
          {@const { buttons: buttons, menu } = actions(a)}
          <li data-testid="app-{a.folder}" data-state={a.state}>
            <span class="icon">
              {#if a.favicon}<img src={a.favicon} alt="" width="16" height="16" />{:else}✦{/if}
            </span>
            <div class="name">
              <b>{a.name}</b>
              <span>{details(a)}</span>
            </div>
            {#if a.type === "no-manifest"}
              <span class="state" title={short(a.noManifest)}><span class="pill stopped"></span>{t("home-apps-type-no-manifest")}</span>
            {:else}
              <span class="state" title={short(a.error)}><span class="pill {a.state}"></span>{t(`home-apps-state-${a.state}`)}</span>
            {/if}
            <div class="actions">
              {#each buttons as b (b.action)}
                <button disabled={b.launched && withoutDocker} onclick={() => act(a, b.action)}>{b.label}</button>
              {/each}
              <button
                class="options"
                aria-label={t("home-apps-more")}
                title={t("home-apps-more")}
                onclick={(e) => {
                  e.stopPropagation(); // the window would close the menu right away
                  openMenu(e, menu, { free: true });
                }}><Icon name="options" /></button
              >
            </div>
          </li>
        {:else}
          {#if siteRows.length === 0}<li class="none">{t("home-apps-no-match")}</li>{/if}
        {/each}
      </ul>
    {/if}
    {#if siteRows.length > 0}
      <section class="sites" data-testid="section-sites" aria-label={t("home-apps-sites")}>
        <h2 class="sites-title">{t("home-apps-sites")}</h2>
        <ul>
          {#each siteRows as s (s.id)}
            <li data-testid="site-{s.id}" data-open={s.open}>
              <span class="icon">
                {#if s.icon}<img src={s.icon} alt="" width="16" height="16" />{:else}<Icon name="globe" size={16} />{/if}
              </span>
              <div class="name">
                <b>{s.name}</b>
                <span>{s.domain ?? s.id}</span>
              </div>
              {#if s.error !== undefined}
                <span class="state" title={s.error}><span class="pill error"></span>{t("home-apps-type-no-manifest")}</span>
              {:else}
                <span class="state"><span class="pill {s.open ? 'running' : 'stopped'}"></span>{s.open ? t("home-apps-site-open") : t("home-apps-site-closed")}</span>
              {/if}
              {#if s.error !== undefined}
                <span class="site-error" data-testid="site-{s.id}-error">{s.error}</span>
              {/if}
              {#if s.actionError}
                <span class="site-error" data-testid="site-{s.id}-action-error" role="alert">{s.actionError}</span>
              {/if}
              {#if !s.noActions}
              <div class="actions">
                {#if s.error === undefined}
                  <button data-testid="site-{s.id}-open" onclick={() => actSite(s, "open")}>{t("home-apps-open")}</button>
                {/if}
                <button data-testid="site-{s.id}-edit" onclick={() => actSite(s, "edit")}>{t("home-apps-site-edit")}</button>
                <!-- The rest in a menu, as for the apps: a row of six buttons wrapped into a column in a narrow window. -->
                <button
                  class="options"
                  data-testid="site-{s.id}-more"
                  aria-label={t("home-apps-more")}
                  title={t("home-apps-more")}
                  onclick={(e) => {
                    e.stopPropagation(); // the window would close the menu right away
                    openMenu(
                      e,
                      [
                        { label: t("home-apps-site-forget"), dispatch: () => (siteToForget = s) },
                        { label: t("home-apps-folder"), dispatch: () => actSite(s, "folder") },
                        { label: t("home-apps-changes"), dispatch: () => actSite(s, "review") },
                        { label: t("home-delete"), dispatch: () => (siteToDelete = s) },
                      ],
                      { free: true },
                    );
                  }}><Icon name="options" /></button
                >
              </div>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <ExternalProjects />
  </div>
</section>

{#if siteToForget}
  {@const target = siteToForget}
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="site-forget-confirmation">
      <p>{t("home-apps-forget-confirm", { name: target.name })}</p>
      <div class="buttons">
        <button onclick={() => (siteToForget = null)}>{t("home-cancel")}</button>
        <button
          class="confirm"
          data-testid="confirm-site-forget"
          onclick={() => {
            const s = target;
            siteToForget = null;
            actSite(s, "forget");
          }}>{t("home-apps-forget")}</button
        >
      </div>
    </div>
  </div>
{/if}

{#if siteToDelete}
  {@const target = siteToDelete}
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="site-delete-confirmation">
      <p>{t("home-apps-site-delete-confirm", { name: target.name })}</p>
      <div class="buttons">
        <button onclick={() => (siteToDelete = null)}>{t("home-cancel")}</button>
        <button
          class="confirm"
          data-testid="confirm-site-delete"
          onclick={() => {
            const s = target;
            siteToDelete = null;
            actSite(s, "delete");
          }}>{t("home-delete")}</button
        >
      </div>
    </div>
  </div>
{/if}

{#if toDelete}
  {@const target = toDelete}
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="delete-confirmation">
      <p>{t("home-apps-delete-confirm", { name: target.name })}</p>
      <div class="buttons">
        <button onclick={() => (toDelete = null)}>{t("home-cancel")}</button>
        <button
          class="confirm"
          onclick={() => {
            const a = target; // {@const} is re-read: after toDelete = null, cible is null
            toDelete = null;
            act(a, "delete");
          }}>{t("home-delete")}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .applications { display: grid; grid-template-columns: 190px 1fr; height: 100%; color: var(--text); }
  .pane { display: flex; flex-direction: column; gap: 2px; padding: 22px 10px; border-right: 1px solid var(--border); overflow-y: auto; }
  h1 { margin: 0 10px 8px; font: 650 22px/1.1 var(--font-display); letter-spacing: -0.02em; }
  h2 { margin: 14px 10px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
  .pane button { all: unset; display: flex; justify-content: space-between; align-items: center; height: 32px; padding: 0 10px; border-radius: 10px; transition: transform var(--tap), background var(--tap); }
  .pane button:hover { background: var(--bg-hover); }
  .pane button:active { transform: scale(0.97); }
  .pane button.active { background: var(--glass-hi); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); }
  .n { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .main { min-width: 0; overflow-y: auto; padding: 22px 24px; }
  .search-box { display: flex; align-items: center; gap: 8px; padding: 0 12px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--glass-hi); color: var(--text-muted); transition: border-color var(--tap); }
  .search-box:focus-within { border-color: var(--accent); }
  .search-box input { all: unset; flex: 1; padding: 8px 0; color: var(--text); }
  .banner { margin: 0 0 14px; padding: 10px 14px; border-radius: 12px; background: var(--attention-bg); }
  .sites { margin-top: 24px; }
  .sites-title { margin: 0 0 10px; font: 650 20px/1.1 var(--font-display); letter-spacing: -0.02em; text-transform: none; color: var(--text); }
  .site-error { flex: 1; min-width: 0; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty, .none { color: var(--text-muted); }
  /* A list is a sheet card on the glass. */
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-top: 1px solid var(--border); }
  li:first-child { border-top: none; }
  ul:not(:has(li)) { display: none; }
  .icon { width: 30px; height: 30px; flex: none; display: grid; place-content: center; border-radius: 9px; background: color-mix(in oklab, var(--a1) 16%, var(--glass-hi)); color: var(--accent); }
  .name { flex: 1; min-width: 140px; }
  .name b { display: block; font-weight: 600; }
  .name span { display: block; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { display: flex; align-items: center; gap: 6px; width: 170px; flex: none; font-size: 12px; white-space: nowrap; }
  .pill { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--stopped); }
  .pill.running { background: var(--running); }
  .pill.launching, .pill.preparing { background: var(--in-progress); }
  .pill.error { background: var(--in-error); }
  /* Many buttons (a site has six): they wrap instead of crushing the name. */
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex: 0 1 auto; }
  .actions button { padding: 5px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  .actions button:hover:not(:disabled) { background: var(--bg-active); }
  .actions button:active:not(:disabled) { transform: scale(0.97); }
  .actions button:disabled { opacity: 0.5; }
  .veil { position: fixed; inset: 0; display: grid; place-content: center; background: var(--veil); backdrop-filter: blur(6px); z-index: 10; }
  .confirmation { max-width: 420px; padding: 18px 20px; border-radius: 16px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--modal-shadow); color: var(--text); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 14px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); transition: transform var(--tap); }
  .buttons button:active { transform: scale(0.97); }
  .buttons .confirm { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .actions .options { display: grid; place-content: center; padding: 4px 6px; border-color: transparent; background: none; color: var(--text-muted); }
</style>
