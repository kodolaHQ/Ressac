<script lang="ts" module>
  /** What a RemoteFrame's owner holds (bind:frame). */
  export interface RemoteFrameHandle {
    /** Posts `data` into the page (its `message` event); dropped if the frame is gone or between documents. */
    send(data: unknown): Promise<void>;
    /** The page's current document address. */
    uri(): string | null;
    element: Element;
  }
</script>

<script lang="ts">
  import { onDestroy, untrack } from "svelte";

  /**
   * An agent-written frame in a remote <browser> of the frames' web content process (chrome/window/remote-frame.ts):
   * sandboxed like `<iframe sandbox="allow-scripts">`, out of the parent process. Its page's events come back through
   * the RessacFrame actor; `press` and `focus` are the user's own (trusted) events.
   */
  let {
    src,
    title,
    testid,
    onmessage,
    onload,
    onpress,
    onfocus,
    frame = $bindable(),
  }: {
    src: string | null;
    title: string;
    testid?: string;
    onmessage?: (name: string, data: { url?: string; detail?: string }) => void;
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
      off = frames.onFrameMessage(b, (name, data) => {
        if (name === "loaded") onload?.(String(data.uri));
        else if (name === "press") onpress?.();
        else if (name === "focus") onfocus?.();
        else onmessage?.(name, data);
      });
      frame = { send: (d) => frames.sendFrame(b, d), uri: () => frames.frameUri(b), element: b };
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
