<script lang="ts">
  import type { ActionApplication, ApplicationAffichee, ListeApplications } from "../../commun/api";
  import { api } from "../etat.svelte";
  import Icone from "./Icone.svelte";
  import { ouvrirMenu, type EntreeMenu } from "./menu.svelte";

  type Filtre = "tout" | "application" | "poc" | "sans-fiche" | "en-marche" | "arretee" | "erreur";

  /** En marche au sens du volet : tout ce qui n'est ni arrêté ni en erreur. */
  const active = (a: ApplicationAffichee) => a.etat === "en-marche" || a.etat === "lancement" || a.etat === "preparation";
  const FILTRES: Record<Filtre, (a: ApplicationAffichee) => boolean> = {
    tout: () => true,
    application: (a) => a.type === "application",
    poc: (a) => a.type === "poc",
    "sans-fiche": (a) => a.type === "sans-fiche",
    "en-marche": active,
    arretee: (a) => a.etat === "arretee",
    erreur: (a) => a.etat === "erreur",
  };
  /** « Sans fiche » et « En erreur » n'apparaissent que s'ils comptent au moins un projet. */
  const GROUPES: { titre: string; filtres: { id: Filtre; libelle: string; siPresent?: boolean }[] }[] = [
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

  let donnees = $state<ListeApplications>({ atelier: "ok", applications: [] });
  let chargee = $state(false);
  let filtre = $state<Filtre>("tout");
  let texte = $state("");
  let champ: HTMLInputElement;
  let requete = 0;

  async function charger() {
    const n = ++requete;
    const r = await api.applications.liste();
    if (n !== requete) return;
    donnees = r;
    chargee = true;
  }

  $effect(() => {
    void charger();
    return api.applications.surChange(() => void charger());
  });
  $effect(() => champ.focus());

  const compte = (f: Filtre) => donnees.applications.filter(FILTRES[f]).length;
  // Un filtre qui disparaît du volet (plus aucune appli en erreur…) laisse la place à Tout.
  const filtreEffectif = $derived(GROUPES.flatMap((g) => g.filtres).some((x) => x.id === filtre && (!x.siPresent || compte(x.id) > 0)) ? filtre : "tout");

  /** En marche d'abord, puis le dernier lancement le plus récent, puis la création la plus récente. */
  const lignes = $derived.by(() => {
    const cherche = texte.trim().toLowerCase();
    return donnees.applications
      .filter(FILTRES[filtreEffectif])
      .filter((a) => !cherche || [a.nom, a.dossier, a.origine ?? ""].some((x) => x.toLowerCase().includes(cherche)))
      .sort(
        (a, b) =>
          Number(active(b)) - Number(active(a)) ||
          (b.dernierLancement ?? "").localeCompare(a.dernierLancement ?? "") ||
          b.creeLe.localeCompare(a.creeLe),
      );
  });

  const sansDocker = $derived(donnees.atelier === "docker-absent");

  const TYPES = { application: "Application", poc: "POC", "sans-fiche": "Sans fiche" } as const;
  const ETATS = {
    arretee: "Arrêtée",
    preparation: "Préparation de l'atelier…",
    lancement: "Lancement…",
    "en-marche": "En marche",
    erreur: "En erreur",
  } as const;

  /** « hier », « il y a 3 j », « 22 oct. » */
  function quand(iso: string): string {
    const d = new Date(iso);
    const jour = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ecart = Math.round((jour(new Date()) - jour(d)) / 86_400_000);
    if (ecart <= 0) return "aujourd'hui";
    if (ecart === 1) return "hier";
    if (ecart < 7) return `il y a ${ecart} j`;
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  }

  function details(a: ApplicationAffichee): string {
    const morceaux: string[] = [TYPES[a.type]];
    if (a.origine) morceaux.push(`depuis ${a.origine.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}`);
    morceaux.push(a.port !== undefined && active(a) ? `port ${a.port}` : quand(a.creeLe));
    return morceaux.join(" · ");
  }

  /**
   * Première ligne d'une raison ou d'une erreur, pour une bulle d'aide. Un manifeste refusé par zod porte la liste
   * des problèmes en JSON sur plusieurs lignes : on garde le premier.
   */
  function court(raison: string | undefined): string | undefined {
    if (!raison) return undefined;
    const m = /^(webaios\.json invalide : )(\[[\s\S]*)$/.exec(raison);
    if (m) {
      try {
        const [p] = JSON.parse(m[2]!) as { path?: (string | number)[]; message?: string }[];
        if (p?.message) return `${m[1]}${p.path?.length ? `${p.path.join(".")} : ` : ""}${p.message}`;
      } catch {
        // Pas du JSON : première ligne.
      }
    }
    return raison.split("\n")[0];
  }

  const agir = (a: ApplicationAffichee, action: ActionApplication) => api.applications.agir(a.dossier, action);

  /** Boutons visibles et entrées du menu ⋯ selon l'état (spec §5). */
  function actions(a: ApplicationAffichee): { boutons: { libelle: string; action: ActionApplication; lance?: boolean }[]; menu: EntreeMenu[] } {
    const entree = (libelle: string, action: ActionApplication): EntreeMenu => ({ libelle, agir: () => agir(a, action) });
    const promouvoir = a.type === "poc" ? [entree("Passer en application", "promouvoir")] : [];
    if (a.type === "sans-fiche") return { boutons: [{ libelle: "Déboguer", action: "deboguer" }], menu: [entree("Supprimer", "supprimer")] };
    switch (a.etat) {
      case "preparation":
      case "lancement":
        return { boutons: [{ libelle: "Arrêter", action: "arreter" }], menu: [entree("Déboguer", "deboguer")] };
      case "en-marche":
        return {
          boutons: [
            { libelle: "Ouvrir", action: "ouvrir" },
            { libelle: "Arrêter", action: "arreter" },
          ],
          menu: [entree("Relancer", "relancer"), entree("Déboguer", "deboguer")],
        };
      case "erreur":
        return {
          boutons: [
            { libelle: "Relancer", action: "relancer", lance: true },
            { libelle: "Déboguer", action: "deboguer" },
          ],
          menu: [entree("Supprimer", "supprimer"), ...promouvoir],
        };
      case "arretee":
        return {
          boutons: [
            { libelle: "Lancer", action: "lancer", lance: true },
            { libelle: "Déboguer", action: "deboguer" },
          ],
          menu: [entree("Supprimer", "supprimer"), ...promouvoir, entree("Afficher le dossier", "dossier")],
        };
    }
  }
</script>

<section class="applications" data-testid="page-applications" aria-label="Applications">
  <nav class="volet" aria-label="Filtres">
    {#each GROUPES as g (g.titre)}
      <h2>{g.titre}</h2>
      {#each g.filtres.filter((x) => !x.siPresent || compte(x.id) > 0) as x (x.id)}
        <button data-testid="filtre-{x.id}" class:actif={filtreEffectif === x.id} aria-pressed={filtreEffectif === x.id} onclick={() => (filtre = x.id)}
          >{x.libelle} <span class="n">{compte(x.id)}</span></button
        >
      {/each}
    {/each}
  </nav>
  <div class="principal">
    <label class="recherche">
      <Icone nom="chercher" taille={14} />
      <input bind:this={champ} bind:value={texte} type="search" data-testid="recherche-applications" placeholder="Chercher une appli…" spellcheck="false" />
    </label>
    {#if sansDocker}
      <p class="bandeau" role="status">Docker n'est pas lancé. La liste reste visible, mais aucune appli ne peut être lancée.</p>
    {/if}
    {#if chargee && donnees.applications.length === 0}
      <p class="vide">Rien ici pour l'instant. Demande à l'agent de tester un package ou de construire une app.</p>
    {:else}
      <ul>
        {#each lignes as a (a.dossier)}
          {@const { boutons, menu } = actions(a)}
          <li data-testid="appli-{a.dossier}" data-etat={a.etat}>
            <span class="icone">
              {#if a.favicon}<img src={a.favicon} alt="" width="16" height="16" />{:else}✦{/if}
            </span>
            <div class="nom">
              <b>{a.nom}</b>
              <span>{details(a)}</span>
            </div>
            {#if a.type === "sans-fiche"}
              <span class="etat" title={court(a.sansFiche)}><span class="pastille arretee"></span>Sans fiche</span>
            {:else}
              <span class="etat" title={court(a.erreur)}><span class="pastille {a.etat}"></span>{ETATS[a.etat]}</span>
            {/if}
            <div class="actions">
              {#each boutons as b (b.action)}
                <button disabled={b.lance && sansDocker} onclick={() => agir(a, b.action)}>{b.libelle}</button>
              {/each}
              <button
                class="options"
                aria-label="Plus d'actions"
                title="Plus d'actions"
                onclick={(e) => {
                  e.stopPropagation(); // la fenêtre refermerait aussitôt le menu
                  ouvrirMenu(e, menu, { libre: true });
                }}><Icone nom="options" /></button
              >
            </div>
          </li>
        {:else}
          <li class="aucune">Aucune appli ne correspond.</li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .applications { display: grid; grid-template-columns: 190px 1fr; height: 100%; color: var(--texte); }
  .volet { display: flex; flex-direction: column; gap: 2px; padding: 20px 10px; background: var(--fond-barre); border-right: 1px solid var(--bord); overflow-y: auto; }
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
  .actions .options { display: grid; place-content: center; padding: 4px 6px; border-color: transparent; background: none; color: var(--texte-doux); }
</style>
