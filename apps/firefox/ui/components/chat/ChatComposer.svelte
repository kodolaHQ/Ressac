<script lang="ts">
  import { tick, untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { LABELS } from "../../../../../packages/kernel/src/mask/table";
  import { api } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import Icon from "../Icon.svelte";
  import { chat, maskedName } from "./chat.svelte";
  import { shiftRanges } from "./draft";

  /**
   * The message box: Entrée sends, ⇧Entrée goes to the line, a composition (IME) never sends. Pasted text is kept as
   * pasted ranges (masked on send, never counted as typed); the chips show what the send will mask, each can go « en clair ».
   */
  let box = $state<HTMLTextAreaElement>();
  let text = $state("");
  let pasted: [number, number][] = [];
  /** The text as the ranges last knew it: an edit is found against it. */
  let known = "";
  let clear = $state<string[]>([]);
  let chips = $state<{ label: string; type: string }[]>([]);
  let menuFor = $state<string | null>(null);
  let sending = $state(false);
  let error = $state<string | null>(null);
  const running = $derived(chat.view?.summary.state === "running" || chat.view?.summary.state === "waiting");

  /** Grows with its text, eight lines at most, then scrolls. */
  function fit() {
    if (!box) return;
    const line = parseFloat(getComputedStyle(box).lineHeight) || 18;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, line * 8 + 2)}px`;
  }
  function changed() {
    pasted = shiftRanges(pasted, known, text);
    known = text;
    error = null;
    fit();
  }
  /** A paste or a drop goes in at the caret as a pasted range. */
  function insertPasted(e: Event, data: DataTransfer | null) {
    const s = data?.getData("text/plain");
    if (!box || !s) return;
    e.preventDefault();
    const [start, end] = [box.selectionStart, box.selectionEnd];
    box.setRangeText(s, start, end, "end");
    text = box.value;
    pasted = [...shiftRanges(pasted, known, text), [start, start + s.length]];
    known = text;
    fit();
  }

  // The chips: the draft masked as it would be sent (never sent nor counted as typed), a moment after typing stops.
  let previews = 0;
  $effect(() => {
    const draft = text;
    void chat.view?.summary.id;
    const n = ++previews;
    if (!draft.trim()) return void ((chips = []), (clear = []));
    const timer = setTimeout(async () => {
      const r = await api.chat.preview(draft);
      if (n !== previews) return;
      const found = new Map([...(r?.text ?? "").matchAll(LABELS)].map((m) => [m[0], m[1]!]));
      chips = [...found].map(([label, type]) => ({ label, type }));
      clear = clear.filter((l) => found.has(l));
    }, 250);
    return () => clearTimeout(timer);
  });
  // Another discussion: its table gives other labels, so the chips and « en clair » choices start again (the preview reruns).
  $effect(() => {
    void chat.view?.summary.id;
    untrack(() => ((chips = []), (clear = []), (menuFor = null)));
  });
  // A press outside the chip's menu or Échap closes it.
  $effect(() => {
    if (menuFor === null) return;
    const away = (e: PointerEvent) => !(e.target as Element).closest?.(".chip-wrap") && (menuFor = null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (menuFor = null);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  });
  const toggleClear = (label: string) => {
    clear = clear.includes(label) ? clear.filter((l) => l !== label) : [...clear, label];
    menuFor = null;
  };

  async function submit() {
    if (!text.trim() || sending) return;
    sending = true;
    const sent = text;
    const r = await api.chat.send({ text, pasted, clear: [...clear] });
    sending = false;
    if (!r.ok) return void (error = r.error);
    // Only what went: text typed while the send was on its way stays, with its pasted ranges.
    text = text.startsWith(sent) ? text.slice(sent.length) : text;
    pasted = shiftRanges(pasted, known, text);
    known = text;
    if (!text) {
      clear = [];
      chips = [];
    }
    await tick();
    fit();
  }
  function onkeydown(e: KeyboardEvent) {
    // keyCode 229: a key the IME still holds (Safari-style composition end).
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  }

  /** ⌘J: the frame must be the window's focused element too. */
  export function focus(): void {
    (window.frameElement as HTMLElement | null)?.focus();
    box?.focus();
  }
  export function hasFocus(): boolean {
    return !!box && box === document.activeElement && window.parent.document.activeElement === window.frameElement;
  }
</script>

<form class="composer" data-testid="chat-composer" onsubmit={(e) => (e.preventDefault(), void submit())}>
  {#if chat.view?.prefix}
    <div class="prefix" data-testid="chat-prefix" out:fade={{ duration: chat.visible ? 150 : 0 }}>
      <span class="prefix-text"><strong>{t("chat-prefix")}</strong> {chat.view.prefix.slice(0, 300)}</span>
      <button type="button" class="icon" aria-label={t("chat-prefix-drop")} title={t("chat-prefix-drop")} data-testid="chat-prefix-drop" onclick={() => api.chat.dropPrefix()}><Icon name="close" size={13} /></button>
    </div>
  {/if}
  <div class="box">
    {#if chips.length}
      <div class="chips">
        {#each chips as c (c.label)}
          {@const isClear = clear.includes(c.label)}
          <span class="chip-wrap">
            <button type="button" class="chip" class:clear={isClear} data-testid="chat-chip" aria-haspopup="menu" aria-expanded={menuFor === c.label} onclick={() => (menuFor = menuFor === c.label ? null : c.label)}>
              <Icon name={isClear ? "lock-open" : "lock"} size={11} />{maskedName(c.type)}{#if isClear}&nbsp;· {t("chat-chip-in-clear")}{/if}
            </button>
            {#if menuFor === c.label}
              <span class="chip-menu" role="menu" out:fade={{ duration: chat.visible ? 150 : 0 }}>
                <button type="button" role="menuitem" data-testid="chat-chip-clear" onclick={() => toggleClear(c.label)}>{t(isClear ? "chat-chip-mask" : "chat-chip-clear")}</button>
              </span>
            {/if}
          </span>
        {/each}
      </div>
    {/if}
    <label for="chat-composer-text" class="sr">{t("chat-composer-label")}</label>
    <textarea
      id="chat-composer-text"
      data-testid="chat-input"
      rows="1"
      placeholder={t("chat-composer-placeholder")}
      bind:this={box}
      value={text}
      oninput={(e) => ((text = e.currentTarget.value), changed())}
      {onkeydown}
      onpaste={(e) => insertPasted(e, e.clipboardData)}
      ondrop={(e) => insertPasted(e, e.dataTransfer)}
    ></textarea>
  </div>
  {#if error}<p class="error" role="alert" out:fade={{ duration: chat.visible ? 150 : 0 }}>{error}</p>{/if}
  <div class="foot">
    <span class="note">{t("chat-composer-footer")}</span>
    <span class="spacer"></span>
    {#if running}
      <button type="button" class="secondary" data-testid="chat-stop" out:fade={{ duration: chat.visible ? 150 : 0 }} onclick={() => api.chat.cancel()}>{t("chat-stop")}</button>
    {/if}
    <button type="submit" class="primary" data-testid="chat-send" disabled={!text.trim() || sending}>{t("chat-send")}</button>
  </div>
  {#if chat.view?.summary.engine === "own"}<p class="note" data-testid="chat-own-warning">{t("chat-composer-own-warning")}</p>{/if}
  {#if chat.view?.remote}<p class="note sent-to" data-testid="chat-sent-to" out:fade={{ duration: chat.visible ? 150 : 0 }}>{t("chat-composer-sent-to", { host: chat.view.remote })}</p>{/if}
</form>

<style>
  .composer { flex: none; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 10px 12px 12px; border-top: 1px solid var(--border); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .box { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--bg-hover); transition: border-color var(--tap); }
  .box:focus-within { border-color: var(--accent); }
  textarea { width: 100%; box-sizing: border-box; resize: none; margin: 0; padding: 0; border: 0; background: transparent; color: var(--text); font: 13px/1.4 var(--font-ui); outline: none; overflow-y: auto; }
  textarea::placeholder { color: var(--text-muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip-wrap { position: relative; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; border: 0; background: var(--notice-bg); color: var(--accent); font: 12px/1.4 var(--font-ui); cursor: pointer; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .chip.clear { background: var(--bg-active); color: var(--text-muted); }
  .chip-menu { position: absolute; z-index: 3; left: 0; bottom: calc(100% + 4px); display: flex; padding: 4px; border-radius: 10px; background: var(--glass-dense); box-shadow: var(--float), inset 0 0 0 1px var(--glass-edge); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .chip-menu button { padding: 5px 10px; border-radius: 8px; border: 0; background: transparent; color: var(--text); font: 12.5px var(--font-ui); white-space: nowrap; cursor: pointer; }
  .chip-menu button:hover { background: var(--bg-hover); }
  .prefix { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px 6px 10px; border-radius: 10px; background: var(--bg-hover); color: var(--text-muted); font-size: 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .prefix-text { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .prefix strong { color: var(--text); font-weight: 600; }
  .icon { flex: none; width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border-radius: 6px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
  .icon:hover { background: var(--bg-active); color: var(--text); }
  .error { margin: 0; color: var(--in-error); font-size: 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .foot { display: flex; align-items: center; gap: 8px; }
  .note { margin: 0; color: var(--text-muted); font-size: 11.5px; }
  .sent-to { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .spacer { flex: 1; }
  .foot button { flex: none; padding: 6px 12px; border-radius: 10px; font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), opacity var(--tap); }
  .primary { padding: 6px 14px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); }
  .primary:disabled { opacity: 0.5; cursor: default; }
  .secondary { border: 1px solid var(--border); background: transparent; color: var(--text); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
