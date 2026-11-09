<script lang="ts">
  import type { ShownWidget } from "../shared/api";
  import type { FreePlacement } from "../../../packages/noyau/src/accueil/schemas";
  import type { HomeTheme } from "../../../packages/noyau/src/accueil/theme";
  import { api } from "../ui/etat.svelte";
  import AccountGrantCard from "./CarteAccordCompte.svelte";
  import HomeWidget from "./WidgetAccueil.svelte";
  import { moveFree, freeGuides, FREE_WIDTH, resizeFree, freeSizes } from "./grille-libre";
  import { variablesTheme } from "./theme";

  /** How long an action may leave the page unchanged before a warning shows (widget service missing…). */
  const NO_EFFECT_DELAY_MS = 6000;
  const NO_EFFECT = "Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?).";
  // An unreadable widget has no declared sizes: it may take whatever room it wants.
  const FREE_SIZES = { min: { l: 1, h: 1 }, max: { l: FREE_WIDTH, h: 1000 } };

  // Replaced as a whole on each read: no deep proxy (the data goes to the frames as is).
  let widgets = $state.raw<ShownWidget[]>([]);
  let theme = $state.raw<HomeTheme | null>(null);
  /** The first read is done: the empty screen does not flash before it. */
  let charge = $state(false);
  // Overlapping reads (burst of changes): only the last one counts.
  let last = 0;
  function charger() {
    const n = ++last;
    api.accueil.lire().then(
      ({ widgets: lus, theme: lu }) => {
        if (n !== last) return;
        widgets = lus;
        theme = lu;
        charge = true;
        checkPending();
      },
      () => {},
    );
  }
  $effect(() => {
    charger();
    return api.accueil.surChange(charger);
  });

  // The theme validated by the kernel only touches the home root, not the sidebar or the agent.
  const styleTheme = $derived(
    Object.entries(variablesTheme(theme))
      .map(([key, valeur]) => `${key}: ${valeur}`)
      .join("; "),
  );

  /**
   * Actions sent with no possible reply (grant, update): a warning if THIS widget's state does not move. Only a change
   * of this widget (state, data, or its removal) lifts the wait and the warning.
   */
  const waits = new Map<string, { signature: string; minuterie: ReturnType<typeof setTimeout> }>();
  let warnings = $state<Record<string, string>>({});
  const signature = (id: string) => {
    const w = widgets.find((x) => x.id === id);
    return !w ? "absent" : "erreur" in w ? `illisible:${w.erreur}` : JSON.stringify([w.etat, w.donnees !== null]);
  };
  function withoutWarning(id: string) {
    if (!(id in warnings)) return;
    const { [id]: _, ...rest } = warnings;
    warnings = rest;
  }
  function act(id: string, action: () => void) {
    clearTimeout(waits.get(id)?.minuterie);
    withoutWarning(id);
    action();
    // The wait stays after the warning: it is the widget's change that lifts both.
    const timer = setTimeout(() => (warnings = { ...warnings, [id]: NO_EFFECT }), NO_EFFECT_DELAY_MS);
    waits.set(id, { signature: signature(id), minuterie: timer });
  }
  function checkPending() {
    for (const [id, a] of waits) {
      if (signature(id) === a.signature) continue;
      clearTimeout(a.minuterie);
      waits.delete(id);
      withoutWarning(id);
    }
  }
  $effect(() => () => {
    for (const a of waits.values()) clearTimeout(a.minuterie);
  });

  /** Widgets whose read with the user's account was refused, during this page session. */
  let refuses = $state<Record<string, true>>({});
  let aRetirer = $state<ShownWidget | null>(null);
  let accordPour = $state<Extract<ShownWidget, { compte: string[] }> | null>(null);
  const name = (w: ShownWidget) => ("nom" in w ? w.nom : w.id);

  // Drag and resize: a live free preview, then the layout sent on release.
  let widthPx = $state(0);
  let geste: { id: string; mode: "deplacer" | "taille"; x0: number; y0: number; depart: FreePlacement[]; p0: FreePlacement; tailles: { min: { l: number; h: number }; max: { l: number; h: number } } } | null =
    null;
  let enGeste = $state(false);
  let preview = $state.raw<FreePlacement[] | null>(null);
  let guides = $state.raw<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const placements = $derived(new Map((preview ?? widgets.map((w) => w.placement)).map((p) => [p.id, p])));
  const hauteur = $derived(Math.max(0, ...[...placements.values()].map((p) => p.y + p.h)));

  function commencer(w: ShownWidget, mode: "deplacer" | "taille", e: PointerEvent) {
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
      tailles: "tailles" in w ? { min: freeSizes(w.tailles.min), max: freeSizes(w.tailles.max) } : FREE_SIZES,
    };
    enGeste = true;
    preview = depart;
    guides = { x: [], y: [] };
  }
  function move(e: PointerEvent) {
    const g = geste;
    if (!g) return;
    // Thousandths of the width for x/w, pixels for y/h.
    const dx = widthPx > 0 ? ((e.clientX - g.x0) / widthPx) * FREE_WIDTH : 0;
    const dy = e.clientY - g.y0;
    const others = g.depart.filter((q) => q.id !== g.id);
    const p = g.mode === "deplacer"
      ? moveFree({ p: g.p0, x: g.p0.x + dx, y: g.p0.y + dy, autres: others, largeurPx: widthPx })
      : resizeFree({ p: g.p0, l: g.p0.l + dx, h: g.p0.h + dy, min: g.tailles.min, max: g.tailles.max, autres: others });
    preview = g.depart.map((q) => (q.id === g.id ? p : q));
    guides = freeGuides({ p, autres: others, largeurPx: widthPx });
  }
  function finish(cancelled: boolean) {
    if (!geste) return;
    const { depart } = geste;
    const final = preview;
    geste = null;
    enGeste = false;
    preview = null;
    guides = { x: [], y: [] };
    if (cancelled || !final) return;
    const change = final.some((p, i) => {
      const a = depart[i]!;
      return p.x !== a.x || p.y !== a.y || p.l !== a.l || p.h !== a.h;
    });
    if (!change) return;
    // Immediately on screen; the folder watch will confirm.
    const parId = new Map(final.map((p) => [p.id, p]));
    widgets = widgets.map((w) => ({ ...w, placement: parId.get(w.id) ?? w.placement }));
    api.accueil.placer(final);
  }
</script>

<svelte:window onpointermove={move} onpointerup={() => finish(false)} onpointercancel={() => finish(true)} />

<section class="accueil" style={styleTheme} data-testid="accueil" data-theme={theme ? "agent" : "defaut"}>
  {#if widgets.length}
    <div class="grille" class:geste={enGeste} bind:clientWidth={widthPx} style:height="{hauteur}px">
      {#each widgets as widget (widget.id)}
        {@const p = placements.get(widget.id) ?? widget.placement}
        <div
          class="case"
          style:left="{p.x / 10}%"
          style:top="{p.y}px"
          style:width="{p.l / 10}%"
          style:height="{p.h}px"
        >
          <HomeWidget
            {widget}
            placement={p}
            geste={enGeste}
            avertissement={warnings[widget.id] ?? null}
            refuse={!!refuses[widget.id]}
            commencer={(mode, e) => commencer(widget, mode, e)}
            retirer={() => (aRetirer = widget)}
            autoriser={() => "compte" in widget && (accordPour = widget)}
            refuser={() => {
              // No wait: after a refusal, the kernel rewrites the same « accord-requis » state, so nothing would change on screen.
              refuses = { ...refuses, [widget.id]: true };
              api.accueil.refuserAccord(widget.id);
            }}
            recolter={() => act(widget.id, () => api.accueil.recolter(widget.id))}
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
  {@const target = accordPour}
  <AccountGrantCard
    sujet="widget"
    profilsPourAccord={api.accueil.profilsPourAccord}
    nom={target.nom}
    domaines={target.compte}
    publiques={target.publiques}
    fermer={() => (accordPour = null)}
    autoriser={(profile) => {
      // {@const} is re-read: after accordPour = null, cible is null. The grant covers exactly what was shown.
      const { id, compte: account, publiques: publics } = target;
      accordPour = null;
      const { [id]: _, ...rest } = refuses;
      refuses = rest;
      act(id, () =>
        api.accueil.accorder({ id, profil: profile, compte: [...account], publiques: [...publics] }).then(
          (r) => {
            if (r.ok) return;
            // Refused (the request changed meanwhile…): nothing is granted, the banner shows the new request.
            clearTimeout(waits.get(id)?.minuterie);
            waits.delete(id);
            warnings = { ...warnings, [id]: `Accord non enregistré : ${r.erreur}` };
            charger();
          },
          () => {},
        ),
      );
    }}
  />
{/if}

{#if aRetirer}
  {@const target = aRetirer}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-retrait">
      <p>Retirer « {name(target)} » de la page d'accueil ?</p>
      <div class="boutons">
        <button onclick={() => (aRetirer = null)}>Annuler</button>
        <button
          class="principal"
          onclick={() => {
            const id = target.id; // {@const} is re-read: after aRetirer = null, cible is null
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
  /* The agent theme variables, set on this root only; without a theme, the application's. */
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
  /* Free placement: left/width in thousandths of the width, top/height in pixels. */
  .grille { position: relative; }
  .case { position: absolute; padding: calc(var(--accueil-espace) / 2); box-sizing: border-box; }
  .grille.geste { user-select: none; }
  /* During a gesture, the widget frames must not capture the mouse. */
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
