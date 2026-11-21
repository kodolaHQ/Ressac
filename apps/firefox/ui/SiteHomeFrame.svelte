<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { ts } from "./site/locale.svelte";
  import RemoteFrame, { type RemoteFrameHandle } from "./RemoteFrame.svelte";
  import SiteGrantCard from "./site/SiteGrantCard.svelte";
  import { HomeMessage, type MessageToHome, type SiteStartRequest } from "../shared/sites";
  import type { HomeChrome } from "../chrome/store/sites";
  import type { HomeApi } from "./site-api";

  /**
   * The app's home screen, written by the agent, in a remote frame (RemoteFrame: out of the parent process, sandboxed,
   * opaque origin) served from its sanitized copy (chrome/store/site-home.ts). Its `parent.postMessage` becomes a
   * `ressac-home` event (the copy's bridge) the frames' actor forwards as `home`. A message counts only from this frame
   * showing this app's home; presses come from the actor, as for the widgets. `controller`: the app window's, or the
   * essential tab's (sidebar.html?tabhome).
   */
  let { api, controller }: { api: HomeApi; controller: HomeChrome } = $props();
  let frame = $state<RemoteFrameHandle>();
  let src = $state<string | null>(null);
  /** An address the home asked for that waits on « Ouvrir » (not the accepted start). */
  let asked = $state<SiteStartRequest | null>(null);

  /** The frame's document is a page of this app's served home copy (never an address it navigated to). */
  function accept(uri: string): boolean {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    // The folder is the current copy's (random key at each serve): never another app's home, nor an older copy.
    return !!src && u.protocol === "resource:" && u.host === new URL(src).host && u.pathname.startsWith(new URL(src).pathname.replace(/[^/]*$/, "")) && u.pathname.endsWith(".html");
  }

  const send = (m: MessageToHome) => void frame?.send(m);

  const refresh = () => {
    const a = controller.homeAsk();
    asked = a && structuredClone(a);
    void controller.homeUrl().then(
      (u) => {
        if (u !== src) src = u;
      },
      () => {},
    );
  };

  function onMessage(name: string, d: unknown) {
    if (name !== "home") return;
    const r = HomeMessage.safeParse(d);
    if (!r.success) return;
    const m = r.data;
    if (m.type === "ready") void api.memory().then(send, () => {});
    else if (m.type === "open") void api.open(m.url).then(refresh, () => {});
    else
      void api.image(m.url).then(
        (data) => send({ type: "image", n: m.n, data }),
        () => send({ type: "image", n: m.n, data: null }),
      );
  }

  // The frame's <browser> is made on the first src: guarded once it exists, and again on each new handle (a new browsing
  // context after its process died).
  let guarded: RemoteFrameHandle | null = null;
  $effect(() => {
    if (frame && frame !== guarded) controller.guardHome((guarded = frame).element);
  });

  onMount(() => {
    refresh();
    const endState = api.onState(refresh);
    const end = api.onMemory(send);
    return () => {
      endState();
      end();
    };
  });
</script>

<section class="home" data-testid="site-home-zone">
  <RemoteFrame {src} {accept} title={ts("chrome-site-home")} stoppedText={ts("frame-stopped")} testid="site-home-frame" bind:frame onmessage={onMessage} onpress={() => controller.homeGesture()} />
  {#if asked}
    <div class="ask" out:fade={{ duration: 150 }}>
      <SiteGrantCard grant={null} start={asked} onGrant={async (yes, hash) => controller.answerHomeAsk(yes, hash)} />
    </div>
  {/if}
  <footer>
    <button data-testid="site-enter" onclick={() => api.enter()}>{ts("chrome-site-enter")}</button>
  </footer>
</section>

<style>
  .home { flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; background: var(--bg); }
  .ask { position: absolute; inset: 0; display: flex; background: color-mix(in oklab, var(--bg) 60%, transparent); }
  footer { display: flex; justify-content: center; padding: 10px 16px; border-top: 1px solid var(--border); }
  button { all: unset; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); font-weight: 600; cursor: default; -webkit-app-region: no-drag; }
  button:hover { filter: brightness(1.1); }
</style>
