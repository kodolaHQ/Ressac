<script lang="ts">
  import { onMount } from "svelte";
  import { ENTER_THE_SITE, HomeMessage, type MessageToHome } from "../shared/sites";
  import type { ApiSite } from "../shared/api";

  /**
   * The app's home screen, written by the agent, in a sandboxed opaque frame
   * (`sandbox="allow-scripts"`) served from its sanitized copy (chrome/store/site-home.ts). Its `parent.postMessage`
   * reaches the chrome as a `webaios-home` event (the copy's bridge), listened above the frame on the window root,
   * before it loads. A message counts only from this frame showing this app's home; real presses are seen on the
   * frame's window (isTrusted), as for the widgets (CadreWidget.svelte).
   */
  let { id, api }: { id: string; api: ApiSite } = $props();
  let cadre = $state<HTMLIFrameElement>();
  let src = $state<string | null>(null);
  const controller = window.parent.webaiosSiteWindow!;

  /** The frame's document is a page of this app's served home copy (never an address it navigated to). */
  function ours(): boolean {
    let u: URL;
    try {
      u = new URL(cadre?.contentDocument?.documentURI ?? "");
    } catch {
      return false;
    }
    // The host is the current copy's (random at each serve): never another app's home, nor an older copy.
    return !!src && u.protocol === "resource:" && u.host === new URL(src).host && u.pathname.endsWith(".html");
  }

  /** Opaque origin: the target can only be « * »; only this frame's document receives. */
  const envoyer = (m: MessageToHome) => {
    if (ours()) cadre?.contentWindow?.postMessage(m, "*");
  };

  const refresh = () =>
    void controller.homeUrl().then(
      (u) => {
        if (u !== src) src = u;
      },
      () => {},
    );

  let fenetreGeste: Window | null = null;
  const geste = (e: Event) => e.isTrusted && ours() && controller.homeGesture();

  onMount(() => {
    const surMessage = (e: Event) => {
      if (!cadre || e.target !== cadre.contentWindow || !ours()) return;
      let data: unknown;
      try {
        data = JSON.parse(String((e as CustomEvent).detail));
      } catch {
        return;
      }
      const r = HomeMessage.safeParse(data);
      if (!r.success) return;
      const m = r.data;
      if (m.type === "pret") void api.memoire().then(envoyer, () => {});
      else if (m.type === "ouvrir") void api.ouvrir(m.adresse).catch(() => {});
      else
        void api.image(m.url).then(
          (data) => envoyer({ type: "image", n: m.n, data }),
          () => envoyer({ type: "image", n: m.n, data: null }),
        );
    };
    // The window root sees the events of the window's in-process frames, the `pret` sent while the home is parsed too.
    const root = (window as unknown as { windowRoot: EventTarget }).windowRoot;
    (root.addEventListener as (t: string, l: EventListener, c: boolean, untrusted: boolean) => void)("webaios-home", surMessage, true, true);
    // An iframe of this chrome page never gets `load`: DOMFrameContentLoaded comes once the home's scripts have run.
    const charge = (e: Event) => {
      if (!cadre || e.target !== cadre) return;
      // about:blank (the only other page guardHome lets load): back to its own page.
      if (src && !ours()) return void (cadre.src = src);
      fenetreGeste?.removeEventListener("pointerdown", geste, true);
      fenetreGeste = (cadre.contentDocument?.defaultView as Window | null) ?? null;
      fenetreGeste?.addEventListener("pointerdown", geste, true);
    };
    document.addEventListener("DOMFrameContentLoaded", charge, true);
    controller.guardHome(cadre!);
    refresh();
    const finEtat = api.surEtat(refresh);
    const fin = api.surMemoire(envoyer);
    return () => {
      root.removeEventListener("webaios-home", surMessage, true);
      document.removeEventListener("DOMFrameContentLoaded", charge, true);
      fenetreGeste?.removeEventListener("pointerdown", geste, true);
      finEtat();
      fin();
    };
  });
</script>

<section class="accueil" data-testid="site-zone-accueil">
  <iframe bind:this={cadre} data-testid="site-cadre-accueil" title="Accueil de l'appli" sandbox="allow-scripts" src={src ?? "about:blank"}></iframe>
  <footer>
    <button data-testid="site-entrer" onclick={() => api.entrer()}>{ENTER_THE_SITE}</button>
  </footer>
</section>

<style>
  .accueil { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  iframe { flex: 1; width: 100%; border: 0; min-height: 0; background: var(--fond); }
  footer { display: flex; justify-content: center; padding: 10px 16px; border-top: 1px solid var(--bord); }
  button { all: unset; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: white; font-weight: 600; cursor: default; -webkit-app-region: no-drag; }
  button:hover { filter: brightness(1.1); }
</style>
