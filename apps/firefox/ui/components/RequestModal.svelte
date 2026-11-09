<script lang="ts">
  import { command } from "./command.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { UNLOCK_REASON_LENGTH, unlockedConsoleText } from "../../shared/extensions-messages";
  import { siteOf, type PendingRequest, type TabId } from "../../shared/model";
  import { api } from "../state.svelte";
  import ExtensionRequest from "./ExtensionRequest.svelte";
  import DevToolsRequest from "./DevToolsRequest.svelte";
  import FrozenBackground from "./FrozenBackground.svelte";

  /** `ongletId`: the page shown at opening, captured for the background (null: none, or a panel hides it). */
  let { request: request, tabId: tabId }: { request: PendingRequest; tabId: TabId | null } = $props();

  /** Enter only authorizes a card visible for at least this delay: a keystroke meant for the page is not a grant. */
  const ENTRY_DELAY_MS = 400;

  let card: HTMLElement;
  let ready = $state(false);
  // Enter armed: the card has been visible since ENTRY_DELAY_MS (re-armed on each request from the queue).
  let armed = $state(false);
  let entryTimer: ReturnType<typeof setTimeout> | undefined;
  function armer() {
    clearTimeout(entryTimer);
    armed = false;
    if (ready) entryTimer = setTimeout(() => (armed = true), ENTRY_DELAY_MS);
  }

  const devTools = $derived(request.permissions.includes("devtools"));
  const widgetData = $derived(request.permissions.includes("widget-data"));
  const extension = $derived(request.permissions.includes("extension"));
  const consoleExtension = $derived(request.permissions.includes("extension-console"));
  /** Extension name (manifest) and agent reason: data, shown as text and bounded. */
  const extensionName = $derived((request.title ?? request.origin).slice(0, 60));
  /** The spaces the unlock covers: names given by the user, shown as text and bounded. */
  const extensionSpaces = $derived((request.spaces ?? []).slice(0, 20).map((e) => e.slice(0, 60)));
  const agentReason = $derived((request.reason ?? "").slice(0, UNLOCK_REASON_LENGTH));
  const site = $derived(siteOf(request.origin));

  // A single opening for the whole queue: following requests replace the content, the page stays hidden.
  onMount(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.focus();
    return () => {
      clearTimeout(entryTimer);
      // Focus goes back where it was, if it is still in the interface (not on the web page, which takes its own back):
      // after the update, when the rest of the interface is no longer inert.
      queueMicrotask(() => {
        if (before?.isConnected && before !== document.body) before.focus();
      });
    };
  });

  // Next request in the queue: its content replaces the old one, focus stays in the modal.
  $effect(() => {
    void request.id;
    untrack(armer);
    void tick().then(() => {
      if (card && !card.contains(document.activeElement)) card.focus();
    });
  });

  // The command bar opened or closed on top re-arms Enter: the keystroke that closed it is not a grant.
  $effect(() => {
    void command.open;
    untrack(armer);
  });

  const deny = () => api.permissions.reply(request.id, "deny");
  const focusables = () =>
    [...card.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])")].filter((e) => !e.hasAttribute("disabled"));

  function clavier(e: KeyboardEvent) {
    // The command bar opened on top keeps the keyboard: the hidden modal reacts to nothing, even if focus has left the
    // bar's field (neither Enter, nor Escape before the ⌃Tab panel takes over, nor Tab).
    if (command.open || e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      deny();
    } else if (e.key === "Enter") {
      // Card not visible yet, or only for too short a time: Enter does nothing, even on a button.
      if (!armed) return e.preventDefault();
      // A focused button keeps its own action; everywhere else (checkboxes included), Enter authorizes.
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      e.preventDefault();
      if (!e.repeat) card.querySelector<HTMLButtonElement>("[data-principal]")?.click();
    } else if (e.key === "Tab") {
      // Focus does not leave the modal: Tab loops over its controls.
      const list = focusables();
      if (list.length === 0) return e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const target = e.shiftKey ? (i <= 0 ? list.at(-1) : null) : i === -1 || i === list.length - 1 ? list[0] : null;
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
  }
</script>

<svelte:window onkeydown={clavier} />

<!-- Under the command bar, nothing in the modal can take focus (native Tab from the page body). -->
<div class="modale" class:prete={ready} data-testid="modale-demande" data-armee={armed || undefined} inert={!!command.open}>
  <FrozenBackground
    tabId={tabId}
    onReady={() => {
      ready = true;
      armer();
    }}
  />
  <div
    class="carte"
    bind:this={card}
    tabindex="-1"
    role="alertdialog"
    aria-modal="true"
    aria-describedby={request.extension?.hardened ? "carte-extension-avertissement" : undefined}
    aria-label={devTools
      ? "Demande d'accès aux outils de développement"
      : widgetData
        ? request.action !== undefined
          ? "Demande d'accès aux résultats d'une action"
          : request.site !== undefined
            ? "Demande d'accès à une appli de site"
            : "Demande d'accès aux données d'un widget"
        : extension
          ? "Activer une extension"
          : consoleExtension
            ? "Débloquer la console d'une extension"
            : "Demande d'autorisation"}
  >
    {#key request.id}
      {#if devTools}
        <DevToolsRequest request={request} />
      {:else if extension}
        {#if request.extension}
          <ExtensionRequest request={request} card={request.extension} />
        {:else}
          <!-- Never set without a card; if it were, nothing activates without having been shown. -->
          <div class="lecture">
            <p>Demande d'extension illisible.</p>
            <div class="actions"><button data-principal onclick={deny}>Refuser</button></div>
          </div>
        {/if}
      {:else if consoleExtension}
        <div class="lecture" data-testid="demande-console-extension">
          <p>{unlockedConsoleText(extensionName, extensionSpaces)}</p>
          {#if agentReason}<p class="raison">Raison donnée par {request.agent ?? "l'agent"} : « {agentReason} »</p>{/if}
          <div class="actions">
            <!-- Enter refuses: showing the agent what an extension reads on unshared tabs takes a real click. -->
            <button data-principal onclick={deny}>Refuser</button>
            <button class="autoriser" onclick={() => api.permissions.reply(request.id, "allow")}>Débloquer</button>
          </div>
        </div>
      {:else if widgetData}
        <div class="lecture" data-testid="demande-donnees-widget">
          {#if request.action !== undefined}
            <p>L'agent veut voir les résultats de l'action « {request.title ?? request.action} » (lus avec ton compte).</p>
          {:else if request.site !== undefined}
            <p data-testid="demande-site">L'agent veut voir l'appli de site « {request.title ?? request.site} » (connectée à ton compte) : ses pages et sa mémoire, pour cette conversation.</p>
          {:else}
            <p>L'agent veut voir les données du widget « {request.title ?? request.widget} » (lues avec ton compte).</p>
          {/if}
          <div class="actions">
            <!-- Enter refuses: showing the agent data read with the account takes a real click. -->
            <button data-principal onclick={deny}>Refuser</button>
            <button class="autoriser" onclick={() => api.permissions.reply(request.id, "allow")}>Autoriser pour cette conversation</button>
          </div>
        </div>
      {:else}
        <div class="lecture" data-testid="demande-permission">
          <p>L'agent veut lire l'onglet « {request.title ?? site} »</p>
          <div class="actions">
            <button onclick={deny}>Refuser</button>
            <button class="autoriser" data-principal onclick={() => api.permissions.reply(request.id, "allow")}>Autoriser une fois</button>
          </div>
        </div>
      {/if}
    {/key}
  </div>
</div>

<style>
  .modale { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; -webkit-app-region: no-drag; }
  .carte {
    position: relative;
    width: min(440px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 14px 18px;
    background: var(--fond-actif);
    color: var(--texte);
    border: 1px solid var(--bord);
    border-radius: 12px;
    box-shadow: var(--ombre-modale);
    font-size: 13px;
    line-height: 1.45;
    outline: none;
    opacity: 0;
    transform: translateY(6px) scale(0.98);
    transition: opacity 120ms ease-out, transform 120ms ease-out;
  }
  .prete .carte { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .carte { transition: none; transform: none; }
  }
  .lecture p { margin: 0 0 12px; font-size: 14px; overflow-wrap: anywhere; }
  .lecture p.raison { font-size: 13px; color: var(--texte-doux, inherit); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .autoriser { background: var(--accent); border-color: var(--accent); color: white; }
</style>
