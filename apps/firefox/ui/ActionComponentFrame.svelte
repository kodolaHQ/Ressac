<script lang="ts">
  import RemoteFrame, { type RemoteFrameHandle } from "./RemoteFrame.svelte";
  import { t } from "./i18n.svelte";

  /**
   * An agent component in its isolated frame (RemoteFrame: out of the parent process, sandboxed, opaque origin),
   * served from its sanitized resource:// copy (chrome/store/action-media.ts), served again on each actions.change (the
   * agent may have rewritten it: a new mtime, a new URL). It gets its props, the theme, the Aura tokens and its width by message; its
   * `parent.postMessage` becomes a `ressac-component` event (the copy's bridge) the frames' actor forwards as `component`.
   * It can only ask for its height; anything else, a `ressacOpen` link included, is ignored.
   */
  let { name, props }: { name: string; props: Record<string, unknown> } = $props();

  const MIN_HEIGHT = 20;
  const MAX_HEIGHT = 2000;
  const actions = window.ressac.actions;
  let frame = $state<RemoteFrameHandle>();
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

  /** The Aura tokens a component may use as CSS variables (the bridge sets them on its root), as resolved here. */
  const TOKENS = ["--bg", "--sheet", "--text", "--text-muted", "--glass", "--border", "--accent", "--accent-ink", "--a1", "--a2", "--a3", "--font-display", "--font-ui", "--font-mono"];
  function tokens(): Record<string, string> {
    const s = getComputedStyle(document.documentElement);
    return { ...Object.fromEntries(TOKENS.map((t) => [t, s.getPropertyValue(t).trim()])), "--radius-card": "16px", "--radius-control": "10px" };
  }

  /** The frame shows the current copy: never an older copy, nor a page it navigated to. */
  // Without the fragment: a component that sets its own #hash stays on its copy.
  const accept = (uri: string) => !!src && uri.split("#")[0] === src;

  function send() {
    void frame?.send({ type: "component", props: $state.snapshot(props), theme, width: width, tokens: tokens() });
  }
  // On each change (loading goes through onload).
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
    const off = actions.onComponentChange(serve);
    return () => {
      alive = false;
      off();
      for (; held > 0; held--) actions.releaseComponent(n);
    };
  });

  function onMessage(kind: string, d: { type?: unknown; px?: unknown }) {
    // The component can dispatch this event itself, with any detail.
    if (kind !== "component") return;
    const { type, px } = d;
    if (type !== "height" || typeof px !== "number" || !Number.isFinite(px)) return;
    height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, px)));
  }
</script>

<div data-testid="block-{name}" bind:clientWidth={width}>
  <div class="pa-component" style:height="{height}px">
    <RemoteFrame {src} {accept} title={name} stoppedText={t("frame-stopped")} testid="component-frame" bind:frame onload={send} onmessage={onMessage} />
  </div>
</div>
