<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api } from "./state.svelte";
  import { t } from "./i18n.svelte";

  /**
   * A widget shown in its isolated frame: without allow-same-origin, the code written by the agent runs in an opaque
   * origin, with no access to the interface. It receives its data through postMessage; its links go through
   * api.home.open.
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

  let iframe = $state<HTMLIFrameElement>();
  let width = $state(0);
  let height = $state(0);

  function send() {
    attachGesture();
    // The frame has an opaque origin (sandbox without allow-same-origin): « * » is the only possible target.
    iframe?.contentWindow?.postMessage(
      {
        type: "widget",
        data: $state.snapshot(data),
        size: { w: size.w, h: size.h },
        px: { width: width, height: height },
        state: { status: appState.status, lastUpdate: appState.lastUpdate },
      },
      "*",
    );
  }
  // On each change of data, state or size (loading goes through DOMFrameContentLoaded).
  $effect(() => {
    void [data, appState.status, appState.lastUpdate, size.w, size.h, width, height];
    send();
  });

  // The widget only takes the keyboard under the pointer (a click by the user): a focus() from its code is handed back
  // to the interface element that had it.
  let before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  function onFocusin(e: FocusEvent) {
    if (e.target instanceof HTMLElement && e.target !== iframe) before = e.target;
  }
  function onBlur() {
    setTimeout(() => {
      if (!iframe || !document.hasFocus() || document.activeElement !== iframe || iframe.matches(":hover")) return;
      if (before?.isConnected) before.focus();
      else iframe.blur();
    });
  }

  function onMessage(e: MessageEvent) {
    // The origin of a sandboxed frame is opaque (« null »): the source, never the origin, identifies it.
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d: unknown = e.data;
    if (typeof d !== "object" || d === null) return;
    const { type, url } = d as { type?: unknown; url?: unknown };
    if (type !== "open" || typeof url !== "string") return;
    // The main process only opens the link if a real click by the user just landed in this widget (one link per click).
    api.home.open(url, widget.id);
  }

  // The guard is a script at the top of the served copy; it removes WebRTC last, so while RTCPeerConnection is still
  // there it could not fully install: no press is recorded then (fail closed). This listener is set by the chrome,
  // which the widget can neither remove nor imitate (isTrusted).
  let gestureWindow: Window | null = null;
  function gesture(e: PointerEvent) {
    if (e.isTrusted) api.home.gesture(widget.id);
  }
  // The widget's link: `ressacOpen` (provided by the guard in the page's world) emits this event, which the
  // parent chrome listens to (an opaque origin cannot post it a message). The request stays subject to the gesture.
  function link(e: Event) {
    api.home.open(String((e as CustomEvent).detail), widget.id);
  }
  function detachGesture() {
    gestureWindow?.removeEventListener("pointerdown", gesture, true);
    gestureWindow?.removeEventListener("ressac-open", link, true);
    gestureWindow = null;
  }
  function attachGesture() {
    detachGesture();
    // The document's window (defaultView) rather than the frame proxy: it is the one that receives the events.
    const frame = iframe?.contentDocument?.defaultView ?? iframe?.contentWindow;
    if (!frame) return;
    // No condition on the guard: the gesture is an `isTrusted` press seen by the chrome, which the page cannot
    // forge; the guard's state does not change that. It protects data output, not this link.
    gestureWindow = frame as unknown as Window;
    frame.addEventListener("pointerdown", gesture as EventListener, true);
    frame.addEventListener("ressac-open", link, true);
  }
  onMount(attachGesture);
  onDestroy(detachGesture);

  function onLoad() {
    send();
    attachGesture();
  }
  // An iframe of this chrome page never gets `load` (measured: neither the element nor its `onload`), so the data would
  // never reach a display loaded after its last change. DOMFrameContentLoaded (chrome only, seen from the document) comes
  // once the display's scripts have run.
  $effect(() => {
    const onLoaded = (e: Event) => iframe && e.target === iframe && onLoad();
    document.addEventListener("DOMFrameContentLoaded", onLoaded, true);
    return () => document.removeEventListener("DOMFrameContentLoaded", onLoaded, true);
  });
</script>

<svelte:window onmessage={onMessage} onfocusin={onFocusin} onblur={onBlur} />

<div class="content" bind:clientWidth={width} bind:clientHeight={height}>
  {#if widget.src}
    <!-- Without allow-same-origin: the code written by the agent runs in an opaque origin, with no access to the interface. -->
    <iframe bind:this={iframe} src={widget.src} title={widget.name} sandbox="allow-scripts"></iframe>
  {:else}
    <p class="empty">{t("home-widget-no-display")}</p>
  {/if}
</div>

<style>
  .content { flex: 1; min-height: 0; display: flex; }
  /* The card background while loading: no white flash in dark mode. */
  iframe { flex: 1; width: 100%; height: 100%; border: none; background: var(--home-card); }
  .empty { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--home-text-muted); }
</style>
