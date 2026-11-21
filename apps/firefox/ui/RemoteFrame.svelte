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
   */
  let {
    src,
    accept,
    title,
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
  let browser: Element | null = null;
  let off: (() => void) | null = null;

  // Made on the first src, inserted and loaded at once: loadFrame keeps the group id the next browsers join.
  $effect(() => {
    const s = src;
    if (!s || !host) return;
    if (!browser) {
      const b = frames.createFrameBrowser(document);
      b.setAttribute("aria-label", untrack(() => title));
      host.append(b);
      browser = b;
      const reverter = frames.frameReverter(b);
      const ours = () => {
        const u = frames.frameUri(b);
        return u !== null && accept(u);
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
      frame = { send: async (d) => (ours() ? frames.sendFrame(b, d) : undefined), element: b };
    }
    frames.loadFrame(browser, s);
  });

  $effect(() => browser?.setAttribute("aria-label", title));

  onDestroy(() => {
    off?.();
    browser?.remove();
  });
</script>

<div class="remote-frame" bind:this={host} data-testid={testid}></div>

<style>
  .remote-frame { flex: 1; min-height: 0; display: flex; }
  .remote-frame :global(browser) { flex: 1; width: 100%; height: 100%; border: none; }
</style>
