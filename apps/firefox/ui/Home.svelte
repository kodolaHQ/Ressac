<script lang="ts">
  import type { ShownWidget } from "../shared/api";
  import type { FreePlacement } from "../../../packages/kernel/src/home/schemas";
  import type { HomeTheme } from "../../../packages/kernel/src/home/theme";
  import { api } from "./state.svelte";
  import AccountGrantCard from "./AccountGrantCard.svelte";
  import HomeWidget from "./HomeWidget.svelte";
  import { moveFree, freeGuides, FREE_WIDTH, resizeFree, freeSizes } from "./free-grid";
  import { variablesTheme } from "./theme";

  /** How long an action may leave the page unchanged before a warning shows (widget service missing…). */
  const NO_EFFECT_DELAY_MS = 6000;
  const NO_EFFECT = "Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?).";
  // An unreadable widget has no declared sizes: it may take whatever room it wants.
  const FREE_SIZES = { min: { w: 1, h: 1 }, max: { w: FREE_WIDTH, h: 1000 } };

  // Replaced as a whole on each read: no deep proxy (the data goes to the frames as is).
  let widgets = $state.raw<ShownWidget[]>([]);
  let theme = $state.raw<HomeTheme | null>(null);
  /** The first read is done: the empty screen does not flash before it. */
  let onLoaded = $state(false);
  // Overlapping reads (burst of changes): only the last one counts.
  let last = 0;
  function load() {
    const n = ++last;
    api.home.read().then(
      ({ widgets: reads, theme: parsed }) => {
        if (n !== last) return;
        widgets = reads;
        theme = parsed;
        onLoaded = true;
        checkPending();
      },
      () => {},
    );
  }
  $effect(() => {
    load();
    return api.home.onChange(load);
  });

  // The theme validated by the kernel only touches the home root, not the sidebar or the agent.
  const styleTheme = $derived(
    Object.entries(variablesTheme(theme))
      .map(([key, value]) => `${key}: ${value}`)
      .join("; "),
  );

  /**
   * Actions sent with no possible reply (grant, update): a warning if THIS widget's state does not move. Only a change
   * of this widget (state, data, or its removal) lifts the wait and the warning.
   */
  const waits = new Map<string, { signature: string; timer: ReturnType<typeof setTimeout> }>();
  let warnings = $state<Record<string, string>>({});
  const signature = (id: string) => {
    const w = widgets.find((x) => x.id === id);
    return !w ? "absent" : "error" in w ? `illisible:${w.error}` : JSON.stringify([w.state, w.data !== null]);
  };
  function withoutWarning(id: string) {
    if (!(id in warnings)) return;
    const { [id]: _, ...rest } = warnings;
    warnings = rest;
  }
  function act(id: string, action: () => void) {
    clearTimeout(waits.get(id)?.timer);
    withoutWarning(id);
    action();
    // The wait stays after the warning: it is the widget's change that lifts both.
    const timer = setTimeout(() => (warnings = { ...warnings, [id]: NO_EFFECT }), NO_EFFECT_DELAY_MS);
    waits.set(id, { signature: signature(id), timer: timer });
  }
  function checkPending() {
    for (const [id, a] of waits) {
      if (signature(id) === a.signature) continue;
      clearTimeout(a.timer);
      waits.delete(id);
      withoutWarning(id);
    }
  }
  $effect(() => () => {
    for (const a of waits.values()) clearTimeout(a.timer);
  });

  /** Widgets whose read with the user's account was refused, during this page session. */
  let refuses = $state<Record<string, true>>({});
  let toRemove = $state<ShownWidget | null>(null);
  let grantFor = $state<Extract<ShownWidget, { account: string[] }> | null>(null);
  const name = (w: ShownWidget) => ("name" in w ? w.name : w.id);

  // Drag and resize: a live free preview, then the layout sent on release.
  let widthPx = $state(0);
  let gesture: { id: string; mode: "deplacer" | "taille"; x0: number; y0: number; start: FreePlacement[]; p0: FreePlacement; sizes: { min: { w: number; h: number }; max: { w: number; h: number } } } | null =
    null;
  let inGesture = $state(false);
  let preview = $state.raw<FreePlacement[] | null>(null);
  let guides = $state.raw<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const placements = $derived(new Map((preview ?? widgets.map((w) => w.placement)).map((p) => [p.id, p])));
  const height = $derived(Math.max(0, ...[...placements.values()].map((p) => p.y + p.h)));

  function commencer(w: ShownWidget, mode: "deplacer" | "taille", e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = widgets.map((x) => x.placement);
    const p0 = start.find((p) => p.id === w.id);
    if (!p0) return;
    gesture = {
      id: w.id,
      mode,
      x0: e.clientX,
      y0: e.clientY,
      start: start,
      p0,
      sizes: "sizes" in w ? { min: freeSizes(w.sizes.min), max: freeSizes(w.sizes.max) } : FREE_SIZES,
    };
    inGesture = true;
    preview = start;
    guides = { x: [], y: [] };
  }
  function move(e: PointerEvent) {
    const g = gesture;
    if (!g) return;
    // Thousandths of the width for x/w, pixels for y/h.
    const dx = widthPx > 0 ? ((e.clientX - g.x0) / widthPx) * FREE_WIDTH : 0;
    const dy = e.clientY - g.y0;
    const others = g.start.filter((q) => q.id !== g.id);
    const p = g.mode === "deplacer"
      ? moveFree({ p: g.p0, x: g.p0.x + dx, y: g.p0.y + dy, others: others, widthPx: widthPx })
      : resizeFree({ p: g.p0, w: g.p0.w + dx, h: g.p0.h + dy, min: g.sizes.min, max: g.sizes.max, others: others });
    preview = g.start.map((q) => (q.id === g.id ? p : q));
    guides = freeGuides({ p, others: others, widthPx: widthPx });
  }
  function finish(cancelled: boolean) {
    if (!gesture) return;
    const { start: start } = gesture;
    const final = preview;
    gesture = null;
    inGesture = false;
    preview = null;
    guides = { x: [], y: [] };
    if (cancelled || !final) return;
    const change = final.some((p, i) => {
      const a = start[i]!;
      return p.x !== a.x || p.y !== a.y || p.w !== a.w || p.h !== a.h;
    });
    if (!change) return;
    // Immediately on screen; the folder watch will confirm.
    const byId = new Map(final.map((p) => [p.id, p]));
    widgets = widgets.map((w) => ({ ...w, placement: byId.get(w.id) ?? w.placement }));
    api.home.place(final);
  }
</script>

<svelte:window onpointermove={move} onpointerup={() => finish(false)} onpointercancel={() => finish(true)} />

<section class="accueil" style={styleTheme} data-testid="accueil" data-theme={theme ? "agent" : "default"}>
  {#if widgets.length}
    <div class="grille" class:geste={inGesture} bind:clientWidth={widthPx} style:height="{height}px">
      {#each widgets as widget (widget.id)}
        {@const p = placements.get(widget.id) ?? widget.placement}
        <div
          class="case"
          style:left="{p.x / 10}%"
          style:top="{p.y}px"
          style:width="{p.w / 10}%"
          style:height="{p.h}px"
        >
          <HomeWidget
            {widget}
            placement={p}
            gesture={inGesture}
            warning={warnings[widget.id] ?? null}
            denied={!!refuses[widget.id]}
            start={(mode, e) => commencer(widget, mode, e)}
            remove={() => (toRemove = widget)}
            allow={() => "account" in widget && (grantFor = widget)}
            deny={() => {
              // No wait: after a refusal, the kernel rewrites the same « accord-requis » state, so nothing would change on screen.
              refuses = { ...refuses, [widget.id]: true };
              api.home.denyGrant(widget.id);
            }}
            harvest={() => act(widget.id, () => api.home.harvest(widget.id))}
            viewWorkflow={() => "name" in widget && api.dispatch({ type: "openWorkflow", windowId: api.windowId, id: widget.id, name: widget.name })}
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
  {:else if onLoaded}
    <p class="vide" data-testid="accueil-vide">Aucun widget pour l'instant. Demande à l'agent de créer le premier.</p>
  {/if}
</section>

{#if grantFor}
  {@const target = grantFor}
  <AccountGrantCard
    subject="widget"
    profilesForGrant={api.home.profilesForGrant}
    name={target.name}
    domains={target.account}
    public={target.public}
    close={() => (grantFor = null)}
    allow={(profile) => {
      // {@const} is re-read: after accordPour = null, cible is null. The grant covers exactly what was shown.
      const { id, account: account, public: publics } = target;
      grantFor = null;
      const { [id]: _, ...rest } = refuses;
      refuses = rest;
      act(id, () =>
        api.home.grant({ id, profile: profile, account: [...account], public: [...publics] }).then(
          (r) => {
            if (r.ok) return;
            // Refused (the request changed meanwhile…): nothing is granted, the banner shows the new request.
            clearTimeout(waits.get(id)?.timer);
            waits.delete(id);
            warnings = { ...warnings, [id]: `Accord non enregistré : ${r.error}` };
            load();
          },
          () => {},
        ),
      );
    }}
  />
{/if}

{#if toRemove}
  {@const target = toRemove}
  <div class="voile">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="confirmation-retrait">
      <p>Retirer « {name(target)} » de la page d'accueil ?</p>
      <div class="boutons">
        <button onclick={() => (toRemove = null)}>Annuler</button>
        <button
          class="principal"
          onclick={() => {
            const id = target.id; // {@const} is re-read: after aRetirer = null, cible is null
            toRemove = null;
            widgets = widgets.filter((w) => w.id !== id);
            api.home.remove(id);
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
