<script lang="ts" module>
  /** What a RemoteFrame's owner holds (bind:frame). */
  export interface RemoteFrameHandle {
    /** Posts `data` into the page (its `message` event); dropped if the frame is gone, between documents or not accepted. */
    send(data: unknown): Promise<void>;
    element: Element;
  }
</script>

<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  /**
   * An agent-written frame in a remote <browser> of the frames' web content process (chrome/window/remote-frame.ts):
   * sandboxed like `<iframe sandbox="allow-scripts">`, out of the parent process. Its page's events come back through
   * the RessacFrame actor; `press` and `focus` are the user's own (trusted) events. Only a document whose address
   * `accept`s is the owner's: any other is sent back to `src` (bounded: frameReverter), sent nothing, and its events dropped.
   * A document without a null principal is never the owner's either (frameSandboxed). When the frames' process dies the
   * frame loads its copy again in a new one (remote-frame.ts); past a few deaths a minute it shows `stoppedText` instead.
   */
  let {
    src,
    accept,
    title,
    stoppedText,
    testid,
    onmessage,
    onload,
    onpress,
    onfocus,
    frame = $bindable(),
  }: {
    src: string | null;
    accept: (uri: string) => boolean;
    title: string;
    /** Shown in place of a frame whose process kept dying (the owner's language). */
    stoppedText: string;
    testid?: string;
    /** `open`: `{ url }`; `home` and `component`: their detail, parsed (a non-object or bad JSON never comes). */
    onmessage?: (name: string, data: Record<string, unknown>) => void;
    onload?: (uri: string) => void;
    onpress?: () => void;
    onfocus?: () => void;
    frame?: RemoteFrameHandle;
  } = $props();

  type RemoteFrames = typeof import("../chrome/window/remote-frame");
  const frames: RemoteFrames = ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").remoteFrames;

  let host = $state<HTMLDivElement>();
  let stopped = $state(false);
  let browser: Element | null = null;
  let off: (() => void) | null = null;
  /** The address last loaded: an owner's getter (`src={widget.src}`) reruns this effect on every new widget object. */
  let loaded: string | null = null;

  // Made on the first src, inserted and loaded at once: loadFrame keeps the group id the next browsers join.
  $effect(() => {
    const s = src;
    // The same address again would reload the page: each home read (any widget's harvest) reloaded every widget,
    // dropping a click under way and the page's own state.
    if (!s || !host || s === loaded) return;
    if (!browser) {
      const b = frames.createFrameBrowser(document, (revived) => {
        // Revived: a new browsing context in the same element, a new handle so the owner's per-context work (the home's guard) runs again.
        if (revived) frame = handle();
        // shortcut: a stopped frame stays so until its owner remounts (the page shown again), upgrade if a real use hits it.
        else stopped = true;
      });
      b.setAttribute("aria-label", untrack(() => title));
      host.append(b);
      browser = b;
      const reverter = frames.frameReverter(b);
      const ours = () => {
        const u = frames.frameUri(b);
        return u !== null && accept(u) && frames.frameSandboxed(b);
      };
      off = frames.onFrameMessage(b, (name, data) => {
        if (name === "loaded") {
          reverter.loaded(() => {
            // Left its copy (the initial about:blank included: this first revert is what loads it): sent back.
            if (!ours()) {
              if (src) reverter.revert(src);
            } else onload?.(String(data.uri));
          });
        } else if (!ours()) return;
        else if (name === "press") onpress?.();
        else if (name === "focus") onfocus?.();
        else if (typeof data.detail !== "string") onmessage?.(name, data);
        else {
          let d: unknown;
          try {
            d = JSON.parse(data.detail);
          } catch {
            return;
          }
          if (typeof d === "object" && d !== null) onmessage?.(name, d as Record<string, unknown>);
        }
      });
      const handle = (): RemoteFrameHandle => ({ send: async (d) => (ours() ? frames.sendFrame(b, d) : undefined), element: b });
      frame = handle();
    }
    if (frames.loadFrame(browser, s)) loaded = s;
  });

  $effect(() => browser?.setAttribute("aria-label", title));

  onDestroy(() => {
    off?.();
    browser?.remove();
  });
</script>

<div class="remote-frame" bind:this={host} data-testid={testid} style:display={stopped ? "none" : null}></div>
{#if stopped}
  <p class="stopped" data-testid="frame-stopped">{stoppedText}</p>
{/if}

<style>
  .remote-frame { flex: 1; min-height: 0; display: flex; }
  .remote-frame :global(browser) { flex: 1; width: 100%; height: 100%; border: none; }
  .stopped { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--text-muted); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
