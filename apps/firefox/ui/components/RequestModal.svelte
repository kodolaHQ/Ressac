<script lang="ts">
  import { command } from "./command.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { UNLOCK_REASON_LENGTH } from "../../shared/extensions-messages";
  import { siteOf, type PendingRequest, type TabId } from "../../shared/model";
  import { LABELS } from "../../../../packages/kernel/src/mask/table";
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import ExtensionRequest from "./ExtensionRequest.svelte";
  import DevToolsRequest from "./DevToolsRequest.svelte";
  import MaskRequest from "./MaskRequest.svelte";
  import MaskReveal from "./MaskReveal.svelte";
  import FrozenBackground from "./FrozenBackground.svelte";

  /** `ongletId`: the page shown at opening, captured for the background (null: none, or a panel hides it). */
  let { request, tabId }: { request: PendingRequest; tabId: TabId | null } = $props();

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
  const consoleText = $derived(
    t("home-request-console", {
      name: extensionName,
      where:
        extensionSpaces.length === 0
          ? t("home-request-console-where-profiles")
          : extensionSpaces.length === 1
            ? t("home-request-console-where-space", { space: extensionSpaces[0]! })
            : t("home-request-console-where-spaces", { spaces: extensionSpaces.map((e) => t("home-quoted", { name: e })).join(", ") }),
    }),
  );
  const agentReason = $derived((request.reason ?? "").slice(0, UNLOCK_REASON_LENGTH));
  const agentAddress = $derived(request.permissions.includes("agent-address"));
  const masking = $derived(request.permissions.some((p) => p.startsWith("mask-")));
  /** A masked handle in the address (`⟨id-…⟩`): « Voir l'adresse » shows it with the values, here only. */
  const addressLabels = $derived(agentAddress ? [...new Set(request.origin.match(LABELS) ?? [])].slice(0, 10) : []);
  const site = $derived(siteOf(request.origin));
  /** The address card's « Pourquoi on me demande ça ? » explanation, closed again for each request. */
  let why = $state(false);

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
    why = false;
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

  const deny = () => api.permissions.answer(request.id, "deny");
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
      if (!e.repeat) card.querySelector<HTMLButtonElement>("[data-main]")?.click();
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
<div class="modal" class:ready={ready} data-testid="request-modal" data-armed={armed || undefined} inert={!!command.open}>
  <FrozenBackground
    tabId={tabId}
    onReady={() => {
      ready = true;
      armer();
    }}
  />
  <div
    class="card"
    bind:this={card}
    tabindex="-1"
    role="alertdialog"
    aria-modal="true"
    aria-describedby={request.extension?.hardened ? "extension-card-warning" : undefined}
    aria-label={t(
      devTools
        ? "home-request-label-devtools"
        : widgetData
          ? request.action !== undefined
            ? "home-request-label-action"
            : request.site !== undefined
              ? "home-request-label-site"
              : request.history
                ? "home-request-label-history"
                : "home-request-label-widget"
          : extension
            ? "home-request-label-extension"
            : consoleExtension
              ? "home-request-label-console"
              : agentAddress
                ? "home-request-label-address"
                : masking
                  ? `home-request-label-${request.permissions[0]}`
                  : "home-request-label",
    )}
  >
    {#key request.id}
      {#if masking}
        <!-- One component per card: « Voir » left on never carries over to the next card's values. -->
        {#key request.id}<MaskRequest request={request} />{/key}
      {:else if devTools}
        <DevToolsRequest request={request} />
      {:else if extension}
        {#if request.extension}
          <ExtensionRequest request={request} card={request.extension} />
        {:else}
          <!-- Never set without a card; if it were, nothing activates without having been shown. -->
          <div class="reading">
            <p>{t("home-request-unreadable")}</p>
            <div class="actions"><button data-main onclick={deny}>{t("home-deny")}</button></div>
          </div>
        {/if}
      {:else if consoleExtension}
        <div class="reading" data-testid="extension-console-request">
          <p>{consoleText}</p>
          {#if agentReason}<p class="reason">{t("home-request-console-reason", { agent: request.agent ?? t("home-agent"), reason: agentReason })}</p>{/if}
          <div class="actions">
            <!-- Enter refuses: showing the agent what an extension reads on unshared tabs takes a real click. -->
            <button data-main onclick={deny}>{t("home-deny")}</button>
            <button class="allow" onclick={() => api.permissions.answer(request.id, "allow")}>{t("home-request-console-unlock")}</button>
          </div>
        </div>
      {:else if agentAddress}
        <div class="reading" data-testid="address-request">
          <p>{t("home-request-label-address")}</p>
          <p class="address" data-testid="address-request-url">{request.origin}</p>
          {#if addressLabels.length}<MaskReveal text={request.origin} labels={addressLabels} see="home-request-mask-see-address" hide="home-request-mask-hide-address" />{/if}
          {#if agentReason}<p class="reason">{t("home-request-address-reason", { reason: agentReason })}</p>{/if}
          {#if request.danger}<p class="reason danger" role="alert" data-testid="address-request-danger">{t("home-request-address-danger", { danger: request.danger.slice(0, UNLOCK_REASON_LENGTH) })}</p>{/if}
          <button class="why-toggle" data-testid="address-request-why" aria-expanded={why} aria-controls="address-request-why" onclick={() => (why = !why)}>{t("home-request-why")}</button>
          <div class="why" class:open={why} id="address-request-why" aria-hidden={!why}>
            <div>
              <p class="reason">{t("home-request-why-1")}</p>
              <p class="reason">{t("home-request-why-2")}</p>
            </div>
          </div>
          <div class="actions">
            <!-- Enter refuses: an address the agent made up is opened only by a real click. -->
            <button data-main onclick={deny}>{t("home-deny")}</button>
            <button class="allow" onclick={() => api.permissions.answer(request.id, "allow")}>{t("home-allow")}</button>
          </div>
        </div>
      {:else if widgetData}
        <div class="reading" data-testid="widget-data-request">
          {#if request.action !== undefined}
            <p>{t("home-request-widget-action", { title: request.title ?? request.action })}</p>
          {:else if request.site !== undefined}
            <p data-testid="site-request">{t("home-request-widget-site", { title: request.title ?? request.site })}</p>
          {:else if request.history}
            <p data-testid="history-request">{t("home-request-history")}</p>
          {:else}
            <p>{t("home-request-widget", { title: request.title ?? request.widget })}</p>
          {/if}
          <div class="actions">
            <!-- Enter refuses: showing the agent data read with the account takes a real click. -->
            <button data-main onclick={deny}>{t("home-deny")}</button>
            <button class="allow" onclick={() => api.permissions.answer(request.id, "allow")}>{t("home-request-allow-conversation")}</button>
          </div>
        </div>
      {:else}
        <div class="reading" data-testid="permission-request">
          <p>{t("home-request-tab", { title: request.title ?? site })}</p>
          <div class="actions">
            <button onclick={deny}>{t("home-deny")}</button>
            <button class="allow" data-main onclick={() => api.permissions.answer(request.id, "allow")}>{t("home-request-allow-once")}</button>
          </div>
        </div>
      {/if}
    {/key}
  </div>
</div>

<style>
  .modal { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; -webkit-app-region: no-drag; }
  /* Same delay for the pointer as for Enter: a click meant for the page, landing where the card appears, grants nothing. */
  .modal:not([data-armed]) .card :global(:is(button, input, label, a)) { pointer-events: none; }
  .card {
    position: relative;
    width: min(440px, 100%);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 18px 20px;
    /* Over the live page (no blur reaches it): dense glass, the aura's light washing its top. */
    background: radial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--a1) 20%, transparent), transparent 60%), radial-gradient(110% 80% at 100% 0%, color-mix(in oklab, var(--a2) 14%, transparent), transparent 55%), var(--glass-dense);
    backdrop-filter: blur(30px) saturate(1.8);
    color: var(--text);
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    box-shadow: var(--modal-shadow);
    font-size: 13px;
    line-height: 1.45;
    outline: none;
    opacity: 0;
    transform: translateY(-10px) scale(0.96);
    transition: opacity 200ms var(--out), transform var(--spring-d) var(--spring);
  }
  .ready .card { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    .card { transition: opacity 150ms ease-out; transform: none; }
  }
  .reading p { margin: 0 0 12px; font-size: 14px; overflow-wrap: anywhere; }
  .reading p.address { font-family: var(--font-mono); font-size: 12px; word-break: break-all; }
  .reading p.reason { font-size: 13px; color: var(--text-muted, inherit); }
  .reading p.reason.danger { color: var(--in-error); font-weight: 500; }
  button.why-toggle { display: block; margin: 0 0 12px; padding: 0; border: 0; background: none; color: var(--text-muted); font: 500 12.5px var(--font-ui); text-decoration: underline; text-underline-offset: 2px; }
  button.why-toggle:hover:not(:disabled) { background: none; color: var(--text); }
  /* Opens on the spring, closes on a fade (DESIGN.md): the row grows from 0 so the buttons below slide with it. */
  .why { display: grid; grid-template-rows: 0fr; opacity: 0; visibility: hidden; transition: grid-template-rows 150ms ease-out, opacity 150ms ease-out, visibility 0s 150ms; }
  .why.open { grid-template-rows: 1fr; opacity: 1; visibility: visible; transition: grid-template-rows var(--spring-d) var(--spring), opacity 200ms var(--out); }
  .why > div { overflow: hidden; min-height: 0; }
  @media (prefers-reduced-motion: reduce) {
    .why, .why.open { transition: opacity 150ms ease-out; }
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .allow { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
