<script lang="ts">
  import type { ActionApplication, ApplicationShown, ApplicationList } from "../../shared/api";
  import { confirmForget, confirmSiteDeletion, FORGET_MEMORY, type ActionSite, type ShownSite } from "../../shared/sites";
  import { api } from "../state.svelte";
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
  /** « Sans fiche » and « En erreur » only appear if they hold at least one project. */
  const GROUPS: { title: string; filters: { id: Filter; label: string; ifPresent?: boolean }[] }[] = [
    {
      title: "Type",
      filters: [
        { id: "all", label: "Tout" },
        { id: "app", label: "Applications" },
        { id: "poc", label: "POC et tests" },
        { id: "no-manifest", label: "Sans fiche", ifPresent: true },
      ],
    },
    {
      title: "État",
      filters: [
        { id: "running", label: "En marche" },
        { id: "stopped", label: "Arrêtées" },
        { id: "error", label: "En erreur", ifPresent: true },
      ],
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

  const TYPES = { app: "Application", poc: "POC", "no-manifest": "Sans fiche" } as const;
  const STATES = {
    stopped: "Arrêtée",
    preparing: "Préparation de l'atelier…",
    launching: "Lancement…",
    running: "En marche",
    error: "En erreur",
  } as const;

  /** « hier », « il y a 3 j », « 22 oct. » */
  function when(iso: string): string {
    const d = new Date(iso);
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const gap = Math.round((day(new Date()) - day(d)) / 86_400_000);
    if (gap <= 0) return "aujourd'hui";
    if (gap === 1) return "hier";
    if (gap < 7) return `il y a ${gap} j`;
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  }

  function details(a: ApplicationShown): string {
    const chunks: string[] = [TYPES[a.type]];
    if (a.origin) chunks.push(`depuis ${a.origin.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}`);
    chunks.push(a.port !== undefined && active(a) ? `port ${a.port}` : when(a.createdAt));
    return chunks.join(" · ");
  }

  /**
   * First line of a reason or an error, for a tooltip. A manifest refused by zod carries the list of problems as
   * multi-line JSON: we keep the first one.
   */
  function short(reason: string | undefined): string | undefined {
    if (!reason) return undefined;
    const m = /^(webaios\.json invalide : )(\[[\s\S]*)$/.exec(reason);
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
    const promote = a.type === "poc" ? [entry("Passer en application", "promote")] : [];
    if (a.type === "no-manifest") return { buttons: [{ label: "Déboguer", action: "debug" }], menu: [entry("Supprimer", "delete")] };
    switch (a.state) {
      case "preparing":
      case "launching":
        return { buttons: [{ label: "Arrêter", action: "stop" }], menu: [entry("Déboguer", "debug"), entry("Relire", "review")] };
      case "running":
        return {
          buttons: [
            { label: "Ouvrir", action: "open" },
            { label: "Arrêter", action: "stop" },
          ],
          menu: [entry("Relancer", "relaunch"), entry("Déboguer", "debug"), entry("Relire", "review")],
        };
      case "error":
        return {
          buttons: [
            { label: "Relancer", action: "relaunch", launched: true },
            { label: "Déboguer", action: "debug" },
            { label: "Relire", action: "review" },
          ],
          menu: [entry("Supprimer", "delete"), ...promote],
        };
      case "stopped":
        return {
          buttons: [
            { label: "Lancer", action: "launch", launched: true },
            { label: "Déboguer", action: "debug" },
            { label: "Relire", action: "review" },
          ],
          menu: [entry("Supprimer", "delete"), ...promote, entry("Afficher le dossier", "folder")],
        };
    }
  }
</script>

<section class="applications" data-testid="page-applications" aria-label="Applications">
  <nav class="pane" aria-label="Filtres">
    {#each GROUPS as g (g.title)}
      <h2>{g.title}</h2>
      {#each g.filters.filter((x) => !x.ifPresent || account(x.id) > 0) as x (x.id)}
        <button data-testid="filter-{x.id}" class:active={effectiveFilter === x.id} aria-pressed={effectiveFilter === x.id} onclick={() => (filter = x.id)}
          >{x.label} <span class="n">{account(x.id)}</span></button
        >
      {/each}
    {/each}
  </nav>
  <div class="main">
    <label class="search-box">
      <Icon name="find" size={14} />
      <input bind:this={field} bind:value={text} type="search" data-testid="applications-search" placeholder="Chercher une appli…" spellcheck="false" />
    </label>
    {#if withoutDocker}
      <p class="banner" role="status">Docker n'est pas lancé. La liste reste visible, mais aucune appli ne peut être lancée.</p>
    {/if}
    {#if loaded && data.apps.length === 0 && sites.length === 0}
      <p class="empty">Rien ici pour l'instant. Demande à l'agent de tester un package ou de construire une app.</p>
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
              <span class="state" title={short(a.noManifest)}><span class="pill stopped"></span>Sans fiche</span>
            {:else}
              <span class="state" title={short(a.error)}><span class="pill {a.state}"></span>{STATES[a.state]}</span>
            {/if}
            <div class="actions">
              {#each buttons as b (b.action)}
                <button disabled={b.launched && withoutDocker} onclick={() => act(a, b.action)}>{b.label}</button>
              {/each}
              <button
                class="options"
                aria-label="Plus d'actions"
                title="Plus d'actions"
                onclick={(e) => {
                  e.stopPropagation(); // the window would close the menu right away
                  openMenu(e, menu, { free: true });
                }}><Icon name="options" /></button
              >
            </div>
          </li>
        {:else}
          {#if siteRows.length === 0}<li class="none">Aucune appli ne correspond.</li>{/if}
        {/each}
      </ul>
    {/if}
    {#if siteRows.length > 0}
      <section class="sites" data-testid="section-sites" aria-label="Sites">
        <h2 class="sites-title">Sites</h2>
        <ul>
          {#each siteRows as s (s.id)}
            <li data-testid="site-{s.id}" data-open={s.open}>
              <span class="icon">
                {#if s.icon}<img src={s.icon} alt="" width="16" height="16" />{:else}🌐{/if}
              </span>
              <div class="name">
                <b>{s.name}</b>
                <span>{s.domain ?? s.id}</span>
              </div>
              {#if s.error !== undefined}
                <span class="state" title={s.error}><span class="pill error"></span>Sans fiche</span>
              {:else}
                <span class="state"><span class="pill {s.open ? 'running' : 'stopped'}"></span>{s.open ? "Ouverte" : "Fermée"}</span>
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
                  <button data-testid="site-{s.id}-open" onclick={() => actSite(s, "open")}>Ouvrir</button>
                {/if}
                <button data-testid="site-{s.id}-edit" onclick={() => actSite(s, "edit")}>Modifier avec l'agent</button>
                <button data-testid="site-{s.id}-forget" onclick={() => (siteToForget = s)}>{FORGET_MEMORY}</button>
                <button data-testid="site-{s.id}-folder" onclick={() => actSite(s, "folder")}>Afficher le dossier</button>
                <button data-testid="site-{s.id}-review" onclick={() => actSite(s, "review")}>Relire</button>
                <button data-testid="site-{s.id}-delete" onclick={() => (siteToDelete = s)}>Supprimer</button>
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
      <p>{confirmForget(target.name)}</p>
      <div class="buttons">
        <button onclick={() => (siteToForget = null)}>Annuler</button>
        <button
          class="confirm"
          data-testid="confirm-site-forget"
          onclick={() => {
            const s = target;
            siteToForget = null;
            actSite(s, "forget");
          }}>Oublier</button
        >
      </div>
    </div>
  </div>
{/if}

{#if siteToDelete}
  {@const target = siteToDelete}
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="site-delete-confirmation">
      <p>{confirmSiteDeletion(target.name)}</p>
      <div class="buttons">
        <button onclick={() => (siteToDelete = null)}>Annuler</button>
        <button
          class="confirm"
          data-testid="confirm-site-delete"
          onclick={() => {
            const s = target;
            siteToDelete = null;
            actSite(s, "delete");
          }}>Supprimer</button
        >
      </div>
    </div>
  </div>
{/if}

{#if toDelete}
  {@const target = toDelete}
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="delete-confirmation">
      <p>Supprimer « {target.name} » ? Son dossier sera effacé.</p>
      <div class="buttons">
        <button onclick={() => (toDelete = null)}>Annuler</button>
        <button
          class="confirm"
          onclick={() => {
            const a = target; // {@const} is re-read: after toDelete = null, cible is null
            toDelete = null;
            act(a, "delete");
          }}>Supprimer</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .applications { display: grid; grid-template-columns: 190px 1fr; height: 100%; color: var(--text); }
  .pane { display: flex; flex-direction: column; gap: 2px; padding: 20px 10px 20px; background: var(--bg-bar); border-right: 1px solid var(--border); overflow-y: auto; }
  h2 { margin: 12px 8px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
  h2:first-child { margin-top: 0; }
  .pane button { all: unset; display: flex; justify-content: space-between; padding: 6px 8px; border-radius: 6px; }
  .pane button:hover { background: var(--bg-hover); }
  .pane button.active { background: var(--bg-active); }
  .n { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .main { min-width: 0; overflow-y: auto; padding: 20px 24px; }
  .search-box { display: flex; align-items: center; gap: 8px; padding: 0 10px; margin-bottom: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-bar); color: var(--text-muted); }
  .search-box:focus-within { border-color: var(--accent); }
  .search-box input { all: unset; flex: 1; padding: 8px 0; color: var(--text); }
  .banner { margin: 0 0 14px; padding: 8px 12px; border-radius: 8px; background: var(--bg-active); }
  .sites { margin-top: 24px; }
  .sites-title { margin: 0 0 6px; }
  .site-error { flex: 1; min-width: 0; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty, .none { color: var(--text-muted); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 10px 8px; border-bottom: 1px solid var(--border); }
  li.none { border: none; }
  .icon { width: 28px; height: 28px; flex: none; display: grid; place-content: center; border-radius: 7px; background: var(--bg-hover); color: var(--text-muted); }
  .name { flex: 1; min-width: 0; }
  .name b { display: block; font-weight: 600; }
  .name span { display: block; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { display: flex; align-items: center; gap: 6px; width: 170px; flex: none; font-size: 12px; white-space: nowrap; }
  .pill { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--stopped); }
  .pill.running { background: var(--running); }
  .pill.launching, .pill.preparing { background: var(--in-progress); }
  .pill.error { background: var(--in-error); }
  .actions { display: flex; gap: 6px; flex: none; }
  .actions button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-bar); color: var(--text); font-size: 12px; }
  .actions button:hover:not(:disabled) { background: var(--bg-hover); }
  .actions button:disabled { opacity: 0.5; }
  .veil { position: fixed; inset: 0; display: grid; place-content: center; background: rgb(0 0 0 / 0.35); z-index: 10; }
  .confirmation { padding: 16px 20px; border-radius: 10px; background: var(--bg-bar); border: 1px solid var(--border); color: var(--text); }
  .confirmation p { margin: 0 0 14px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .buttons .confirm { background: var(--accent); border-color: var(--accent); color: white; }
  .actions .options { display: grid; place-content: center; padding: 4px 6px; border-color: transparent; background: none; color: var(--text-muted); }
</style>
