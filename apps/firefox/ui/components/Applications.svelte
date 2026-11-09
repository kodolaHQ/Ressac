<script lang="ts">
  import type { ActionApplication, ApplicationShown, ApplicationList } from "../../shared/api";
  import { confirmForget, confirmSiteDeletion, FORGET_MEMORY, type ActionSite, type ShownSite } from "../../shared/sites";
  import { api } from "../state.svelte";
  import Icon from "./Icon.svelte";
  import ExternalProjects from "./ExternalProjects.svelte";
  import { openMenu, type MenuEntry } from "./menu.svelte";

  type Filter = "tout" | "application" | "poc" | "sans-fiche" | "en-marche" | "arretee" | "erreur";

  /** Running in the panel's sense: everything that is neither stopped nor in error. */
  const active = (a: ApplicationShown) => a.etat === "en-marche" || a.etat === "lancement" || a.etat === "preparation";
  const FILTERS: Record<Filter, (a: ApplicationShown) => boolean> = {
    tout: () => true,
    application: (a) => a.type === "application",
    poc: (a) => a.type === "poc",
    "sans-fiche": (a) => a.type === "sans-fiche",
    "en-marche": active,
    arretee: (a) => a.etat === "arretee",
    erreur: (a) => a.etat === "erreur",
  };
  /** « Sans fiche » and « En erreur » only appear if they hold at least one project. */
  const GROUPS: { titre: string; filtres: { id: Filter; libelle: string; siPresent?: boolean }[] }[] = [
    {
      titre: "Type",
      filtres: [
        { id: "tout", libelle: "Tout" },
        { id: "application", libelle: "Applications" },
        { id: "poc", libelle: "POC et tests" },
        { id: "sans-fiche", libelle: "Sans fiche", siPresent: true },
      ],
    },
    {
      titre: "État",
      filtres: [
        { id: "en-marche", libelle: "En marche" },
        { id: "arretee", libelle: "Arrêtées" },
        { id: "erreur", libelle: "En erreur", siPresent: true },
      ],
    },
  ];

  let data = $state<ApplicationList>({ atelier: "ok", applications: [] });
  let chargee = $state(false);
  let filter = $state<Filter>("tout");
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
    const r = await api.sites.liste();
    if (n === sitesRequest) sites = r;
  }

  $effect(() => {
    void loadSites();
    return api.sites.surChange(() => void loadSites());
  });

  const actSite = (s: ShownSite, action: ActionSite) => api.sites.agir(s.id, action);
  const lignesSites = $derived.by(() => {
    const searches = text.trim().toLowerCase();
    return sites.filter((s) => !searches || [s.nom, s.id, s.domaine ?? "", s.description].some((x) => x.toLowerCase().includes(searches)));
  });

  async function load() {
    const n = ++request;
    const r = await api.applications.liste();
    if (n !== request) return;
    data = r;
    chargee = true;
  }

  $effect(() => {
    void load();
    return api.applications.surChange(() => void load());
  });
  $effect(() => field.focus());

  const account = (f: Filter) => data.applications.filter(FILTERS[f]).length;
  // A filter that disappears from the panel (no app in error anymore…) gives way to Tout.
  const effectiveFilter = $derived(GROUPS.flatMap((g) => g.filtres).some((x) => x.id === filter && (!x.siPresent || account(x.id) > 0)) ? filter : "tout");

  /** Running first, then the most recent last launch, then the most recent creation. */
  const lignes = $derived.by(() => {
    const searches = text.trim().toLowerCase();
    return data.applications
      .filter(FILTERS[effectiveFilter])
      .filter((a) => !searches || [a.nom, a.dossier, a.origine ?? ""].some((x) => x.toLowerCase().includes(searches)))
      .sort(
        (a, b) =>
          Number(active(b)) - Number(active(a)) ||
          (b.dernierLancement ?? "").localeCompare(a.dernierLancement ?? "") ||
          b.creeLe.localeCompare(a.creeLe),
      );
  });

  const withoutDocker = $derived(data.atelier === "docker-absent");

  const TYPES = { application: "Application", poc: "POC", "sans-fiche": "Sans fiche" } as const;
  const STATES = {
    arretee: "Arrêtée",
    preparation: "Préparation de l'atelier…",
    lancement: "Lancement…",
    "en-marche": "En marche",
    erreur: "En erreur",
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
    if (a.origine) chunks.push(`depuis ${a.origine.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}`);
    chunks.push(a.port !== undefined && active(a) ? `port ${a.port}` : when(a.creeLe));
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

  const act = (a: ApplicationShown, action: ActionApplication) => api.applications.agir(a.dossier, action);

  /** Visible buttons and ⋯ menu entries depending on the state (spec §5). */
  function actions(a: ApplicationShown): { boutons: { libelle: string; action: ActionApplication; lance?: boolean }[]; menu: MenuEntry[] } {
    const entry = (label: string, action: ActionApplication): MenuEntry => ({
      libelle: label,
      agir: () => (action === "supprimer" ? (toDelete = a) : act(a, action)),
    });
    const promote = a.type === "poc" ? [entry("Passer en application", "promouvoir")] : [];
    if (a.type === "sans-fiche") return { boutons: [{ libelle: "Déboguer", action: "deboguer" }], menu: [entry("Supprimer", "supprimer")] };
    switch (a.etat) {
      case "preparation":
      case "lancement":
        return { boutons: [{ libelle: "Arrêter", action: "arreter" }], menu: [entry("Déboguer", "deboguer"), entry("Relire", "relire")] };
      case "en-marche":
        return {
          boutons: [
            { libelle: "Ouvrir", action: "ouvrir" },
            { libelle: "Arrêter", action: "arreter" },
          ],
          menu: [entry("Relancer", "relancer"), entry("Déboguer", "deboguer"), entry("Relire", "relire")],
        };
      case "erreur":
        return {
          boutons: [
            { libelle: "Relancer", action: "relancer", lance: true },
            { libelle: "Déboguer", action: "deboguer" },
            { libelle: "Relire", action: "relire" },
          ],
          menu: [entry("Supprimer", "supprimer"), ...promote],
        };
      case "arretee":
        return {
          boutons: [
            { libelle: "Lancer", action: "lancer", lance: true },
            { libelle: "Déboguer", action: "deboguer" },
            { libelle: "Relire", action: "relire" },
          ],
          menu: [entry("Supprimer", "supprimer"), ...promote, entry("Afficher le dossier", "dossier")],
        };
    }
  }
</script>

<section class="applications" data-testid="page-applications" aria-label="Applications">
  <nav class="volet" aria-label="Filtres">
    {#each GROUPS as g (g.titre)}
      <h2>{g.titre}</h2>
      {#each g.filtres.filter((x) => !x.siPresent || account(x.id) > 0) as x (x.id)}
        <button data-testid="filtre-{x.id}" class:actif={effectiveFilter === x.id} aria-pressed={effectiveFilter === x.id} onclick={() => (filter = x.id)}
          >{x.libelle} <span class="n">{account(x.id)}</span></button
        >
      {/each}
    {/each}
  </nav>
  <div class="principal">
    <label class="recherche">
      <Icon nom="chercher" taille={14} />
      <input bind:this={field} bind:value={text} type="search" data-testid="recherche-applications" placeholder="Chercher une appli…" spellcheck="false" />
    </label>
    {#if withoutDocker}
      <p class="bandeau" role="status">Docker n'est pas lancé. La liste reste visible, mais aucune appli ne peut être lancée.</p>
    {/if}
    {#if chargee && data.applications.length === 0 && sites.length === 0}
      <p class="vide">Rien ici pour l'instant. Demande à l'agent de tester un package ou de construire une app.</p>
    {:else}
      <ul>
        {#each lignes as a (a.dossier)}
          {@const { boutons: buttons, menu } = actions(a)}
          <li data-testid="appli-{a.dossier}" data-etat={a.etat}>
            <span class="icone">
              {#if a.favicon}<img src={a.favicon} alt="" width="16" height="16" />{:else}✦{/if}
            </span>
            <div class="nom">
              <b>{a.nom}</b>
              <span>{details(a)}</span>
            </div>
            {#if a.type === "sans-fiche"}
              <span class="etat" title={short(a.sansFiche)}><span class="pastille arretee"></span>Sans fiche</span>
            {:else}
              <span class="etat" title={short(a.erreur)}><span class="pastille {a.etat}"></span>{STATES[a.etat]}</span>
            {/if}
            <div class="actions">
              {#each buttons as b (b.action)}
                <button disabled={b.lance && withoutDocker} onclick={() => act(a, b.action)}>{b.libelle}</button>
              {/each}
              <button
                class="options"
                aria-label="Plus d'actions"
                title="Plus d'actions"
                onclick={(e) => {
                  e.stopPropagation(); // the window would close the menu right away
                  openMenu(e, menu, { libre: true });
                }}><Icon nom="options" /></button
              >
            </div>
          </li>
        {:else}
          {#if lignesSites.length === 0}<li class="aucune">Aucune appli ne correspond.</li>{/if}
        {/each}
      </ul>
    {/if}
    {#if lignesSites.length > 0}
      <section class="sites" data-testid="section-sites" aria-label="Sites">
        <h2 class="titre-sites">Sites</h2>
        <ul>
          {#each lignesSites as s (s.id)}
            <li data-testid="site-{s.id}" data-ouverte={s.ouverte}>
              <span class="icone">
                {#if s.icone}<img src={s.icone} alt="" width="16" height="16" />{:else}🌐{/if}
              </span>
              <div class="nom">
                <b>{s.nom}</b>
                <span>{s.domaine ?? s.id}</span>
              </div>
              {#if s.erreur !== undefined}
                <span class="etat" title={s.erreur}><span class="pastille erreur"></span>Sans fiche</span>
              {:else}
                <span class="etat"><span class="pastille {s.ouverte ? 'en-marche' : 'arretee'}"></span>{s.ouverte ? "Ouverte" : "Fermée"}</span>
              {/if}
              {#if s.erreur !== undefined}
                <span class="erreur-site" data-testid="site-{s.id}-erreur">{s.erreur}</span>
              {/if}
              {#if s.erreurAction}
                <span class="erreur-site" data-testid="site-{s.id}-erreur-action" role="alert">{s.erreurAction}</span>
              {/if}
              {#if !s.sansActions}
              <div class="actions">
                {#if s.erreur === undefined}
                  <button data-testid="site-{s.id}-ouvrir" onclick={() => actSite(s, "ouvrir")}>Ouvrir</button>
                {/if}
                <button data-testid="site-{s.id}-modifier" onclick={() => actSite(s, "modifier")}>Modifier avec l'agent</button>
                <button data-testid="site-{s.id}-oublier" onclick={() => (siteToForget = s)}>{FORGET_MEMORY}</button>
                <button data-testid="site-{s.id}-dossier" onclick={() => actSite(s, "dossier")}>Afficher le dossier</button>
                <button data-testid="site-{s.id}-relire" onclick={() => actSite(s, "relire")}>Relire</button>
                <button data-testid="site-{s.id}-supprimer" onclick={() => (siteToDelete = s)}>Supprimer</button>
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
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-oubli-site">
      <p>{confirmForget(target.nom)}</p>
      <div class="boutons">
        <button onclick={() => (siteToForget = null)}>Annuler</button>
        <button
          class="confirmer"
          data-testid="confirmer-oubli-site"
          onclick={() => {
            const s = target;
            siteToForget = null;
            actSite(s, "oublier");
          }}>Oublier</button
        >
      </div>
    </div>
  </div>
{/if}

{#if siteToDelete}
  {@const target = siteToDelete}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-suppression-site">
      <p>{confirmSiteDeletion(target.nom)}</p>
      <div class="boutons">
        <button onclick={() => (siteToDelete = null)}>Annuler</button>
        <button
          class="confirmer"
          data-testid="confirmer-suppression-site"
          onclick={() => {
            const s = target;
            siteToDelete = null;
            actSite(s, "supprimer");
          }}>Supprimer</button
        >
      </div>
    </div>
  </div>
{/if}

{#if toDelete}
  {@const target = toDelete}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-suppression">
      <p>Supprimer « {target.nom} » ? Son dossier sera effacé.</p>
      <div class="boutons">
        <button onclick={() => (toDelete = null)}>Annuler</button>
        <button
          class="confirmer"
          onclick={() => {
            const a = target; // {@const} is re-read: after aSupprimer = null, cible is null
            toDelete = null;
            act(a, "supprimer");
          }}>Supprimer</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .applications { display: grid; grid-template-columns: 190px 1fr; height: 100%; color: var(--texte); }
  .volet { display: flex; flex-direction: column; gap: 2px; padding: 20px 10px 20px; background: var(--fond-barre); border-right: 1px solid var(--bord); overflow-y: auto; }
  h2 { margin: 12px 8px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--texte-doux); }
  h2:first-child { margin-top: 0; }
  .volet button { all: unset; display: flex; justify-content: space-between; padding: 6px 8px; border-radius: 6px; }
  .volet button:hover { background: var(--fond-survol); }
  .volet button.actif { background: var(--fond-actif); }
  .n { color: var(--texte-doux); font-variant-numeric: tabular-nums; }
  .principal { min-width: 0; overflow-y: auto; padding: 20px 24px; }
  .recherche { display: flex; align-items: center; gap: 8px; padding: 0 10px; margin-bottom: 14px; border: 1px solid var(--bord); border-radius: 8px; background: var(--fond-barre); color: var(--texte-doux); }
  .recherche:focus-within { border-color: var(--accent); }
  .recherche input { all: unset; flex: 1; padding: 8px 0; color: var(--texte); }
  .bandeau { margin: 0 0 14px; padding: 8px 12px; border-radius: 8px; background: var(--fond-actif); }
  .sites { margin-top: 24px; }
  .titre-sites { margin: 0 0 6px; }
  .erreur-site { flex: 1; min-width: 0; font-size: 12px; color: var(--texte-doux); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vide, .aucune { color: var(--texte-doux); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 10px 8px; border-bottom: 1px solid var(--bord); }
  li.aucune { border: none; }
  .icone { width: 28px; height: 28px; flex: none; display: grid; place-content: center; border-radius: 7px; background: var(--fond-survol); color: var(--texte-doux); }
  .nom { flex: 1; min-width: 0; }
  .nom b { display: block; font-weight: 600; }
  .nom span { display: block; font-size: 12px; color: var(--texte-doux); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .etat { display: flex; align-items: center; gap: 6px; width: 170px; flex: none; font-size: 12px; white-space: nowrap; }
  .pastille { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--arretee); }
  .pastille.en-marche { background: var(--en-marche); }
  .pastille.lancement, .pastille.preparation { background: var(--en-cours); }
  .pastille.erreur { background: var(--en-erreur); }
  .actions { display: flex; gap: 6px; flex: none; }
  .actions button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  .actions button:hover:not(:disabled) { background: var(--fond-survol); }
  .actions button:disabled { opacity: 0.5; }
  .voile { position: fixed; inset: 0; display: grid; place-content: center; background: rgb(0 0 0 / 0.35); z-index: 10; }
  .confirmation { padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); }
  .confirmation p { margin: 0 0 14px; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .confirmer { background: var(--accent); border-color: var(--accent); color: white; }
  .actions .options { display: grid; place-content: center; padding: 4px 6px; border-color: transparent; background: none; color: var(--texte-doux); }
</style>
