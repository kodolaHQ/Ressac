<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type { HideApi, HideContext, HideRect } from "../shared/api";
  import { format } from "../shared/i18n";
  import { PASSPORT_FIELDS, type PassportField } from "../chrome/shims/kernel";

  // « Cacher pour l'agent » (chrome/window/hide-layer.ts): `layer` draws over the page (outline, animation, ending),
  // `bubble` is the confirmation, its errors and the toast. Everything shown comes from the chrome's context; this
  // frame decides nothing and saves nothing itself.
  let { part }: { part: "layer" | "bubble" } = $props();
  const api = window.ressac as unknown as HideApi;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t = (id: string, args?: Record<string, string>) => format(ctx?.locale ?? "fr", id, args);

  let ctx = $state<HideContext | null>(null);
  let field = $state<PassportField>("libre");
  let given = $state("");
  let family = $state("");
  let root = $state<HTMLElement>();
  let confirmButton = $state<HTMLButtonElement>();

  // The animation, once per hide: the text's snapshot shimmers and blurs out, aura particles gather, the chip springs to
  // its width; then the ending (hidden: the chip fades and a hatched underline shows; otherwise the chip says why).
  let played = -1;
  let stage = $state<"vanish" | "chip" | "say" | "hatch" | "done">("done");
  let shown = $state<HideContext | null>(null);
  let timers: ReturnType<typeof setTimeout>[] = [];
  const at = (ms: number, f: () => void) => timers.push(setTimeout(f, ms));
  function play(c: HideContext) {
    played = c.seq;
    for (const x of timers) clearTimeout(x);
    timers = [];
    shown = c;
    stage = "vanish";
    const chip = reduce ? 150 : 200;
    at(chip, () => (stage = "chip"));
    if (c.ending === "hidden") {
      at(chip + 1100, () => (stage = "hatch"));
      at(chip + 2200, () => (stage = "done"));
    } else {
      at(chip + (reduce ? 150 : 460), () => (stage = "say"));
      at(chip + (reduce ? 150 : 460) + 2500, () => (stage = "done"));
    }
  }
  function update() {
    const c = api.context();
    const open = (p?: HideContext["phase"]) => p === "bubble" || p === "saving";
    // A new bubble starts from the chrome's guess; a failed save keeps what the user chose.
    if (c && (c.phase === "bubble" || c.phase === "error") && !open(ctx?.phase)) {
      field = c.field;
      given = c.name?.given ?? "";
      family = c.name?.family ?? "";
      if (part === "bubble") void tick().then(() => confirmButton?.focus());
    }
    if (part === "layer" && c?.phase === "toast" && c.ending && c.seq !== played) play(c);
    ctx = c;
  }
  update();
  api.onChange(update);

  const named = $derived(field === "nom" || field === "proche");
  const busy = $derived(ctx?.phase === "saving");
  function confirm() {
    if (ctx?.phase !== "bubble") return;
    void api.confirm(named ? { field, name: { given: given.trim(), family: family.trim() } } : { field });
  }
  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      api.cancel();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      confirm();
    }
  }

  // The bubble frame covers only what it shows: measured after each change (no ResizeObserver: an unpainted window
  // never fires it, as AgentPill.svelte notes).
  $effect(() => {
    if (part !== "bubble") return;
    void [ctx, field];
    void tick().then(() => {
      const f = window.frameElement as HTMLElement | null;
      if (f && root) Object.assign(f.style, { width: `${root.offsetWidth}px`, height: `${root.offsetHeight}px` });
    });
  });

  // Undone or closed: the marks fade out with the rest.
  $effect(() => {
    if (part === "layer" && ctx?.phase !== "toast" && stage !== "done") stage = "done";
  });

  const box = (r: HideRect) => `left: ${r.x}px; top: ${r.y}px; width: ${r.width}px; height: ${r.height}px`;
  const particles = (r: HideRect) => {
    const n = Math.min(26, 8 + Math.round((r.width * r.height) / 400));
    const cx = r.x + 30, cy = r.y + r.height / 2;
    return Array.from({ length: n }, (_, i) => {
      const x = r.x + Math.random() * r.width, y = r.y + Math.random() * r.height;
      return `left: ${x}px; top: ${y}px; background: var(--a${(i % 3) + 1}); --dx: ${cx - x}px; --dy: ${cy - y}px; animation-duration: ${380 + Math.random() * 220}ms; animation-delay: ${80 + Math.random() * 120}ms`;
    });
  };
  const spring = () => getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || "ease-out";

  /** The chip grows from where it was (the text's width at first) to its own width, on the spring; reduced: no growth. */
  function grow(node: HTMLElement, from: number) {
    let last = from;
    const run = () => {
      const own = node.offsetWidth;
      // Kept inside the layer: the sentence is wider than most values.
      const room = document.documentElement.clientWidth - 8;
      if (node.offsetLeft + own > room) node.style.left = `${Math.max(8, room - own)}px`;
      if (!reduce) node.animate([{ width: `${Math.max(last, 40)}px`, opacity: last === from ? 0 : 1 }, { width: `${own}px`, opacity: 1 }], { duration: 460, easing: spring() });
      last = own;
    };
    run();
    return { update: () => void tick().then(run) };
  }
</script>

{#if part === "layer"}
  <div class="layer" class:picking={ctx?.phase === "pick"} bind:this={root}>
    {#if ctx && ctx.phase !== "toast" && (ctx.phase === "pick" ? ctx.hover : ctx.target)}
      {@const r = (ctx.phase === "pick" ? ctx.hover : ctx.target)!}
      <div class="aim" data-testid="hide-aim" style={box(r)} class:below={r.y < 28} transition:fade={{ duration: 150 }}>
        <span class="tag">{t("chrome-hide")}</span>
      </div>
    {/if}
    {#if shown?.target && stage !== "done"}
      {@const r = shown.target}
      {#if shown.snapshot && (stage === "vanish" || stage === "chip" || stage === "say")}
        <div class="cover" style="{box(r)}; background: {shown.snapshot.background}" out:fade={{ duration: 150 }}>
          <img src={shown.snapshot.url} alt="" class:blur={!reduce} />
        </div>
      {/if}
      {#if !reduce && (stage === "vanish" || stage === "chip")}
        <div class="shine" style={box(r)}></div>
        {#each particles(r) as p, i (i)}<i class="pt" style={p}></i>{/each}
      {/if}
      {#if stage === "chip" || stage === "say"}
        <div
          class="chip"
          data-testid="hide-chip"
          style="left: {r.x}px; top: {r.y + Math.min(r.height, 24) / 2 - 11}px"
          use:grow={r.width}
          in:fade={{ duration: reduce ? 150 : 0 }}
          out:fade={{ duration: 150 }}
        >
          {stage === "say" ? t(shown.ending === "agentReached" ? "chrome-hide-ending-agent" : "chrome-hide-ending-next") : shown.chip}
        </div>
      {/if}
      {#if stage === "hatch"}
        <div class="hatch" data-testid="hide-hatch" style="left: {r.x}px; top: {r.y + r.height - 3}px; width: {r.width}px" transition:fade={{ duration: 150 }}></div>
      {/if}
    {/if}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="root" class:toast-root={ctx?.phase === "toast"} bind:this={root} onkeydown={keys}>
    {#if ctx && (ctx.phase === "bubble" || ctx.phase === "saving" || ctx.phase === "error")}
      <div class="bubble" data-testid="hide-bubble" role="dialog" aria-label={t("chrome-hide")} out:fade={{ duration: 150 }}>
        {#if ctx.phase === "error"}
          <p class="error" role="alert" data-testid="hide-error">{t(`chrome-hide-error-${ctx.error}`)}</p>
        {:else}
          <p class="q" data-testid="hide-question">{t("chrome-hide-question", { text: ctx.short })}</p>
          <label class="field"><span>{t("chrome-hide-type")}</span>
            <select data-testid="hide-type" bind:value={field} disabled={busy}>
              {#each PASSPORT_FIELDS as f (f)}<option value={f}>{t(`chrome-hide-field-${f}`)}</option>{/each}
            </select>
          </label>
          {#if named}
            <div class="names">
              <label class="field"><span>{t("chrome-hide-given")}</span><input data-testid="hide-given" bind:value={given} disabled={busy} /></label>
              <label class="field"><span>{t("chrome-hide-family")}</span><input data-testid="hide-family" bind:value={family} disabled={busy} /></label>
            </div>
          {/if}
          {#if ctx.site}<p class="site" data-testid="hide-site">{t("chrome-hide-site", { site: ctx.site })}</p>{/if}
          {#if ctx.error}<p class="error" role="alert" data-testid="hide-error">{t(`chrome-hide-error-${ctx.error}`)}</p>{/if}
        {/if}
        <div class="actions">
          <button class="cancel" data-testid="hide-cancel" onclick={() => api.cancel()}>{t("chrome-hide-cancel")}</button>
          {#if ctx.phase !== "error"}
            <button class="primary" data-testid="hide-confirm" bind:this={confirmButton} disabled={busy} onclick={confirm}>{t("chrome-hide-confirm")}</button>
          {/if}
        </div>
      </div>
    {:else if ctx?.phase === "toast"}
      <div class="toast" role="status" data-testid="hide-toast" out:fade={{ duration: 150 }}>
        <div class="line">
          <span>{t(ctx.undoable ? "chrome-hide-toast" : "chrome-hide-toast-already")}</span>
          {#if ctx.undoable}<button class="cancel" data-testid="hide-undo" onclick={() => void api.undo()}>{t("chrome-hide-toast-undo")}</button>{/if}
        </div>
        {#if ctx.readBefore}<p class="muted" data-testid="hide-read-before">{t("chrome-hide-read-before")}</p>{/if}
        <!-- The 8 s countdown; reduced motion keeps no long animation. -->
        {#if ctx.undoable && !reduce}<i class="bar"></i>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; overflow: hidden; }
  .layer { position: fixed; inset: 0; pointer-events: none; }
  .layer.picking { cursor: crosshair; }
  .aim { position: absolute; border-radius: 6px; box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px color-mix(in srgb, var(--accent) 22%, transparent); background: color-mix(in srgb, var(--accent) 7%, transparent); transition: left var(--spring-d) var(--spring), top var(--spring-d) var(--spring), width var(--spring-d) var(--spring), height var(--spring-d) var(--spring); }
  .tag { position: absolute; left: -2px; bottom: calc(100% + 6px); padding: 2px 8px; border-radius: 7px; background: var(--accent); color: var(--accent-ink); font: 600 11px/1.5 var(--font-ui); white-space: nowrap; }
  .aim.below .tag { bottom: auto; top: calc(100% + 6px); }
  .cover { position: absolute; overflow: hidden; border-radius: 3px; }
  .cover img { display: block; width: 100%; height: 100%; animation: fadeout 150ms ease-out forwards; }
  .cover img.blur { animation: vanish 340ms ease-in forwards; }
  @keyframes vanish { to { filter: blur(7px); opacity: 0; } }
  @keyframes fadeout { to { opacity: 0; } }
  .shine { position: absolute; border-radius: 6px; overflow: hidden; }
  .shine::before { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 20%, var(--a3) 50%, transparent 80%); opacity: 0.85; transform: translateX(-100%); animation: sweep 380ms ease-in forwards; }
  .shine::after { content: ""; position: absolute; inset: 0; background: color-mix(in srgb, var(--a2) 22%, transparent); opacity: 0; animation: tint 380ms ease-out forwards; }
  @keyframes sweep { to { transform: translateX(100%); } }
  @keyframes tint { 50% { opacity: 1; } to { opacity: 0; } }
  .pt { position: absolute; width: 4px; height: 4px; border-radius: 50%; opacity: 0; animation: gather 500ms cubic-bezier(0.55, 0, 0.6, 1) backwards; }
  @keyframes gather { from { transform: translate(0, 0) scale(1); opacity: 0; } 25% { opacity: 1; } to { transform: translate(var(--dx), var(--dy)) scale(0.4); opacity: 0; } }
  .chip { position: absolute; height: 22px; padding: 0 8px; overflow: hidden; box-sizing: border-box; border-radius: 7px; background: color-mix(in srgb, var(--accent) 16%, var(--sheet)); color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent), var(--float); font: 500 11.5px/22px var(--font-mono); white-space: nowrap; }
  .hatch { position: absolute; height: 3px; border-radius: 2px; background-image: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--accent) 60%, transparent) 0 1.5px, transparent 1.5px 4px); }

  .root { display: inline-block; }
  /* hide-layer.ts TOAST_WIDTH: the frame is this wide, the toast centred in it. */
  .root.toast-root { display: flex; justify-content: center; width: 420px; }
  .bubble { box-sizing: border-box; width: 340px; display: grid; gap: 8px; padding: 12px 14px; border-radius: 14px; background: radial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--a1) 16%, transparent), transparent 60%), var(--glass-dense); color: var(--text); border: 1px solid var(--glass-edge); box-shadow: var(--float); font: 13px/1.45 var(--font-ui); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .q { margin: 0; font-size: 13.5px; overflow-wrap: anywhere; }
  .field { display: grid; gap: 3px; font-size: 12px; color: var(--text-muted); min-width: 0; }
  .names { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  select, input { box-sizing: border-box; width: 100%; padding: 6px 9px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 13px/1.4 var(--font-ui); outline: none; }
  select:focus, input:focus { border-color: var(--accent); }
  .site, .muted { margin: 0; font-size: 12px; color: var(--text-muted); }
  .error { margin: 0; color: var(--in-error); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; }
  button { all: unset; cursor: pointer; padding: 5px 12px; border-radius: 9px; transition: transform var(--tap), background var(--tap); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .cancel { color: var(--text-muted); }
  .cancel:hover { background: var(--bg-hover); color: var(--text); }
  .primary { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .toast { position: relative; display: grid; gap: 2px; width: max-content; max-width: 100%; padding: 8px 10px 8px 14px; border-radius: 12px; overflow: hidden; background: var(--glass-dense); color: var(--text); border: 1px solid var(--glass-edge); box-shadow: var(--float); font-size: 12.5px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .toast .line { display: flex; align-items: center; gap: 12px; }
  .toast button { padding: 4px 10px; font-size: 12px; }
  .bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--accent); transform-origin: left; animation: shrink 8s linear forwards; }
  @keyframes shrink { to { transform: scaleX(0); } }
</style>
