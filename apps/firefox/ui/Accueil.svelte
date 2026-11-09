<script lang="ts">
  import type { WidgetAffiche } from "../shared/api";
  import type { PlacementLibre } from "../../../packages/noyau/src/accueil/schemas";
  import type { ThemeAccueil } from "../../../packages/noyau/src/accueil/theme";
  import { api } from "../ui/etat.svelte";
  import CarteAccordCompte from "./CarteAccordCompte.svelte";
  import WidgetAccueil from "./WidgetAccueil.svelte";
  import { deplacerLibre, guidesLibres, LARGEUR_LIBRE, redimensionnerLibre, taillesLibres } from "./grille-libre";
  import { variablesTheme } from "./theme";

  /** Délai au-delà duquel une action sans aucun changement de la page est signalée (service des widgets absent…). */
  const DELAI_SANS_EFFET_MS = 6000;
  const SANS_EFFET = "Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?).";
  // Un widget illisible n'a pas de tailles déclarées : il peut prendre la place qu'il veut.
  const TAILLES_LIBRES = { min: { l: 1, h: 1 }, max: { l: LARGEUR_LIBRE, h: 1000 } };

  // Remplacée d'un bloc à chaque lecture : pas de proxy profond (les données partent telles quelles vers les cadres).
  let widgets = $state.raw<WidgetAffiche[]>([]);
  let theme = $state.raw<ThemeAccueil | null>(null);
  /** La première lecture est passée : l'écran vide ne clignote pas avant elle. */
  let charge = $state(false);
  // Lectures qui se croisent (rafale de changements) : seule la dernière compte.
  let derniere = 0;
  function charger() {
    const n = ++derniere;
    api.accueil.lire().then(
      ({ widgets: lus, theme: lu }) => {
        if (n !== derniere) return;
        widgets = lus;
        theme = lu;
        charge = true;
        verifierAttentes();
      },
      () => {},
    );
  }
  $effect(() => {
    charger();
    return api.accueil.surChange(charger);
  });

  // Le thème validé par le noyau ne touche que la racine de l'accueil, pas la barre latérale ni l'agent.
  const styleTheme = $derived(
    Object.entries(variablesTheme(theme))
      .map(([cle, valeur]) => `${cle}: ${valeur}`)
      .join("; "),
  );

  /**
   * Actions envoyées sans réponse possible (accorder, mettre à jour) : un avertissement si l'état de CE widget ne bouge
   * pas. Seul un changement de ce widget (état, données, ou son retrait) lève l'attente et l'avertissement.
   */
  const attentes = new Map<string, { signature: string; minuterie: ReturnType<typeof setTimeout> }>();
  let avertissements = $state<Record<string, string>>({});
  const signature = (id: string) => {
    const w = widgets.find((x) => x.id === id);
    return !w ? "absent" : "erreur" in w ? `illisible:${w.erreur}` : JSON.stringify([w.etat, w.donnees !== null]);
  };
  function sansAvertissement(id: string) {
    if (!(id in avertissements)) return;
    const { [id]: _, ...reste } = avertissements;
    avertissements = reste;
  }
  function agir(id: string, action: () => void) {
    clearTimeout(attentes.get(id)?.minuterie);
    sansAvertissement(id);
    action();
    // L'attente reste après l'avertissement : c'est le changement du widget qui les lève tous deux.
    const minuterie = setTimeout(() => (avertissements = { ...avertissements, [id]: SANS_EFFET }), DELAI_SANS_EFFET_MS);
    attentes.set(id, { signature: signature(id), minuterie });
  }
  function verifierAttentes() {
    for (const [id, a] of attentes) {
      if (signature(id) === a.signature) continue;
      clearTimeout(a.minuterie);
      attentes.delete(id);
      sansAvertissement(id);
    }
  }
  $effect(() => () => {
    for (const a of attentes.values()) clearTimeout(a.minuterie);
  });

  /** Widgets dont l'utilisateur a refusé la lecture avec son compte, pendant cette session de la page. */
  let refuses = $state<Record<string, true>>({});
  let aRetirer = $state<WidgetAffiche | null>(null);
  let accordPour = $state<Extract<WidgetAffiche, { compte: string[] }> | null>(null);
  const nom = (w: WidgetAffiche) => ("nom" in w ? w.nom : w.id);

  // Glisser et redimensionner : un aperçu libre en direct, puis la disposition envoyée au relâchement.
  let largeurPx = $state(0);
  let geste: { id: string; mode: "deplacer" | "taille"; x0: number; y0: number; depart: PlacementLibre[]; p0: PlacementLibre; tailles: { min: { l: number; h: number }; max: { l: number; h: number } } } | null =
    null;
  let enGeste = $state(false);
  let apercu = $state.raw<PlacementLibre[] | null>(null);
  let guides = $state.raw<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const placements = $derived(new Map((apercu ?? widgets.map((w) => w.placement)).map((p) => [p.id, p])));
  const hauteur = $derived(Math.max(0, ...[...placements.values()].map((p) => p.y + p.h)));

  function commencer(w: WidgetAffiche, mode: "deplacer" | "taille", e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const depart = widgets.map((x) => x.placement);
    const p0 = depart.find((p) => p.id === w.id);
    if (!p0) return;
    geste = {
      id: w.id,
      mode,
      x0: e.clientX,
      y0: e.clientY,
      depart,
      p0,
      tailles: "tailles" in w ? { min: taillesLibres(w.tailles.min), max: taillesLibres(w.tailles.max) } : TAILLES_LIBRES,
    };
    enGeste = true;
    apercu = depart;
    guides = { x: [], y: [] };
  }
  function bouger(e: PointerEvent) {
    const g = geste;
    if (!g) return;
    // Millièmes de la largeur pour x/l, pixels pour y/h.
    const dx = largeurPx > 0 ? ((e.clientX - g.x0) / largeurPx) * LARGEUR_LIBRE : 0;
    const dy = e.clientY - g.y0;
    const autres = g.depart.filter((q) => q.id !== g.id);
    const p = g.mode === "deplacer"
      ? deplacerLibre({ p: g.p0, x: g.p0.x + dx, y: g.p0.y + dy, autres, largeurPx })
      : redimensionnerLibre({ p: g.p0, l: g.p0.l + dx, h: g.p0.h + dy, min: g.tailles.min, max: g.tailles.max, autres });
    apercu = g.depart.map((q) => (q.id === g.id ? p : q));
    guides = guidesLibres({ p, autres, largeurPx });
  }
  function finir(annule: boolean) {
    if (!geste) return;
    const { depart } = geste;
    const final = apercu;
    geste = null;
    enGeste = false;
    apercu = null;
    guides = { x: [], y: [] };
    if (annule || !final) return;
    const change = final.some((p, i) => {
      const a = depart[i]!;
      return p.x !== a.x || p.y !== a.y || p.l !== a.l || p.h !== a.h;
    });
    if (!change) return;
    // Tout de suite à l'écran ; la surveillance du dossier confirmera.
    const parId = new Map(final.map((p) => [p.id, p]));
    widgets = widgets.map((w) => ({ ...w, placement: parId.get(w.id) ?? w.placement }));
    api.accueil.placer(final);
  }
</script>

<svelte:window onpointermove={bouger} onpointerup={() => finir(false)} onpointercancel={() => finir(true)} />

<section class="accueil" style={styleTheme} data-testid="accueil" data-theme={theme ? "agent" : "defaut"}>
  {#if widgets.length}
    <div class="grille" class:geste={enGeste} bind:clientWidth={largeurPx} style:height="{hauteur}px">
      {#each widgets as widget (widget.id)}
        {@const p = placements.get(widget.id) ?? widget.placement}
        <div
          class="case"
          style:left="{p.x / 10}%"
          style:top="{p.y}px"
          style:width="{p.l / 10}%"
          style:height="{p.h}px"
        >
          <WidgetAccueil
            {widget}
            placement={p}
            geste={enGeste}
            avertissement={avertissements[widget.id] ?? null}
            refuse={!!refuses[widget.id]}
            commencer={(mode, e) => commencer(widget, mode, e)}
            retirer={() => (aRetirer = widget)}
            autoriser={() => "compte" in widget && (accordPour = widget)}
            refuser={() => {
              // Pas d'attente : après un refus, le noyau réécrit le même état « accord-requis », rien ne changerait à l'écran.
              refuses = { ...refuses, [widget.id]: true };
              api.accueil.refuserAccord(widget.id);
            }}
            recolter={() => agir(widget.id, () => api.accueil.recolter(widget.id))}
            voirWorkflow={() => "nom" in widget && api.agir({ type: "ouvrirWorkflow", fenetreId: api.fenetreId, id: widget.id, nom: widget.nom })}
          />
        </div>
      {/each}
      {#each guides.x as x (x)}
        <div class="guide guide-x" data-testid="guide-x" style:left="{x}px"></div>
      {/each}
      {#each guides.y as y (y)}
        <div class="guide guide-y" data-testid="guide-y" style:top="{y}px"></div>
      {/each}
    </div>
  {:else if charge}
    <p class="vide" data-testid="accueil-vide">Aucun widget pour l'instant. Demande à l'agent de créer le premier.</p>
  {/if}
</section>

{#if accordPour}
  {@const cible = accordPour}
  <CarteAccordCompte
    sujet="widget"
    profilsPourAccord={api.accueil.profilsPourAccord}
    nom={cible.nom}
    domaines={cible.compte}
    publiques={cible.publiques}
    fermer={() => (accordPour = null)}
    autoriser={(profil) => {
      // {@const} se relit : après accordPour = null, cible vaut null. L'accord porte exactement sur ce qui a été montré.
      const { id, compte, publiques } = cible;
      accordPour = null;
      const { [id]: _, ...reste } = refuses;
      refuses = reste;
      agir(id, () =>
        api.accueil.accorder({ id, profil, compte: [...compte], publiques: [...publiques] }).then(
          (r) => {
            if (r.ok) return;
            // Refusé (la demande a changé entre-temps…) : rien n'est accordé, le bandeau montre la nouvelle demande.
            clearTimeout(attentes.get(id)?.minuterie);
            attentes.delete(id);
            avertissements = { ...avertissements, [id]: `Accord non enregistré : ${r.erreur}` };
            charger();
          },
          () => {},
        ),
      );
    }}
  />
{/if}

{#if aRetirer}
  {@const cible = aRetirer}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-retrait">
      <p>Retirer « {nom(cible)} » de la page d'accueil ?</p>
      <div class="boutons">
        <button onclick={() => (aRetirer = null)}>Annuler</button>
        <button
          class="principal"
          onclick={() => {
            const id = cible.id; // {@const} se relit : après aRetirer = null, cible vaut null
            aRetirer = null;
            widgets = widgets.filter((w) => w.id !== id);
            api.accueil.retirer(id);
          }}>Retirer</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  /* Les variables du thème de l'agent, posées sur cette racine seulement ; sans thème, celles de l'application. */
  .accueil {
    --accueil-fond: var(--fond);
    --accueil-carte: var(--fond-barre);
    --accueil-texte: var(--texte);
    --accueil-texte-doux: var(--texte-doux);
    --accueil-accent: var(--accent);
    --accueil-bord: var(--bord);
    --accueil-rayon: 12px;
    --accueil-espace: 12px;
    --accueil-police: inherit;
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    padding: 16px;
    background: var(--accueil-fond);
    color: var(--accueil-texte);
    font-family: var(--accueil-police);
  }
  /* Placement libre : left/largeur en millièmes de la largeur, top/hauteur en pixels. */
  .grille { position: relative; }
  .case { position: absolute; padding: calc(var(--accueil-espace) / 2); box-sizing: border-box; }
  .grille.geste { user-select: none; }
  /* Pendant un geste, les cadres des widgets ne doivent pas capter la souris. */
  .grille.geste :global(iframe) { pointer-events: none; }
  .guide { position: absolute; z-index: 4; pointer-events: none; background: var(--accueil-accent); opacity: 0.6; }
  .guide-x { top: 0; bottom: 0; width: 1px; }
  .guide-y { left: 0; right: 0; height: 1px; }
  .vide { margin: 24px 0; text-align: center; font-size: 13px; color: var(--accueil-texte-doux); }
  .voile { position: fixed; inset: 0; display: grid; place-content: center; background: rgb(0 0 0 / 0.35); z-index: 10; }
  .confirmation { padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); }
  .confirmation p { margin: 0 0 14px; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .principal { background: var(--accent); border-color: var(--accent); color: white; }
</style>
