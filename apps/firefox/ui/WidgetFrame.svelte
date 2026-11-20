<script lang="ts">
  import RemoteFrame, { type RemoteFrameHandle } from "./RemoteFrame.svelte";
  import { api } from "./state.svelte";
  import { t } from "./i18n.svelte";

  /**
   * A widget shown in its isolated frame (RemoteFrame: out of the parent process, sandboxed, opaque origin), with no
   * access to the interface. It receives its data through postMessage; its links go through api.home.open.
   */
  let {
    widget,
    data,
    size,
    state: appState,
  }: {
    widget: { id: string; name: string; src: string | null };
    data: unknown;
    size: { w: number; h: number };
    state: { status: string; lastUpdate: string | null };
  } = $props();

  let frame = $state<RemoteFrameHandle>();
  let width = $state(0);
  let height = $state(0);

  /** The frame shows the served copy (CSP, guard): never a page it navigated to. */
  // Without the fragment: a widget that sets its own #hash stays on its copy.
  const ours = () => !!widget.src && frame?.uri()?.split("#")[0] === widget.src;

  function send() {
    if (!frame || !ours()) return;
    void frame.send({
      type: "widget",
      data: $state.snapshot(data),
      size: { w: size.w, h: size.h },
      px: { width: width, height: height },
      state: { status: appState.status, lastUpdate: appState.lastUpdate },
    });
  }
  // On each change of data, state or size (loading goes through onLoad).
  $effect(() => {
    void [data, appState.status, appState.lastUpdate, size.w, size.h, width, height];
    send();
  });

  function onLoad() {
    // Navigated away from its copy: sent back to it, with nothing given to the other page.
    if (!ours()) {
      if (frame && widget.src) frame.load(widget.src);
      return;
    }
    send();
  }

  // The widget's link: `ressacOpen` (provided by the guard in the page's world) emits an event the frames' actor
  // forwards. The main process only opens it if a real press by the user just landed in this widget.
  function onMessage(name: string, d: { url?: string }) {
    if (name === "open" && typeof d.url === "string" && ours()) api.home.open(d.url, widget.id);
  }

  // The widget only takes the keyboard under the pointer (a click by the user): a focus() from its code is handed back
  // to the interface element that had it.
  let before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  function onFocusin(e: FocusEvent) {
    if (e.target === frame?.element) guardFocus();
    else if (e.target instanceof HTMLElement) before = e.target;
  }
  function guardFocus() {
    setTimeout(() => {
      const b = frame?.element as HTMLElement | undefined;
      if (!b || !document.hasFocus() || document.activeElement !== b || b.matches(":hover")) return;
      if (before?.isConnected) before.focus();
      else b.blur();
    });
  }
</script>

<svelte:window onfocusin={onFocusin} />

<div class="content" bind:clientWidth={width} bind:clientHeight={height}>
  {#if widget.src}
    <RemoteFrame
      src={widget.src}
      title={widget.name}
      bind:frame
      onload={onLoad}
      onmessage={onMessage}
      onpress={() => api.home.gesture(widget.id)}
      onfocus={guardFocus}
    />
  {:else}
    <p class="empty">{t("home-widget-no-display")}</p>
  {/if}
</div>

<style>
  /* The card background while loading: no white flash in dark mode. */
  .content { flex: 1; min-height: 0; display: flex; background: var(--home-card); }
  .empty { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--home-text-muted); }
</style>
