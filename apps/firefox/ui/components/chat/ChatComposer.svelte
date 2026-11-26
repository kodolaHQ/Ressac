<script lang="ts">
  import { tick, untrack } from "svelte";
  import { fade } from "svelte/transition";
  import { LABELS } from "../../../../../packages/kernel/src/mask/table";
  import { CHAT_COMMANDS, COMMAND_WITH_TEXT, type ChatCommand, type ChatRef } from "../../../shared/chat";
  import { privateTab } from "../../../shared/model";
  import { api, appState, currentWindow, labOn } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import Icon, { type IconName } from "../Icon.svelte";
  import { chat, maskedName, newChat, switchChat } from "./chat.svelte";
  import ChatModelPicker from "./ChatModelPicker.svelte";
  import { COMMANDS, REFS, matching, menuAt, nextIndex, parseCommand, withoutToken, type CommandId, type MenuState, type RefId } from "./commands";
  import { shiftRanges } from "./draft";

  /**
   * The message box: Entrée sends, ⇧Entrée goes to the line, a composition (IME) never sends. Pasted text is kept as
   * pasted ranges (masked on send, never counted as typed); the chips show what the send will mask, each can go « en clair ».
   * « / » at the start opens the commands, « @ » at a word's start the references (a tab, the shown page, a history or
   * bookmark page, kept as chips): the textarea keeps focus, ↑ ↓ move, Entrée or Tab picks, Échap closes.
   * `profiles`: the agents a discussion can run; `onAdvanced`: « Mode avancé » (/terminal).
   */
  let { profiles = [], onAdvanced }: { profiles?: { id: string; name: string }[]; onAdvanced?: () => void } = $props();
  let picker = $state<ReturnType<typeof ChatModelPicker>>();
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
    look();
  }
  /** The text set by Ressac (a pick): the pasted ranges follow, the caret goes to `caret`. */
  async function setText(next: string, caret = next.length) {
    pasted = shiftRanges(pasted, known, next);
    known = text = next;
    await tick();
    box?.setSelectionRange(caret, caret);
    box?.focus();
    fit();
    look();
  }

  // The « / » and « @ » menu, read from the text before the caret. `dismissed`: the token Échap closed, until it changes.
  let menu = $state<MenuState | null>(null);
  let active = $state(0);
  let dismissed: string | null = null;
  const menuKey = (m: MenuState) => `${m.kind}:${m.start}`;
  function look() {
    const m = box ? menuAt(text.slice(0, box.selectionStart)) : null;
    if (!m) dismissed = null;
    const next = m && menuKey(m) !== dismissed ? m : null;
    if (JSON.stringify(next) !== JSON.stringify(menu)) active = 0;
    menu = next;
  }
  const REF_ICONS: Record<RefId, IconName> = { tab: "tab", page: "globe", history: "clock", bookmark: "bookmark" };
  type Item = { key: string; label: string; hint?: string; icon?: IconName; disabled?: boolean; run: () => void };
  const own = $derived(chat.view?.summary.engine === "own");
  /** A tab matches anywhere in its title or address; a mode or an agent by the start of its name. */
  const has = (q: string, ...s: string[]) => s.some((x) => x.toLowerCase().includes(q.toLowerCase().trim()));
  const starts = (q: string, ...names: string[]) => matching([{ aliases: names }], q.trim()).length > 0;
  /** The tabs the agent can see (the host checks again at send): no private space's, no Ressac page. */
  const openTabs = $derived.by(() => {
    const st = appState.value;
    return st ? Object.values(st.tabs).filter((o) => !o.url.startsWith("ressac:") && !privateTab(st, o)) : [];
  });
  const shown = $derived.by(() => {
    const f = currentWindow();
    const id = f?.active[f.activeSpace];
    return openTabs.find((o) => o.id === id);
  });
  /** History and bookmark pages for the « @historique » / « @favori » pick (only the latest search applies). */
  let found = $state<{ title: string; url: string }[]>([]);
  let finds = 0;
  $effect(() => {
    const m = menu;
    const n = ++finds;
    if (m?.kind !== "pick" || m.ref === "tab") return void (found = []);
    const timer = setTimeout(async () => {
      const q = m.query.trim();
      const pages = m.ref === "history" ? (q ? await api.history.search(q, 8, true) : (await api.history.recent()).slice(0, 8)).filter((v) => !v.private) : await api.bookmarks.search(q, 8);
      if (n === finds) found = pages.map((p) => ({ title: p.title, url: p.url }));
    }, 120);
    return () => clearTimeout(timer);
  });
  const items = $derived.by((): Item[] => {
    const m = menu;
    if (!m) return [];
    if (m.kind === "command")
      return matching(COMMANDS, m.query).map((c) => ({ key: c.id, label: `/${t(`chat-command-${c.id}`)}`, hint: t(`chat-command-${c.id}-hint`), disabled: commandOff(c.id), run: () => void runCommand(c.id) }));
    if (m.kind === "option" && m.command === "mode")
      return (["browser", "workshop"] as const)
        .map((mode) => ({ key: mode, label: t(mode === "workshop" && !labOn() ? "agent-panel-mode-workshop-lab" : `agent-panel-mode-${mode}`), disabled: mode === "workshop" && (!labOn() || own), run: () => void pickOption({ mode }) }))
        .filter((i) => starts(m.query, i.label, i.key));
    if (m.kind === "option") return profiles.filter((p) => starts(m.query, p.name, p.id)).map((p) => ({ key: p.id, label: p.name, run: () => void pickOption({ profile: p.id }) }));
    if (m.kind === "ref")
      return matching(REFS, m.query).map((r) => ({ key: r.id, label: `@${t(`chat-ref-${r.id}`)}`, hint: t(`chat-ref-${r.id}-hint`), icon: REF_ICONS[r.id], disabled: r.id === "page" && !shown, run: () => void pickRef(r.id) }));
    if (m.ref === "tab")
      return openTabs
        .filter((o) => has(m.query, o.title, o.url))
        .slice(0, 8)
        .map((o) => ({ key: o.id, label: o.title || o.url, hint: o.url, icon: "tab" as const, run: () => void addRef({ tab: o.id }, o.title || o.url, "tab") }));
    return found.map((p) => ({ key: p.url, label: p.title || p.url, hint: p.url, icon: REF_ICONS[m.ref], run: () => void addRef(p, p.title || p.url, m.ref) }));
  });
  function commandOff(id: CommandId): boolean {
    if (id === "model") return !chat.view?.model;
    if (id === "terminal") return own || !onAdvanced;
    if (id === "agent") return profiles.length < 2;
    return false;
  }
  /** The typed token up to the caret goes. */
  const dropToken = () => withoutToken(text, menu?.start ?? 0, box?.selectionStart ?? text.length);
  async function runCommand(id: CommandId) {
    const name = `/${t(`chat-command-${id}`)} `;
    const rest = dropToken();
    if (id === "mode" || id === "agent" || COMMAND_WITH_TEXT.has(id as ChatCommand)) return setText(name + rest.text, name.length);
    await setText(rest.text, 0);
    if (id === "model") picker?.show(box);
    else if (id === "new") void newChat();
    else if (id === "terminal") onAdvanced?.();
    else void submit(id as ChatCommand);
  }
  async function pickOption(o: { profile?: string; mode?: "browser" | "workshop" }) {
    await setText("");
    void switchChat(o);
  }
  async function pickRef(id: RefId) {
    if (id !== "page") {
      const name = `@${t(`chat-ref-${id}`)} `;
      const r = dropToken();
      return setText(r.text.slice(0, r.caret) + name + r.text.slice(r.caret), r.caret + name.length);
    }
    if (shown) await addRef({ tab: shown.id }, shown.title || shown.url, "page");
  }

  /** The references the message points to: a tab by id, or a history or bookmark page. */
  let refs = $state<{ key: string; ref: ChatRef; label: string; icon: IconName; tab: boolean }[]>([]);
  async function addRef(ref: ChatRef, label: string, kind: RefId) {
    const key = "tab" in ref ? `tab:${ref.tab}` : `page:${ref.url}`;
    if (!refs.some((r) => r.key === key)) refs = [...refs, { key, ref, label, icon: REF_ICONS[kind], tab: "tab" in ref }];
    const r = dropToken();
    await setText(r.text, r.caret);
  }
  const removeRef = (key: string) => {
    refs = refs.filter((r) => r.key !== key);
    box?.focus();
  };
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
  // The references belong to the discussion they were picked in; the first view of the panel (none before it) keeps them.
  let shownId: string | undefined;
  $effect(() => {
    const id = chat.view?.summary.id;
    untrack(() => {
      chips = [];
      clear = [];
      menuFor = null;
      menu = null;
      if (shownId !== undefined && id !== shownId) refs = [];
      if (id !== undefined) shownId = id;
    });
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

  /**
   * Sends the message. A text starting with a known command runs it: a chat command (/nouvelle…) here, a tool command
   * (/cherche…) goes with its id and only the text after it (the host puts the command's words before). `command`: a tool
   * command picked from the menu that takes no text (/lis, /onglets).
   */
  async function submit(command?: ChatCommand) {
    const parsed = command ? null : parseCommand(text);
    if (parsed && !(CHAT_COMMANDS as readonly string[]).includes(parsed.id)) return void runCommand(parsed.id);
    const cmd = command ?? (parsed?.id as ChatCommand | undefined);
    // A command that needs its text waits for it.
    if (cmd && COMMAND_WITH_TEXT.has(cmd) && !parsed?.rest.trim()) return;
    if ((!text.trim() && !refs.length && !command) || sending) return;
    sending = true;
    const sent = text;
    const cut = parsed?.restStart ?? 0;
    const body = text.slice(cut);
    const sentRefs = refs;
    const r = await api.chat.send({
      text: body,
      pasted: pasted.map(([a, b]): [number, number] => [Math.max(a - cut, 0), b - cut]).filter(([a, b]) => a < b),
      clear: [...clear],
      ...(cmd ? { command: cmd } : {}),
      ...(sentRefs.length ? { refs: sentRefs.map((x) => $state.snapshot(x.ref)) } : {}),
    });
    sending = false;
    if (!r.ok) return void (error = r.error);
    refs = refs.filter((x) => !sentRefs.includes(x));
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
    look();
  }
  function onkeydown(e: KeyboardEvent) {
    // keyCode 229: a key the IME still holds (Safari-style composition end).
    if (e.isComposing || e.keyCode === 229) return;
    if (menu && items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = nextIndex(active, items.length, e.key);
        // The focus stays in the text (aria-activedescendant): the list scrolls to the chosen row itself.
        void tick().then(() => box?.ownerDocument.getElementById(`chat-composer-menu-${active}`)?.scrollIntoView({ block: "nearest" }));
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const it = items[Math.min(active, items.length - 1)];
        if (it && !it.disabled) it.run();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissed = menuKey(menu);
        menu = null;
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
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
  {#if menu && items.length}
    <div class="menu" id="chat-composer-menu" role="listbox" data-testid="chat-command-menu" aria-label={t(menu.kind === "command" || menu.kind === "option" ? "chat-commands" : "chat-refs")} out:fade={{ duration: chat.visible ? 150 : 0 }}>
      {#each items as it, i (it.key)}
        <!-- The textarea keeps focus (aria-activedescendant): a press here must not take it. -->
        <button type="button" role="option" id="chat-composer-menu-{i}" tabindex="-1" class:active={i === active} aria-selected={i === active} aria-disabled={it.disabled ? "true" : undefined} data-testid="chat-menu-item" data-key={it.key} onmousedown={(e) => e.preventDefault()} onclick={() => !it.disabled && it.run()}>
          {#if it.icon}<Icon name={it.icon} size={13} />{/if}
          <span class="label">{it.label}</span>
          {#if it.hint}<small>{it.hint}</small>{/if}
        </button>
      {/each}
    </div>
  {/if}
  <div class="box">
    {#if chips.length || refs.length}
      <div class="chips">
        {#each refs as r (r.key)}
          <button type="button" class="chip ref" data-testid="chat-ref" title={t(r.tab ? "chat-ref-tab-title" : "chat-ref-page-title")} out:fade={{ duration: chat.visible ? 150 : 0 }} onclick={() => removeRef(r.key)}>
            <Icon name={r.icon} size={11} /><span class="ref-name">{r.label}</span><Icon name="close" size={10} />
          </button>
        {/each}
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
      aria-autocomplete="list"
      aria-controls={menu && items.length ? "chat-composer-menu" : undefined}
      aria-activedescendant={menu && items.length ? `chat-composer-menu-${active}` : undefined}
      oninput={(e) => ((text = e.currentTarget.value), changed())}
      onclick={look}
      onkeyup={(e) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && look()}
      onfocus={look}
      onblur={() => (menu = null)}
      {onkeydown}
      onpaste={(e) => insertPasted(e, e.clipboardData)}
      ondrop={(e) => insertPasted(e, e.dataTransfer)}
    ></textarea>
  </div>
  {#if error}<p class="error" role="alert" out:fade={{ duration: chat.visible ? 150 : 0 }}>{error}</p>{/if}
  <div class="foot">
    <ChatModelPicker bind:this={picker} />
    <div class="actions">
      {#if running}
        <button type="button" class="secondary" data-testid="chat-stop" out:fade={{ duration: chat.visible ? 150 : 0 }} onclick={() => api.chat.cancel()}>{t("chat-stop")}</button>
      {/if}
      <button type="submit" class="primary" data-testid="chat-send" disabled={(!text.trim() && !refs.length) || sending}>{t("chat-send")}</button>
    </div>
  </div>
  <!-- One small line for the notes: what is masked, what the own model may get wrong, where the text goes. -->
  <p class="note notes">
    <span>{t("chat-composer-footer")}</span>
    {#if chat.view?.summary.engine === "own"}<span data-testid="chat-own-warning">{t("chat-composer-own-warning")}</span>{/if}
    {#if chat.view?.remote}<span class="sent-to" data-testid="chat-sent-to" out:fade={{ duration: chat.visible ? 150 : 0 }}>{t("chat-composer-sent-to", { host: chat.view.remote })}</span>{/if}
  </p>
</form>

<style>
  .composer { position: relative; flex: none; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 10px 12px 12px; border-top: 1px solid var(--border); }
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
  .chip.ref { max-width: 100%; background: var(--bg-active); color: var(--text); }
  .ref-name { min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Opens upward over the thread, as wide as the composer. */
  .menu { position: absolute; z-index: 6; left: 12px; right: 12px; bottom: calc(100% - 4px); max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 12px; background: var(--glass-dense); box-shadow: var(--float), inset 0 0 0 1px var(--glass-edge); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .menu button { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; align-items: center; padding: 6px 10px; border-radius: 8px; border: 0; background: transparent; color: var(--text); font: 13px/1.3 var(--font-ui); text-align: left; cursor: pointer; transition: background var(--tap); }
  .menu button > :global(svg) { color: var(--text-muted); }
  .menu .label { grid-column: -2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu small { grid-column: -2; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 11.5px; }
  .menu button:hover:not([aria-disabled]), .menu button.active { background: var(--bg-hover); }
  .menu button.active { box-shadow: inset 0 0 0 1px var(--glass-edge); }
  .menu button[aria-disabled] { opacity: 0.5; cursor: default; }
  .prefix { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px 6px 10px; border-radius: 10px; background: var(--bg-hover); color: var(--text-muted); font-size: 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .prefix-text { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .prefix strong { color: var(--text); font-weight: 600; }
  .icon { flex: none; width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border-radius: 6px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
  .icon:hover { background: var(--bg-active); color: var(--text); }
  .error { margin: 0; color: var(--in-error); font-size: 12px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  /* The model chip on the left shrinks first; Stop and Send keep their size on the right. */
  .foot { position: relative; display: flex; align-items: center; gap: 8px; }
  .note { margin: 0; color: var(--text-muted); font-size: 11.5px; }
  .sent-to { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .notes { display: flex; flex-wrap: wrap; column-gap: 6px; }
  .notes span + span::before { content: "·"; margin-right: 6px; }
  .actions { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; }
  .foot button { flex: none; padding: 6px 12px; border-radius: 10px; font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), opacity var(--tap); }
  .primary { padding: 6px 14px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); }
  .primary:disabled { opacity: 0.5; cursor: default; }
  .secondary { border: 1px solid var(--border); background: transparent; color: var(--text); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
