<script lang="ts">
  import type { ShownWidget } from "../shared/api";
  import type { FreePlacement } from "../../../packages/kernel/src/home/schemas";
  import { fade } from "svelte/transition";
  import WidgetFrame from "./WidgetFrame.svelte";
  import Icon from "./components/Icon.svelte";
  import { nextRun } from "./components/next";
  import { appState } from "./state.svelte";
  import { t } from "./i18n.svelte";
  import { freeUnits } from "./free-grid";

  let {
    widget,
    placement,
    gesture,
    warning,
    denied,
    start: beginGesture,
    remove,
    allow,
    deny,
    harvest,
    viewWorkflow: seeWorkflow,
  }: {
    widget: ShownWidget;
    /** The place shown (the preview's during a drag). */
    placement: FreePlacement;
    /** A drag or resize is under way on the grid: the frame does not capture the mouse. */
    gesture: boolean;
    /** The requested action changed nothing (widget service missing…). */
    warning: string | null;
    /** The user refused the read with their account: the banner does not come back. */
    denied: boolean;
    start: (mode: "move" | "resize", e: PointerEvent) => void;
    remove: () => void;
    allow: () => void;
    deny: () => void;
    harvest: () => void;
    viewWorkflow: () => void;
  } = $props();

  const date = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString(appState.value?.locale ?? "fr", { dateStyle: "short", timeStyle: "short" }) : t("home-widget-unknown-date");

  let menuOpen = $state(false);

  /** Re-read every minute: « prochaine : … » goes from today to tomorrow without waiting for a widget change. */
  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 60_000);
    return () => clearInterval(timer);
  });
  // Never for a widget waiting for the user's grant: nothing goes out without them.
  const next = $derived(
    "error" in widget || widget.state.status === "grant-required"
      ? null
      : nextRun(
          widget.hours,
          now,
          widget.minutes !== null ? { minutes: widget.minutes, lastUpdate: widget.state.lastUpdate } : undefined,
          widget.state,
          appState.value?.locale,
        ),
  );

  // The real size becomes the grid units the display receives in postMessage.
  const size = $derived(freeUnits({ w: placement.w, h: placement.h }));

  function handle(e: PointerEvent) {
    if (e.target instanceof Element && e.target.closest("button")) return;
    menuOpen = false;
    beginGesture("move", e);
  }
</script>

<article class="widget" class:gesture={gesture} data-testid="widget-{widget.id}">
  <!-- The header is the drag handle: the widget's frame swallows the mouse events. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header onpointerdown={handle}>
    {#if "error" in widget}
      <p class="unreadable">{t("home-widget-unreadable", { id: widget.id, error: widget.error })}</p>
    {:else}
      <h2 data-testid="widget-title">{widget.name}</h2>
      {#if widget.state.status === "running"}
        {#if widget.state.progress}
          <span class="badge" data-testid="progress">{t("home-widget-progress", { done: String(widget.state.progress.done), total: String(widget.state.progress.total) })}</span>
        {:else}
          <span class="badge">{t("home-widget-updating")}</span>
        {/if}
      {:else if widget.state.status === "error"}
        <span class="badge failure" title={widget.state.log ?? ""}
          >{t("home-widget-failed", { date: date(widget.state.lastAttempt), error: widget.state.error ?? t("home-widget-unknown-error") })}</span
        >
      {:else if widget.state.status === "workshop-stopped"}
        <span class="badge failure">{t("home-widget-workshop-stopped")}</span>
      {:else if widget.state.status === "lab-required"}
        <span class="badge muted lab" data-testid="lab-required" out:fade={{ duration: 150 }}>{t("home-widget-lab-required")}</span>
      {:else if widget.state.warning}
        <span class="badge failure" data-testid="widget-warning">{widget.state.warning}</span>
      {:else if next}
        <span class="badge muted" data-testid="next-run">{t("home-widget-next", { next })}</span>
      {/if}
    {/if}
    <div class="actions">
      <button class="menu" aria-label={t("home-widget-options")} title={t("home-widget-options")} onclick={() => (menuOpen = !menuOpen)}>
        <Icon name="options" size={14} />
      </button>
      {#if menuOpen}
        <div class="list" role="menu">
          {#if !("error" in widget)}
            <button role="menuitem" onclick={() => ((menuOpen = false), harvest())}>{t("home-widget-update-now")}</button>
            {#if widget.hasHarvest}
              <button role="menuitem" onclick={() => ((menuOpen = false), seeWorkflow())}>{t("home-widget-workflow")}</button>
            {/if}
          {/if}
          <button role="menuitem" onclick={() => ((menuOpen = false), remove())}>{t("home-remove")}</button>
        </div>
      {/if}
    </div>
  </header>
  {#if !("error" in widget)}
    {#if widget.state.status === "grant-required" && !denied}
      <div class="banner" data-testid="grant-banner">
        <span
          >{#if widget.state.codeChanged}<strong data-testid="grant-code-changed">{t("home-widget-code-changed")}</strong> {/if}{widget.account.length === 0
            ? widget.web
              ? widget.public.length
                ? t("home-widget-reads-public-web", { public: widget.public.join(", ") })
                : t("home-widget-reads-web")
              : t("home-widget-reads-public", { public: widget.public.join(", ") })
            : widget.public.length
              ? t("home-widget-grant-public", { account: widget.account.join(", "), public: widget.public.join(", ") })
              : t("home-widget-grant-private", { account: widget.account.join(", ") })}</span
        >
        <button onclick={allow}>{t(widget.account.length ? "home-widget-allow" : "home-widget-reads-allow")}</button>
        <button onclick={deny}>{t("home-deny")}</button>
      </div>
    {/if}
    {#if warning}<p class="warning">{warning}</p>{/if}
    <WidgetFrame
      {widget}
      data={widget.data ?? widget.example}
      size={size}
      state={{ status: widget.state.status, lastUpdate: widget.state.lastUpdate }}
    />
  {:else if warning}
    <p class="warning">{warning}</p>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resize-handle" data-testid="resize-handle" title={t("home-widget-resize")} onpointerdown={(e) => ((menuOpen = false), beginGesture("resize", e))}></div>
</article>

<style>
  .widget {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
    border: 1px solid var(--home-border);
    border-radius: var(--home-radius);
    background: var(--home-card);
    box-shadow: var(--float);
    overflow: hidden;
    color: var(--home-text);
  }
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: grab; user-select: none; min-height: 20px; }
  h2 { margin: 0; font: 650 14px/1.2 var(--font-display); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; color: var(--home-accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .badge.muted { color: var(--home-text-muted); }
  .badge.lab { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .badge.failure, .unreadable, .warning { color: var(--in-error); }
  .unreadable { margin: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .actions { position: relative; margin-left: auto; }
  .menu { all: unset; width: 22px; height: 22px; display: grid; place-content: center; border-radius: 4px; color: var(--home-text-muted); cursor: pointer; }
  .menu:hover { background: var(--bg-hover); }
  .list { position: absolute; right: 0; top: 24px; z-index: 3; display: flex; flex-direction: column; min-width: 190px; padding: 4px; border-radius: 12px; border: 1px solid var(--glass-edge); background: var(--glass-dense); box-shadow: var(--modal-shadow); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .list button { all: unset; padding: 6px 10px; border-radius: 8px; font-size: 13px; color: var(--home-text); cursor: pointer; }
  .list button:hover { background: var(--bg-hover); }
  .banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px; background: var(--bg-hover); }
  .banner button { padding: 3px 10px; border-radius: 8px; border: 1px solid var(--home-border); background: var(--glass-hi); color: var(--home-text); font-size: 12px; cursor: pointer; }
  .banner button:first-of-type { background: var(--home-accent); border-color: var(--home-accent); color: var(--accent-ink); }
  .warning { margin: 0; padding: 4px 12px; font-size: 12px; }
  /* During a drag, the frame (in WidgetFrame) does not capture the mouse. */
  .gesture :global(browser) { pointer-events: none; }
  /* The handle only shows on card hover (the most sober look). */
  .resize-handle { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 2; opacity: 0;
    background: linear-gradient(135deg, transparent 50%, var(--home-text-muted) 50%, var(--home-text-muted) 60%, transparent 60%, transparent 75%, var(--home-text-muted) 75%, var(--home-text-muted) 85%, transparent 85%); }
  .widget:hover .resize-handle { opacity: 1; }
</style>
