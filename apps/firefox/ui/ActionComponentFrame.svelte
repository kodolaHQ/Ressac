<script lang="ts">
  /**
   * An agent component in a sandboxed opaque frame (`sandbox="allow-scripts"`),
   * served from its sanitized resource:// copy (chrome/store/action-media.ts), served again on each actions.change (the
   * agent may have rewritten it: a new mtime, a new URL). It gets its props, the theme and its width by message; its
   * `parent.postMessage` reaches the chrome as a `webaios-component` event (the copy's bridge), listened on the window
   * root. It can only ask for its height; anything else, a `webaiosOpen` link included, is ignored.
   */
  let { name: name, props }: { name: string; props: Record<string, unknown> } = $props();

  const MIN_HEIGHT = 20;
  const MAX_HEIGHT = 2000;
  const actions = window.webaios.actions;
  let iframe = $state<HTMLIFrameElement>();
  let src = $state<string | null>(null);
  let width = $state(0);
  let height = $state(150);
  const sombre = matchMedia("(prefers-color-scheme: dark)");
  let theme = $state<"light" | "dark">(sombre.matches ? "dark" : "light");

  $effect(() => {
    const follow = () => (theme = sombre.matches ? "dark" : "light");
    sombre.addEventListener("change", follow);
    return () => sombre.removeEventListener("change", follow);
  });

  /** The frame shows the current copy: never an older copy, nor a page it navigated to. */
  const ours = () => !!src && iframe?.contentDocument?.documentURI === src;

  function send() {
    // Opaque origin: « * » is the only possible target; only the current copy receives.
    if (ours()) iframe?.contentWindow?.postMessage({ type: "component", props: $state.snapshot(props), theme, width: width }, "*");
  }
  // On each change (the load goes through DOMFrameContentLoaded).
  $effect(() => {
    void [props, theme, width];
    send();
  });

  // Served on mount and on each actions.change; each serve is paired with a release, the last one when unmounted.
  $effect(() => {
    const n = name;
    let alive = true;
    let held = 0;
    const serve = () => {
      held++;
      void actions.serveComponent(n).then(
        (u) => {
          if (!alive) return;
          // Serves of one name resolve in order: the older copy's reference goes once the newer one is known.
          if (held > 1) {
            held--;
            actions.releaseComponent(n);
          }
          src = u;
        },
        () => {},
      );
    };
    serve();
    const off = actions.onChange(serve);
    return () => {
      alive = false;
      off();
      for (; held > 0; held--) actions.releaseComponent(n);
    };
  });

  $effect(() => {
    const onMessage = (e: Event) => {
      if (!iframe || e.target !== iframe.contentWindow || !ours()) return;
      // The component can dispatch this event itself, with any detail.
      const detail: unknown = (e as CustomEvent).detail;
      if (typeof detail !== "string") return;
      let d: unknown;
      try {
        d = JSON.parse(detail);
      } catch {
        return;
      }
      if (typeof d !== "object" || d === null) return;
      const { type, px } = d as { type?: unknown; px?: unknown };
      if (type !== "height" || typeof px !== "number" || !Number.isFinite(px)) return;
      height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, px)));
    };
    // The window root sees the events of the window's in-process frames (SiteHomeFrame.svelte); untrusted ones too.
    const root = (window as unknown as { windowRoot: EventTarget }).windowRoot;
    (root.addEventListener as (t: string, l: EventListener, c: boolean, untrusted: boolean) => void)("webaios-component", onMessage, true, true);
    // An iframe of this chrome page never gets `load`: DOMFrameContentLoaded comes once the component's scripts have run.
    const onLoaded = (e: Event) => iframe && e.target === iframe && send();
    document.addEventListener("DOMFrameContentLoaded", onLoaded, true);
    return () => {
      root.removeEventListener("webaios-component", onMessage, true);
      document.removeEventListener("DOMFrameContentLoaded", onLoaded, true);
    };
  });
</script>

<div data-testid="bloc-{name}" bind:clientWidth={width}>
  <iframe
    bind:this={iframe}
    class="pa-composant"
    data-testid="cadre-composant"
    title={name}
    src={src ?? "about:blank"}
    sandbox="allow-scripts"
    style:height="{height}px"
  ></iframe>
</div>
