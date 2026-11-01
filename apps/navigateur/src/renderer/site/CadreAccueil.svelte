<script lang="ts">
  import { onMount } from "svelte";
  import { ENTRER_DANS_LE_SITE, MessageDeLAccueil, urlAccueilSite, type MessageVersLAccueil } from "../../commun/sites";
  import type { ApiSite } from "../../commun/api";

  /**
   * L'écran d'accueil de l'appli, écrit par l'agent : un cadre sans réseau à origine opaque (`sandbox="allow-scripts"`).
   * Il ne peut que lire la mémoire de l'appli, demander une adresse du site et des images du site, par postMessage ;
   * tout autre message, ou venu d'ailleurs que de son cadre, est ignoré.
   */
  let { id, api }: { id: string; api: ApiSite } = $props();
  let cadre = $state<HTMLIFrameElement>();

  /** Origine opaque : la cible ne peut être que « * » ; seul le cadre de l'accueil reçoit (contentWindow). */
  const envoyer = (m: MessageVersLAccueil) => cadre?.contentWindow?.postMessage(m, "*");

  onMount(() => {
    const surMessage = (e: MessageEvent) => {
      if (!cadre || e.source === null || e.source !== cadre.contentWindow) return;
      const r = MessageDeLAccueil.safeParse(e.data);
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
    addEventListener("message", surMessage);
    const fin = api.surMemoire(envoyer);
    return () => {
      removeEventListener("message", surMessage);
      fin();
    };
  });
</script>

<section class="accueil" data-testid="site-zone-accueil">
  <iframe bind:this={cadre} data-testid="site-cadre-accueil" title="Accueil de l'appli" sandbox="allow-scripts" src={urlAccueilSite(id)}></iframe>
  <footer>
    <button data-testid="site-entrer" onclick={() => api.entrer()}>{ENTRER_DANS_LE_SITE}</button>
  </footer>
</section>

<style>
  .accueil { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  iframe { flex: 1; width: 100%; border: 0; min-height: 0; background: var(--fond); }
  footer { display: flex; justify-content: center; padding: 10px 16px; border-top: 1px solid var(--bord); }
  button { all: unset; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: white; font-weight: 600; cursor: default; -webkit-app-region: no-drag; }
  button:hover { filter: brightness(1.1); }
</style>
