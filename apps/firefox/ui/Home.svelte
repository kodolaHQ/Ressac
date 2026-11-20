<script lang="ts">
  import type { ShownWidget } from "../shared/api";
  import type { FreePlacement } from "../../../packages/kernel/src/home/schemas";
  import type { HomeTheme } from "../../../packages/kernel/src/home/theme";
  import { aiOn, api } from "./state.svelte";
  import AiAsleep from "./components/AiAsleep.svelte";
  import { t } from "./i18n.svelte";
  import AccountGrantCard from "./components/AccountGrantCard.svelte";
  import HomeWidget from "./HomeWidget.svelte";
  import { moveFree, freeGuides, FREE_WIDTH, resizeFree, freeSizes } from "./free-grid";
  import { variablesTheme } from "./theme";

  /** How long an action may leave the page unchanged before a warning shows (widget service missing…). */
  const NO_EFFECT_DELAY_MS = 6000;
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
  // AI off: no kernel, no widgets to read; the asleep card stands in for them.
  $effect(() => {
    if (!aiOn()) return;
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
    const timer = setTimeout(() => (warnings = { ...warnings, [id]: t("home-no-effect") }), NO_EFFECT_DELAY_MS);
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
  let gesture: { id: string; mode: "move" | "resize"; x0: number; y0: number; start: FreePlacement[]; p0: FreePlacement; sizes: { min: { w: number; h: number }; max: { w: number; h: number } } } | null =
    null;
  let inGesture = $state(false);
  let preview = $state.raw<FreePlacement[] | null>(null);
  let guides = $state.raw<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const placements = $derived(new Map((preview ?? widgets.map((w) => w.placement)).map((p) => [p.id, p])));
  const height = $derived(Math.max(0, ...[...placements.values()].map((p) => p.y + p.h)));

  function beginGesture(w: ShownWidget, mode: "move" | "resize", e: PointerEvent) {
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
    const p = g.mode === "move"
      ? moveFree({ p: g.p0, x: g.p0.x + dx, y: g.p0.y + dy, others: others, widthPx: widthPx })
      : resizeFree({ p: g.p0, w: g.p0.w + dx, h: g.p0.h + dy, min: g.sizes.min, max: g.sizes.max, others: others });
    preview = g.start.map((q) => (q.id === g.id ? p : q));
    guides = freeGuides({ p, others: others, widthPx: widthPx });
  }
  function finish(cancelled: boolean) {
    if (!gesture) return;
    const { start } = gesture;
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

<section class="home" style={styleTheme} data-testid="home" data-theme={theme ? "agent" : "default"}>
  {#if !aiOn()}
    <AiAsleep feature="widgets" />
  {:else if widgets.length}
    <div class="grid" class:gesture={inGesture} bind:clientWidth={widthPx} style:height="{height}px">
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
            start={(mode, e) => beginGesture(widget, mode, e)}
            remove={() => (toRemove = widget)}
            allow={() => {
              if (!("account" in widget)) return;
              if (widget.account.length) return void (grantFor = widget);
              // No account: no card, the approval covers exactly what the banner showed.
              const { id, public: publics, web } = widget;
              const { [id]: _, ...rest } = refuses;
              refuses = rest;
              act(id, () =>
                api.home.approveReads({ id, public: [...publics], web }).then((r) => {
                  if (r.ok) return;
                  clearTimeout(waits.get(id)?.timer);
                  waits.delete(id);
                  warnings = { ...warnings, [id]: t("home-grant-not-saved", { error: r.error }) };
                  load();
                }),
              );
            }}
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
    <p class="empty" data-testid="home-empty">{t("home-empty")}</p>
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
            warnings = { ...warnings, [id]: t("home-grant-not-saved", { error: r.error }) };
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
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="removal-confirmation">
      <p>{t("home-remove-confirm", { name: name(target) })}</p>
      <div class="buttons">
        <button onclick={() => (toRemove = null)}>{t("home-cancel")}</button>
        <button
          class="main"
          onclick={() => {
            const id = target.id; // {@const} is re-read: after aRetirer = null, cible is null
            toRemove = null;
            widgets = widgets.filter((w) => w.id !== id);
            api.home.remove(id);
          }}>{t("home-remove")}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  /* The agent theme variables, set on this root only; without a theme, Aura's: the home sits on the aura, its widgets
     on sheets the aura shows through. */
  .home {
    --home-bg: transparent;
    --home-card: color-mix(in oklab, var(--sheet) 72%, transparent);
    --home-text: var(--text);
    --home-text-muted: var(--text-muted);
    --home-accent: var(--accent);
    --home-border: var(--glass-edge);
    --home-radius: 16px;
    --home-spacing: 12px;
    --home-font: inherit;
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    padding: 16px;
    background: var(--home-bg);
    color: var(--home-text);
    font-family: var(--home-font);
  }
  /* Free placement: left/width in thousandths of the width, top/height in pixels. */
  .grid { position: relative; }
  .case { position: absolute; padding: calc(var(--home-spacing) / 2); box-sizing: border-box; }
  .grid.gesture { user-select: none; }
  .guide { position: absolute; z-index: 4; pointer-events: none; background: var(--home-accent); opacity: 0.6; }
  .guide-x { top: 0; bottom: 0; width: 1px; }
  .guide-y { left: 0; right: 0; height: 1px; }
  .empty { margin: 24px 0; text-align: center; font-size: 13px; color: var(--home-text-muted); }
  .veil { position: fixed; inset: 0; display: grid; place-content: center; background: var(--veil); backdrop-filter: blur(6px); z-index: 10; }
  .confirmation { max-width: 420px; padding: 18px 20px; border-radius: 16px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--modal-shadow); color: var(--text); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 14px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); transition: transform var(--tap); }
  .buttons button:active { transform: scale(0.97); }
  .buttons .main { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
