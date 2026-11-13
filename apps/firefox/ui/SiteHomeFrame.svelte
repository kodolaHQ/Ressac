<script lang="ts">
  import { onMount } from "svelte";
  import { ENTER_THE_SITE, HomeMessage, type MessageToHome } from "../shared/sites";
  import type { ApiSite } from "../shared/api";

  /**
   * The app's home screen, written by the agent, in a sandboxed opaque frame
   * (`sandbox="allow-scripts"`) served from its sanitized copy (chrome/store/site-home.ts). Its `parent.postMessage`
   * reaches the chrome as a `ressac-home` event (the copy's bridge), listened above the frame on the window root,
   * before it loads. A message counts only from this frame showing this app's home; real presses are seen on the
   * frame's window (isTrusted), as for the widgets (WidgetFrame.svelte).
   */
  let { id, api }: { id: string; api: ApiSite } = $props();
  let frame = $state<HTMLIFrameElement>();
  let src = $state<string | null>(null);
  const controller = window.parent.ressacSiteWindow!;

  /** The frame's document is a page of this app's served home copy (never an address it navigated to). */
  function ours(): boolean {
    let u: URL;
    try {
      u = new URL(frame?.contentDocument?.documentURI ?? "");
    } catch {
      return false;
    }
    // The host is the current copy's (random at each serve): never another app's home, nor an older copy.
    return !!src && u.protocol === "resource:" && u.host === new URL(src).host && u.pathname.endsWith(".html");
  }

  /** Opaque origin: the target can only be « * »; only this frame's document receives. */
  const send = (m: MessageToHome) => {
    if (ours()) frame?.contentWindow?.postMessage(m, "*");
  };

  const refresh = () =>
    void controller.homeUrl().then(
      (u) => {
        if (u !== src) src = u;
      },
      () => {},
    );

  let gestureWindow: Window | null = null;
  const gesture = (e: Event) => e.isTrusted && ours() && controller.homeGesture();

  onMount(() => {
    const onMessage = (e: Event) => {
      if (!frame || e.target !== frame.contentWindow || !ours()) return;
      let data: unknown;
      try {
        data = JSON.parse(String((e as CustomEvent).detail));
      } catch {
        return;
      }
      const r = HomeMessage.safeParse(data);
      if (!r.success) return;
      const m = r.data;
      if (m.type === "ready") void api.memory().then(send, () => {});
      else if (m.type === "open") void api.open(m.url).catch(() => {});
      else
        void api.image(m.url).then(
          (data) => send({ type: "image", n: m.n, data }),
          () => send({ type: "image", n: m.n, data: null }),
        );
    };
    // The window root sees the events of the window's in-process frames, the `ready` sent while the home is parsed too.
    const root = (window as unknown as { windowRoot: EventTarget }).windowRoot;
    (root.addEventListener as (t: string, l: EventListener, c: boolean, untrusted: boolean) => void)("ressac-home", onMessage, true, true);
    // An iframe of this chrome page never gets `load`: DOMFrameContentLoaded comes once the home's scripts have run.
    const onLoaded = (e: Event) => {
      if (!frame || e.target !== frame) return;
      // about:blank (the only other page guardHome lets load): back to its own page.
      if (src && !ours()) return void (frame.src = src);
      gestureWindow?.removeEventListener("pointerdown", gesture, true);
      gestureWindow = (frame.contentDocument?.defaultView as Window | null) ?? null;
      gestureWindow?.addEventListener("pointerdown", gesture, true);
    };
    document.addEventListener("DOMFrameContentLoaded", onLoaded, true);
    controller.guardHome(frame!);
    refresh();
    const endState = api.onState(refresh);
    const end = api.onMemory(send);
    return () => {
      root.removeEventListener("ressac-home", onMessage, true);
      document.removeEventListener("DOMFrameContentLoaded", onLoaded, true);
      gestureWindow?.removeEventListener("pointerdown", gesture, true);
      endState();
      end();
    };
  });
</script>

<section class="home" data-testid="site-home-zone">
  <iframe bind:this={frame} data-testid="site-home-frame" title="Accueil de l'appli" sandbox="allow-scripts" src={src ?? "about:blank"}></iframe>
  <footer>
    <button data-testid="site-enter" onclick={() => api.enter()}>{ENTER_THE_SITE}</button>
  </footer>
</section>

<style>
  .home { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  iframe { flex: 1; width: 100%; border: 0; min-height: 0; background: var(--bg); }
  footer { display: flex; justify-content: center; padding: 10px 16px; border-top: 1px solid var(--border); }
  button { all: unset; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); font-weight: 600; cursor: default; -webkit-app-region: no-drag; }
  button:hover { filter: brightness(1.1); }
</style>
