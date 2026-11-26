<script lang="ts">
  import { fade } from "svelte/transition";
  import type { ToolKind } from "../../../shared/chat";
  import { api } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import Icon, { type IconName } from "../Icon.svelte";
  import { TRACES } from "../icons";
  import MaskBubble from "../MaskBubble.svelte";
  import { bubble } from "../terminalAgent.svelte";
  import { chat, maskedName } from "./chat.svelte";
  import ChatQuestion from "./ChatQuestion.svelte";
  import { escape, renderMarkdown, renderPlain, type Chip } from "./markdown";

  let wrap = $state<HTMLElement>() as HTMLElement;
  let scroller = $state<HTMLElement>();
  const view = $derived(chat.view);
  /** Messages already shown while streaming: their final text replaces the stream in place, without entering again. */
  const streamed = new Set<string>();
  $effect.pre(() => void (chat.view?.streaming && streamed.add(chat.view.streaming.messageId)));

  /** An inline stroke icon as markup, for the HTML the renderer builds. */
  const svg = (name: IconName, size: number) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TRACES[name].map((d) => `<path d="${d}"/>`).join("")}</svg>`;
  /** A label the agent wrote: a chip that shows its value here only (MaskBubble), never sent. */
  const chip: Chip = (label, type) => `<button type="button" class="masked" data-label="${label}" title="${escape(t("chat-reveal"))}">${svg("lock", 11)}${escape(maskedName(type))}</button>`;
  const copyButton = $derived(`<button type="button" class="copy-code" data-copy aria-label="${escape(t("chat-copy-code"))}" title="${escape(t("chat-copy-code"))}">${svg("copy", 13)}</button>`);
  const markdown = (text: string) => renderMarkdown(text, chip, copyButton);

  const READS = new Set<ToolKind>(["read", "search", "fetch"]);
  const TOOL_ICONS: Record<ToolKind, IconName> = { read: "book-open", search: "find", fetch: "globe", edit: "pencil", execute: "terminal", other: "wrench" };

  /** Each click supersedes the previous one still waiting on the host. */
  let asked = 0;
  async function reveal(label: string) {
    const n = ++asked;
    const value = await api.chat.reveal(label);
    if (n === asked) bubble.current = { kind: "reveal", host: wrap, value };
  }
  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
  /** The rendered HTML's buttons and links: chips reveal, code copies, links open in a tab (never in the panel). */
  function onclick(e: MouseEvent) {
    const target = e.target as Element;
    const masked = target.closest<HTMLElement>("button.masked[data-label]");
    if (masked) return void reveal(masked.dataset.label!);
    const code = target.closest("button[data-copy]");
    if (code) return copy(code.parentElement?.querySelector("code")?.textContent ?? "");
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link) {
      e.preventDefault();
      api.settings.openUrl(link.href);
    }
  }

  // Follows the newest line unless the user scrolled up: then a « Nouveaux messages » pill says more came.
  let stuck = true;
  let unseen = $state(false);
  const atBottom = () => !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24;
  const toBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    unseen = false;
    stuck = true;
  };
  $effect(() => {
    void view;
    if (stuck) toBottom();
    else unseen = true;
  });
  const onscroll = () => {
    stuck = atBottom();
    if (stuck) unseen = false;
  };
</script>

<div class="wrap" bind:this={wrap}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions: the clicks land on the buttons and links inside -->
  <div class="thread" data-testid="chat-thread" role="log" aria-live="polite" bind:this={scroller} {onscroll} {onclick}>
    {#each view?.items ?? [] as item (item.id)}
      {#if item.kind === "user"}
        <div class="user">
          <div class="bubble" data-testid="chat-user">{@html renderPlain(item.text, chip)}</div>
          {#if item.unsent}<span class="unsent">{t("chat-unsent")}</span>{/if}
        </div>
      {:else if item.kind === "agent"}
        <div class="agent" class:streamed={streamed.has(item.id)} data-testid="chat-agent">
          <div class="md">{@html markdown(item.text)}</div>
          <button class="copy" aria-label={t("chat-copy")} title={t("chat-copy")} onclick={(e) => (e.stopPropagation(), copy(item.text))}><Icon name="copy" size={13} /></button>
        </div>
      {:else if item.kind === "tool"}
        <div class="tool" class:read={READS.has(item.toolKind)} data-testid="chat-tool" title={item.summary}>
          <Icon name={TOOL_ICONS[item.toolKind]} size={13} />
          <span class="tool-title">{item.title}</span>
          <span class="status">
            {#if item.status === "completed"}<span class="done" role="img" aria-label={t("chat-tool-done")}><Icon name="check" size={13} /></span>
            {:else if item.status === "failed"}{t("chat-tool-failed")}
            {:else}{t("chat-tool-running")}{/if}
          </span>
        </div>
      {:else if item.kind === "question"}
        <ChatQuestion {item} />
      {:else}
        <p class="notice" data-testid="chat-notice">{item.text}</p>
      {/if}
    {/each}
    {#if view?.streaming}
      <div class="agent streaming" data-testid="chat-streaming"><div class="md">{@html markdown(view.streaming.text)}</div></div>
    {/if}
  </div>
  {#if unseen}
    <button class="pill" data-testid="chat-new-messages" out:fade={{ duration: chat.visible ? 150 : 0 }} onclick={toBottom}>{t("chat-new-messages")}</button>
  {/if}
  {#if bubble.current && bubble.current.host === wrap}
    <MaskBubble b={bubble.current} visible={chat.visible} />
  {/if}
</div>

<style>
  .wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .thread { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 16px 14px; }
  /* Each line enters on the spring (DESIGN.md). */
  .user, .agent, .tool, .notice { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .user { align-self: flex-end; max-width: 82%; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .bubble { padding: 10px 12px; border-radius: 16px 16px 4px 16px; background: var(--glass-hi); white-space: pre-wrap; overflow-wrap: anywhere; }
  .unsent { color: var(--text-muted); font-size: 11.5px; }
  .agent { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; max-width: 92%; line-height: 1.5; overflow-wrap: anywhere; }
  .agent.streamed { animation: none; }
  .md { align-self: stretch; min-width: 0; }
  .md :global(p) { margin: 0 0 8px; }
  .md :global(:is(p, ul, ol, pre):last-child) { margin-bottom: 0; }
  .md :global(ul), .md :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .md :global(code) { font: 12px/1.45 var(--font-mono); padding: 1px 4px; border-radius: 5px; background: var(--bg-hover); }
  .md :global(pre) { position: relative; margin: 0 0 8px; padding: 10px 12px; border-radius: 10px; background: var(--sheet); box-shadow: inset 0 0 0 1px var(--border); overflow-x: auto; }
  .md :global(pre code) { padding: 0; background: none; white-space: pre; }
  .md :global(a) { color: var(--accent); }
  .md :global(a:hover) { text-decoration: underline; }
  .md :global(.copy-code) { position: absolute; top: 6px; right: 6px; }
  .copy, .md :global(.copy-code) { width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border-radius: 8px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; opacity: 0; transition: opacity var(--tap), background var(--tap); }
  .agent:hover .copy, .copy:focus-visible, .md :global(pre:hover .copy-code), .md :global(.copy-code:focus-visible) { opacity: 1; }
  .copy:hover, .md :global(.copy-code:hover) { background: var(--bg-hover); color: var(--text); }
  /* A masked value: a lock and its kind, tinted by the space's accent; a click shows it here only. */
  .thread :global(.masked) { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; border: 0; background: var(--notice-bg); color: var(--accent); font: 12px/1.4 var(--font-ui); vertical-align: baseline; cursor: pointer; }
  .thread :global(.masked:hover) { text-decoration: underline; }
  .thread :global(button:focus-visible), .pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tool { max-width: 92%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; background: var(--access-act-bg); color: var(--access-act); font-size: 12px; }
  .tool.read { background: var(--access-read-bg); color: var(--access-read); }
  .tool-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { margin-left: auto; flex: none; color: var(--text-muted); }
  .done { display: block; }
  .notice { align-self: center; margin: 0; max-width: 90%; color: var(--text-muted); font-size: 12px; text-align: center; }
  .pill { position: absolute; left: 0; right: 0; bottom: 10px; width: fit-content; margin: 0 auto; padding: 5px 12px; border-radius: 999px; border: 0; background: var(--accent); color: var(--accent-ink); font: 600 12px var(--font-ui); box-shadow: var(--float); cursor: pointer; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
