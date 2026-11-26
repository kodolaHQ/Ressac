<script lang="ts">
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { api } from "../../state.svelte";
  import { t } from "../../i18n.svelte";
  import { MONO_FALLBACK, palette } from "../terminalAgent.svelte";

  /**
   * The engine reports signed out: its CLI's own sign-in (`claude auth login`, `codex login --device-auth`) runs in a
   * small terminal here, over the agent's data channel; Ressac never sees the password. On success the host retries the
   * discussion and this card goes.
   */
  let { engine, openSettings }: { engine: "claude" | "codex"; openSettings: () => void } = $props();
  const name = $derived(engine === "codex" ? "ChatGPT" : "Claude");
  const cli = $derived(engine === "codex" ? "Codex" : "Claude Code");
  let host = $state<HTMLDivElement>();
  let started = $state(false);

  function start() {
    if (!host || started) return;
    started = true;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: `"Geist Mono", ${MONO_FALLBACK}`,
      cursorBlink: true,
      minimumContrastRatio: 4.5,
      theme: palette(),
      // The sign-in address opens in a tab (xterm's default confirm() goes nowhere in the chrome).
      linkHandler: { activate: (_e, uri) => api.settings.openUrl(uri) },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // Keys go out only once the host's login runs: it then routes agent.write to the login (logins.write), never to an
    // agent session or the outflow. Before that, the same call would take the agent terminal's path.
    let running = false;
    term.onData((d) => running && api.agent.write(d));
    const offData = api.agent.onData((d) => term.write(d));
    const resize = () => {
      fit.fit();
      api.agent.resize({ cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) });
    };
    const obs = new ResizeObserver(resize);
    obs.observe(host);
    void api.chat.login().then(() => {
      running = true;
      resize();
    });
    term.focus();
    cleanup = () => {
      obs.disconnect();
      offData();
      term.dispose();
    };
  }
  let cleanup: (() => void) | undefined;
  $effect(() => () => cleanup?.());
</script>

<div class="login" data-testid="chat-login">
  <h2>{t("chat-login-title", { name })}</h2>
  <p class="muted">{t("chat-login-intro", { cli })}</p>
  <ol>
    <li>{t("chat-login-step-1")}</li>
    <li>{t("chat-login-step-2", { name })}</li>
    <li>{t("chat-login-step-3")}</li>
  </ol>
  {#if !started}<button class="primary" data-testid="chat-login-start" onclick={start}>{t("chat-login-button")}</button>{/if}
  <div class="term-block" class:shown={started}>
    {#if started}<span class="small">{t("chat-login-running", { cli })}</span>{/if}
    <div class="term" role="group" aria-label={t("chat-login-terminal")} bind:this={host}></div>
  </div>
  <p class="small">
    {t("chat-login-alt")}
    <button class="link" data-testid="chat-login-api-key" onclick={openSettings}>{t("chat-login-api-key")}</button>
    {t("chat-login-or")}
    <button class="link" data-testid="chat-login-local" onclick={openSettings}>{t("chat-login-local")}</button>.
  </p>
</div>

<style>
  .login { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding: 28px 20px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  h2 { margin: 0; font: 600 18px/1.3 var(--font-display); }
  .muted { margin: 0; color: var(--text-muted); line-height: 1.5; }
  ol { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
  .primary { align-self: flex-start; padding: 8px 16px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink); font: 600 13px var(--font-ui); cursor: pointer; transition: transform var(--tap); }
  .primary:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* The terminal needs a size before it opens: its block is laid out but hidden until « Se connecter ». */
  .term-block { display: flex; flex-direction: column; gap: 6px; visibility: hidden; height: 0; overflow: hidden; }
  .term-block.shown { visibility: visible; height: auto; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .term { height: 170px; padding: 8px 10px; border-radius: 10px; background: var(--sheet); box-shadow: inset 0 0 0 1px var(--border); overflow: hidden; }
  .small { margin: 0; color: var(--text-muted); font-size: 12px; }
  .link { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; }
  .link:hover { text-decoration: underline; }
</style>
