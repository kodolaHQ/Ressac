# Ressac on Firefox

Ressac rebuilt on stable Firefox. Built with [surfer](https://github.com/zen-browser/surfer), which downloads Firefox into `engine/`, symlinks our `src/` files into it (same relative path), applies our `*.patch` files (`git apply`) and runs `mach`.

## Requirements (macOS arm64)

- `brew install gnu-tar python@3.12`; Rust in `~/.cargo/bin`; Mozilla toolchains in `~/.mozbuild` (installed by `engine:bootstrap` if needed).
- About 25 GB free: the Firefox sources live in `~/Ressac-firefox/engine`, and `engine/` is a symlink to them.
- Every command goes through `scripts/env.sh` (PATH, SDK): use the pnpm scripts.

## First install

```sh
pnpm --filter firefox-ressac engine:install   # downloads Firefox 159.0.1, moves it out of the repo, links it
pnpm --filter firefox-ressac engine:import    # links src/ and applies the patches
pnpm --filter firefox-ressac build            # full build (~20 min)
```

In a new checkout or worktree: `pnpm engine:link` then `pnpm engine:import`. The `engine` tree is shared between checkouts: run `engine:import` in the checkout you work in before building.

## The bundles

`scripts/ui.sh` builds five bundles with Vite from `ui/` and `chrome/`, into `src/browser/base/content/ressac/` (generated, git-ignored):

- `sidebar`: the Svelte UI, loaded in an iframe of the browser window;
- `window`: the window controller (syncs Ressac tabs and spaces with Firefox tabs and containers, shortcuts);
- `store`: the shared state module (`store.sys.mjs`: session file, containers, shutdown save, the agent host), imported by the window at runtime;
- `agent`: the agent panel (terminal), a second iframe on the right of the window;
- `actor`: the page and extension JSWindowActors (`page-actor.sys.mjs`, `extension-actor.sys.mjs`). These are **copied** into the build, not linked (the macOS content sandbox cannot read a file outside the source and object trees): after changing `chrome/agent/page-actor.ts` or `extension-actor.ts`, run `pnpm build:ui`. The e2e load the extension actor as `pnpm ui` built it, through a `resource://` substitution (`RESSAC_TEST_EXTENSION_ACTOR` plus the `security.sandbox.content.mac.testing_read_path1` pref), so they need no rebuild. After each `build:ui`, run them once against the packaged actor with `RESSAC_E2E_PACKAGED_ACTOR=1`.

## The agent

The kernel (`@ressac/kernel`) runs in a separate Node process, `host/host.ts`, started by Firefox and spoken to in JSON-RPC over stdio (one message per line). Its console output goes to Firefox's console prefixed `[kernel]`; stdout carries only the protocol. The Node and tsx paths are frozen at build time (`scripts/paths.ts`): a dev build only runs on the machine that built it.

The agent's workshop container is `ressac-workshop-firefox` (`RESSAC_CONTAINER`), from the image `ressac-workshop:1`. It publishes ports 5300-5319 (`RESSAC_CONTAINER_PORTS`) and mounts the `webaios-home` volume (kept: it holds the agent's login).

First build: the kernel runs `docker build --progress=plain` and streams its stderr; `parseBuildStep` (`packages/kernel/src/container/workshop.ts`) turns the BuildKit lines `#N [k/n] FROM|RUN …` into a step and a label in the shown language (`parseBuildStep(line, locale)`), sent to every window waiting on that start (`Workshop.onBuildProgress`, replayed to late joiners) and shown in the agent panel (« Préparation de l'agent, étape k/n : … (m min) »). Without step lines (classic builder) the panel keeps its plain text. The 20 min cap and the error tail are unchanged. `FAKE_DOCKER_BUILD_STEP_MS` paces the fake docker's build lines in the e2e.

Web search goes through the browser: the agent searches in its own visible tab (`search_web`, `read_pages`, `hand_over`; see « Chercher et lire le web » in `packages/kernel/templates/fr/AGENTS.md`, « Searching and reading the web » in `templates/en/AGENTS.md`), and the Claude profile passes `--disallowedTools WebSearch,WebFetch`, so Claude's own web tools are off. `/workspace/browsing-notes.md` holds the agent's general lessons from hand-overs; it is created once and never refreshed, except to follow a language change while still untouched (Settings › Données › « Carnet de recherche » › « Afficher dans le Finder »).

Invisible reads run in a windowless browser, in a private container cleared before and after each read. Every request from a reading container is checked: an address that is local, or a name that resolves to one (or fails to resolve), is refused. Known limits, marked `shortcut:` in `chrome/agent/local-guard.ts` and `invisible.ts`: custom-scheme navigations, preconnects, Alt-Svc, WebRTC, and service workers in a login profile's container. Paced reads (the workflows' `web` widgets) wait for another site's turn before following a navigation to it: the read stops at that site's document, gives its place back, waits, then resumes (`chrome/agent/invisible.ts`, `host/remote-bridge.ts`).

### Agent engines

Settings › Agents lets each agent pick its engine. Codex: the ChatGPT subscription, Ollama, or an OpenAI-compatible API. Claude: the subscription, Ollama, or an Anthropic-compatible API (`claudeEngine` in the settings; the host passes `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, the per-tier `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` to the session). An API key stays in the keychain: the session only gets a relay session token. For Ollama the model is picked from the installed ones (the host reads `/api/tags` at the chosen address; « Actualiser » reads again; a saved model that is gone is marked « (non installé) »). Claude Code sends very long prompts: use a large model with a large context window (the card says so); Ollama's default context is short, so set `OLLAMA_CONTEXT_LENGTH` (e.g. 65536) for Claude Code. On Ollama or an API the sign-in button is quiet and the sign-in hint is hidden. `test/tools/fake-docker.cjs` records the `RESSAC_*`, `ANTHROPIC_*` and `CLAUDE_CODE_*` variables of the session in `fake-agent-env.json`.

### Ollama

The local AI needs an Ollama that answers on `127.0.0.1:11434` (`host/ollama-runtime.ts`). The running one is used; an installed one that is stopped is started with Ressac (the app through `open -ga`, a command-line install through `ollama serve`, stopped again at quit); a version below `OLLAMA_MIN` is reported with a link to update it, never replaced. With none on the machine, the welcome and Settings › IA locale offer to download the official archive (`OLLAMA_VERSION`, checked against `OLLAMA_SHA256`) into `<dataDir>/ollama/<version>`, about 190 MB to download and 580 MB on disk; the models stay in Ollama's own folder (`~/.ollama/models`), so a later Ollama install finds them. Nothing is downloaded without a click. Ollama needs macOS 14, which is why the packaged app declares it as its minimum (`LSMinimumSystemVersion`, set by `scripts/package.sh`). With `RESSAC_OLLAMA_URL` set, or under `RESSAC_TEST_NO_SYSTEM`, Ressac starts and installs nothing; `RESSAC_TEST_OLLAMA_KIND` (`absent`, `stopped`, `outdated`) fixes the status for the e2e. To move to a newer Ollama, change `OLLAMA_VERSION` and `OLLAMA_SHA256` together (the hash is on the release page).

### Docker

Same idea for the container app (`host/docker-runtime.ts`): when Docker does not answer and OrbStack or Docker Desktop is installed, Ressac opens it in the background at launch (`open -ga`), and the welcome and Settings › Atelier show « Démarrer <app> » if that failed. Ressac never quits it and never installs it: with none on the machine the pages keep the link to OrbStack's download. `RESSAC_TEST_DOCKER_KIND` fixes the status for the e2e.

## AI features switch

`settings.aiEnabled` (Réglages › Agents; the welcome's page « Activer l'IA ? » asks first) turns every AI feature on or off. Existing sessions keep it on; a fresh install starts with the question. Off, the chrome tells the host (`start` and the live `ai.enabled` message, applied in order): `host/host.ts` starts no Docker, Ollama or kernel, and refuses their work with `Error("ai-off")`. Every AI entry point (agent panel, command bar, home, empty page, agent apps) shows the `AiAsleep` card (`ui/components/AiAsleep.svelte`) instead, with a button to switch AI on. Switching on after the welcome runs the AI-only setup. In the e2e, `RESSAC_TEST_AI=0` starts with AI off (`launchRessac({ ai: false })`; the default is on).

## Work loop

- Changed `ui/` or `chrome/` (files already declared in `jar.inc.mn`): `pnpm ui`, then restart the app with `-purgecaches` (otherwise an existing profile keeps running the old scripts from its startup cache). No `mach`, no build: the app reads our files through symlinks.
- Changed a `src/**` `.js`/`.css`/`.html` file: `pnpm build:ui` (~17 s: Vite, then `mach build faster`).
- Added a file to `src/`: `pnpm engine:import` (builds the UI first, so the generated sidebar files get linked), then `pnpm build:ui`.
- Changed a `*.patch`, or anything compiled (C++, Rust, `jar.mn`): `pnpm engine:import`, then `pnpm build`.
- Tests: `pnpm test` (unit), `pnpm e2e` (headless Firefox with a temporary profile, driven over Marionette).

## Reports (Sentry)

A packaged build with a DSN (`RESSAC_SENTRY_DSN` at package time, never in the repo) sends, while the switch in Réglages is on (pref `ressac.telemetry.enabled`): errors (`errorEnvelope`, no page address, IP sent as `0.0.0.0`), native crashes, and one session per launch (`sessionEnvelope` in `shared/telemetry.ts`, item type `session`, `status: "exited"`) carrying a random install id kept in the pref `ressac.telemetry.installId`. Sentry › Releases then counts installs (users) and launches (sessions) per version. The version is `version` in `apps/firefox/package.json`, baked into the UI by `build:ui` (`__RESSAC_VERSION__`): Sentry's release, Réglages › À propos, the DMG name and the Finder version (`Info.plist`, rewritten by `scripts/package.sh` before signing) all read it. Bump it for each DMG sent to testers; it costs a normal package. `displayVersion` in `surfer.json` is compiled into Gecko (a near-full rebuild) and only moves with Firefox engine updates. Turning the switch off deletes the install id; nothing is sent while it is off. One « exited » session per launch: no live session nor crash-free rate (`shortcut:` comment).

## Data

The Ressac state (session, settings) lives in the `data` folder next to `engine/` by default, never in `~/Ressac`. Set `RESSAC_DATA_DIR` to use another folder. The e2e always sets it to a temporary folder.

Two instances must never share a data folder: the session's temporary file name is the same in both (no pid in Firefox), so they would overwrite each other's session.

## Coming from WebAiOs

Ressac was called WebAiOs. At the first launch on a machine that had WebAiOs, `chrome/store/carry-over.ts` runs once. It checks that WebAiOs is not running (otherwise it shows « Quittez WebAiOs, puis relancez Ressac. » and quits), renames `~/WebAiOs` to `~/Ressac` (and `workspace/.webaios` to `.ressac`, the old caches removed), moves the profile last used by the installed WebAiOs into Ressac's profile root, registers it as `webaios-carried`, makes it this install's default and restarts once on it. Its state is `~/Library/Application Support/Ressac/carried.json`. An unfinished carry-over stops Ressac with a message and is retried at the next launch: Ressac never starts on half-carried data. A Ressac.app moved to another folder is pointed back at the carried profile. Ressac returns to the carried profile at every launch, so a default profile chosen by hand in about:profiles is not kept. It never runs on a development or test launch (profile given on the command line, `RESSAC_DATA_DIR`, `RESSAC_TEST_NO_SYSTEM`). There is no way back: the old WebAiOs no longer finds its profile.

Stored formats that keep the old spelling, so nothing has to be migrated: the container identities `userContextIdInternal.webaios-<id>` (logins of spaces, site apps and agent apps), the Docker volume `webaios-home` (the agent's logins) and the carried profile's name `webaios-carried`.

Old names still read: `webaios.json` (new: `ressac.json`), `webaiosOpen` and `webaiosSite` (new: `ressacOpen`, `ressacSite`), `webaios://` addresses in a saved session, the five `webaios.*` prefs (moved to `ressac.*` at start, before telemetry, unless Ressac already has its own value), the three keychain services `webaios-*` (copied to `ressac-*` on first read), the review mark `refs/webaios/relu` of a project reviewed under WebAiOs (until the next « Marquer comme relu » writes `refs/ressac/relu`) and the old workshop container `webaios-<name>` (removed before the new one is created).

Agent extensions: ids are now `<x>@agent.ressac`. One installed under `@agent.webaios` stays guarded until the chrome uninstalls it at start (and drops it from the toolbar's pinned list); its registry entry is forgotten, so it is not reinstalled by itself: the agent has to ask the user again, which signs it again with Mozilla under the new id (its own storage is lost). Its folder in `~/Ressac/extensions/` stays.

Accepted losses:

- Saved payment cards (Firefox encrypts them with a keychain secret labelled with the app's name; passwords are not concerned).
- The workshop image is rebuilt once under its new name; the old image stays on disk.
- The `.webaios/` folders inside individual projects (logs, profiling).
- Telemetry on Firefox's fresh profile: on a launch the carry-over stops with a message, Ressac runs on the empty profile Firefox just made, before WebAiOs's telemetry choice is carried, for as long as the message stays open, and again at each such launch. Only a native crash report can leave then (the session report waits for the notice to have been shown).
- Each launch from a new path (the DMG, then `/Applications`) leaves an empty `default-ressac` profile folder in Ressac's profile root.
- A resumed agent conversation still names `mcp__webaios__*` tools in its history.
- Hand-edited agent instructions that still name `/workspace/.webaios/` paths.
- The macOS grants (screen recording, camera, microphone, notifications, default browser) are asked again: the bundle id changed.

## Add-ons

Add-ons are shared by every login profile. Signing is required (`MOZ_REQUIRE_SIGNING`), so the e2e install temporary add-ons (`Addon:Install`, `temporary: true`).

- Anchors: the add-on popups and the permission and site prompts open on the address bar of the sidebar (`#ressac-anchor`); the toolbar buttons of the sidebar strip have their own anchor (`#ressac-action-anchor`). Three hooks make this work: `gUnifiedExtensions.getPopupAnchorID`, `PopupNotifications._getVisibleAnchorElement`, and the panel anchor lookup (`_getPanelAnchor`). Prompts follow their tab and stay open across tab switches (site prompts too).
- `about:addons` is the management page: it opens as a Ressac tab (« Gérer » in the strip).
- Pins: the `ressac.extensions.pinned` pref (add-on ids, in order); the ⧉ button lists the others.
- Profile containers are internal (`userContextIdInternal.webaios-<id>`, private non-policy identities, so add-ons such as Multi-Account Containers never list them).
- The agent's public reads run in a private windowless browser (`privateBrowsingId: 1`): add-ons (`webRequest` included) do not run there. Its cookies are cleared with `{ userContextId, privateBrowsingId: 1 }`.
- The user agent has `Firefox/<version>` (`general.useragent.compatMode.firefox` in `ressac.js`, needs `pnpm build:ui`): AMO needs it to offer « Add to Firefox ».
- After a Firefox upgrade, rerun the probes: `RESSAC_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/addons-spike.e2e.ts --silent=false`. Private fields we rely on: `lastClickInfo`, `openPopupWithoutUserInteraction`, `_getVisibleAnchorElement`, `_getPanelAnchor`, `_hidePanel` / `_ignoreDismissal`, `ContextualIdentityService._identities` / `_lastUserContextId`, the parking tab `isEmpty` override.

Limits:

- Add-ons also run in private spaces.
- An add-on tab is recreated in the space's container when the add-on asks for another `cookieStoreId`.
- `tabs.create({})` and `about:` URLs from add-ons are not adopted.
- A selection Firefox makes of one of our tabs in another space switches to that space.
- `ExtensionControlledPopup` is not hooked.
- A closed prompt does not reopen (no icon in the address bar); the « added » doorhanger shows only if the window has focus.
- `page_action` and `sidebar_action` are not supported.
- An add-on sees the parking tab and only the tabs already shown (`tabs.query`).
- Themes do not restyle our UI.

## Agent-written extensions

Each is copied, signed by AMO (unlisted) and installed as an add-on (`<folder>@agent.ressac`); the kernel host keeps the registry and sends the grants to the chrome (`extensions.scopes`). The guards of the copy (`ressac-*-guard.js`) ask the chrome through the extension actor (`window.__ressac`, defined on the agent's extension pages before their first script); the chrome also refuses every http request an agent extension loads or starts outside its grant, whatever its type (an `http-on-modify-request` observer on the loading or triggering principal, so a notification icon too), the `window.open` of its pages, and a `runtime.setUninstallURL` outside its grant.

Setup and files:

- Signing: AMO, unlisted channel, under the user's own free Mozilla developer account. Settings › Agents › « Compte Mozilla (extensions de l'agent) » (`SettingsMozilla.svelte`) explains why (Firefox only installs Mozilla-signed add-ons), links to `https://addons.mozilla.org/developers/addon/api/key/` and takes the « Émetteur JWT » and « Secret JWT ». It shows « Compte branché » (with the issuer) or « Non branché », « Enregistrer » and « Retirer ». The RPCs `settings.amoAccount` / `setAmoAccount` / `deleteAmoAccount` only ever answer `{ saved: boolean, issuer?: string }`: the secret never comes back, and is never in argv, a file, the state or a log.
- Keychain item: a single generic password, service `ressac-amo`, account = the JWT issuer (`user:<id>:<id>`), password = the JWT secret. Saving deletes every `ressac-amo` item then adds one, the secret going through `security -i` on stdin. The kernel host reads it at each upload. The `security` command still works: `security add-generic-password -s ressac-amo -a <JWT issuer> -w`. Tests use `RESSAC_TEST_KEYCHAIN` (`<path>.amo` holds `issuer:secret`), never the real item. Without keys a grant answers « Compte Mozilla non branché : Réglages › Agents › Compte Mozilla. Rien n'est parti chez Mozilla. »
- The Extensions page opens with a « Comment ça marche » block (shown first time via the `extensions` hint in `shared/hints.ts`, also reachable from a link that opens Settings › Agents). It explains the agent's extensions, the signing delay and the Mozilla account. The old Chrome Web Store install path is gone: store add-ons come from addons.mozilla.org in a tab, and their source label reads « addons.mozilla.org ».
- Files in `<dataDir>/extensions`: `state.json` (registry: grants, scopes, state), `copies/<folder>@agent.ressac/` (the modified copy), `signed/` (the signed `.xpi` kept, reinstalled at startup if missing), `amo-versions.json` (the counter per id; never lowered nor cleared, not even by « Supprimer », because AMO never reuses a number).
- Id `<folder>@agent.ressac`; version `<a>.<b>.<c>.<n>` (the agent's version completed with zeros to three numbers, then the counter; four numbers are refused).
- Signing takes 154 to 298 s (median 284 s, spike S1); the timeout is `SIGNATURE_DELAY_MS` = 900 000 ms.
- The actor `extension-actor.sys.mjs` is a packaged file (jar line): run `pnpm build:ui` after pulling it. The e2e load it instead through a `resource://` substitution (`RESSAC_TEST_EXTENSION_ACTOR=<src/browser/base/content/ressac>` plus the `security.sandbox.content.mac.testing_read_path1` pref); after a `build:ui`, rerun the `agent-extensions-*.e2e.ts` files once without that variable.
- Messages between the window and the host: `extensions.*` (`list`, `scopes`, `grant`, `install`, `toggle`, `remove`, `console`, `crash`, `amo`, …).
- Tests: the e2e never reach the network. `RESSAC_TEST_AMO_URL` (API base of `test/fake-amo.ts`) and `RESSAC_TEST_AMO_KEYS` (`issuer:secret`, absent = no keys) make the chrome install what the fake server returns as a temporary add-on; `RESSAC_TEST_WATCHDOG_MS` shortens the crash watchdog window. The one real test is `RESSAC_AMO=1 pnpm exec vitest run test/amo.test.ts` (keys in the keychain, network, one throwaway signature). `RESSAC_SPIKE=1` runs the probes of `e2e/extensions-spike.e2e.ts`.

The copy accepts only the rights an agent extension may use (`scripting`, `storage`, `unlimitedStorage`, `tabs`, `contextMenus`, `cookies`, `webNavigation`, `alarms`, `offscreen`, `clipboardRead`, `clipboardWrite`, `declarativeNetRequest*`), in `permissions` and `optional_permissions`; any other right (`activeTab` included; a host pattern in `permissions` too: stricter, so safe), or a manifest key that grants a power (`chrome_settings_overrides`, `protocol_handlers`, `user_scripts`, `experiment_apis`, `theme_experiment`, `omnibox`), is refused before any card with « Droit non pris en charge par Ressac : <name> ». Firefox-only APIs (`identity`, `dns`, `find`, `notifications`, …) are thus out of reach. `tabs.captureVisibleTab`, `tabs.captureTab`, `tabs.detectLanguage`, `tabs.saveAsPDF`, `tabs.print`, `tabs.printPreview` and `tabs.toggleReaderMode` are refused in the parent for every page of an agent extension (« <api> non pris en charge par Ressac »): Firefox grants activeTab to an MV3 extension on a click of its button, its menu item or its command even without the right. The copy's pages are sandboxed without `allow-popups` (`content_security_policy.extension_pages`): `document.open(url, "_blank")` and `<a target=_blank>` open nothing: an agent page opens no window.

Limits:

- An `about:blank` frame of an agent page inherits its principal, and Firefox would give it the whole extension API without the guard: the extension actor (registered without `matches`, so it reaches those frames) defines `__ressac` there and takes out `chrome`, `browser`, `window.open` and WebRTC, before the page's script reads the frame. A page of the extension loaded in a frame reuses that window: it keeps no extension API (its guard then does nothing; its scripts cannot call `chrome.*`). A `srcdoc` frame is cross-origin to the page and runs none of its scripts.
- Before the first host sent the grants, the actor's answers wait 5 s at most, then refuse; the request observer refuses at once (fail closed): a background fetch right after a restart can be cancelled until `extensions.scopes` arrives.
- `action.setIcon` with an absolute address is accepted by Firefox; no load was seen headless (the strip does not render it yet). Recheck when the strip renders action icons.
- Per space, only the content scripts follow the switches of a space's settings: they run in a Ressac tab of a non-private space whose profile the extension is active in, and in that profile's container (never an invisible read, which has no tab id). Firefox runs one copy of each add-on for every profile, so its background, its `declarativeNetRequest` rules and `tabs` stay global: active in one space, its background sees the tabs (with the right) and its rules apply in every non-private space. Never a private space: its tabs are hidden from the agent's extensions (`tabManager.canAccessTab`), a profile turned private reloads at once, in the chrome (host or not), every tab of that profile an agent script was let into, even one of an extension switched off there since; the kernel then takes the profile out of every agent extension (`extensions.privateProfiles`) and disables it where it is active nowhere else. Disabling an add-on stops its scripts already injected.
- A tab the agent cannot read sends `extensions.ran` once per extension and profile: the registry masks its console there (`hiddenConsole`) and by add-on id (`hiddenConsoles`, never emptied). A note sent while no host runs is sent again on the next check.
- Firefox specifics of the content guard (`ressac-*-guard.js`, from the kernel): a content script's `window` is the page's window through an Xray, so every member the guard sets on the content script's global (`open`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `FormData`, the `on…` key and input handlers) is set on that window too; the agent's files are injected one `executeScript` per file, because Firefox drops a whole call when one file fails to compile. A `url()` in an agent stylesheet loads with the extension's principal, so the request observer cancels it outside the grant. The conduit wrap that refuses the capture, print and PDF tab calls has no startup self-check: the same rerun after an upgrade covers it (it detects `detectLanguage`).
- The content guard is deterrence, not a guarantee (its header lists what stays open). Code in the page's world escapes it (an inline `<script>`, an `on…` attribute); on Firefox the same door is also `wrappedJSObject` and `XPCNativeWrapper.unwrap` (the page's own objects: password values, listeners, the page's `fetch` and `open`, whose loads carry the page's principal, so the request observer does not see them). An `about:blank` frame the content script creates has no guard either: its `fetch` and `open` go out (`open` can open a tab). The same holds for a same-origin frame the page already has, reached through `frames[i]` (its `FormData` reads passwords, its `fetch` and `XMLHttpRequest` go out).
- Crashes (3 in 60 s disable the extension everywhere, « Réactiver » on the Extensions page): Firefox names no extension that crashes (spike S7), so the chrome counts:
  - an uncaught error of its background window within 1 s of the background's start. The parent's console proves it uncaught but has no window; the console actor's relay has the window. The same file and text from both is one load error. An MV3 event page sends its start again on each wake, so an uncaught error in a listener in that first second counts too;
  - an extension process that crashes;
  - an extension process that stops answering the console actor's ping. The ping runs only while an agent background runs. The process is killed after two consecutive 10 s windows without an answer, measured on a monotonic clock; a window whose timer fires late, or a wake from sleep, starts the count again. The kill is skipped (logged) when Firefox is one crash away from its respawn limit (`extensions.webextensions.crash.threshold`).

  That process runs every add-on, Mozilla's included: its crash or kill stops them all, and counts one crash for each agent extension whose background was running, whichever caused it. A hung background is killed after at least 20 s, and it does not restart by itself, so three hangs in a minute need restarts in between. Crashes seen while no host runs are sent with the next `extensions.ready`, at their own time.
- Every grant and every reload goes over the network and waits for Mozilla (about 5 minutes); the code leaves the machine for Mozilla, under the AMO account whose keys are in the keychain.
- At startup, a source changed while the app was closed is signed again (within the scope already granted; a wider scope disables the extension and keeps the grant). That is the one upload not triggered by an agent call.
- A version number that goes down is accepted by AMO (measured) and installed over the newer one by Firefox (not tried).
- `importScripts` and `clients` do not exist in a translated background (it is a page, not a service worker); calling them throws in the agent's console.
- Mozilla's add-ons (AMO modules) are active in every space, private ones included, and are listed as store add-ons with no console.
- The e2e install temporary add-ons: `onInstalled` after a restart and the kept storage are checked only by the real test (`RESSAC_AMO=1`) and the manual checks.
- New French texts: « Installation impossible : <message> », « Droit non pris en charge par Ressac : <name> », « <api> non pris en charge par Ressac », « Espace disparu pendant la carte : rien n'est activé », « Paramètres invalides » (internal).
- The AMO linter's view of the CSP `sandbox` directive is unchecked (S1 signed a copy with it; the real test covers it).
- After a Firefox upgrade, rerun `e2e/agent-extensions-guards.e2e.ts`: the `runtime.setUninstallURL` guard redefines the `uninstallURL` field Firefox reads (`ext-browser.js`); if Firefox makes it private or renames it, the guard does nothing and only the `setUninstallURL` test notices (measured: with the hook inert, it fails).

## History and downloads

- The history is `history.sqlite` in the data folder, kept by the kernel host with the `History` class of `core/history.ts`. The window talks to it through the `history.*` messages.
- Firefox's own Places is turned off at runtime (`places.history.enabled=false` on the default branch, set when the store starts): it records no visit, so there is no `:visited` colour. Tab history, favicons and reopening closed tabs still work.
- Visits are noted by `chrome/window/visits.ts`; the page text the agent can search is retained through the actor's `getText` message (`body.innerText` only). Private spaces are replayed to the host on each host start.
- The download list is Firefox's (`Downloads.getList`), shown in the UI's downloads panel; it is kept for the session only.
- Native keys and commands that would open Firefox's own history, bookmarks or downloads UI are disabled (⌘Y, ⇧⌘H, ⇧⌘O, ⇧⌘⌫, `Browser:ShowAllHistory`, `Browser:ShowAllBookmarks`, `Tools:Downloads`, `Tools:Sanitize`).
- After a Firefox upgrade, rerun the probes: `RESSAC_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/history-spike.e2e.ts --silent=false`.

Limits:

- Firefox picks the free name of a repeated download: `file(1).txt`, with no space before the number.
- The retained text is the `meta` description then body; title, channel and description on a YouTube watch page, composition in `shared/page-text.ts`. The page actor must be rebuilt (`pnpm build:ui`): an older build silently retains the body text alone.
- A visit or text sent while the host is down is lost.
- The download list is not kept across a restart (the panel says « Aucun téléchargement pendant cette session. »).
- A download from a private space stays in the list.
- A file Firefox blocks shows « Interrompu », without « Garder quand même »; a blocked or cancelled download may leave its partial file in the folder.
- `/coupee` (truncated page) is not ported: Firefox may count a cut page as loaded.

## Import from another browser

- **Where:** welcome page 2 (« Vous venez d'un autre navigateur ? ») and Réglages › Données › « Importer depuis un autre navigateur ». Both use `ui/components/BrowserImport.svelte` and the `browserImport` API: `sources`, `profiles`, `start`, `progress`, `importPasswordsCsv`.
- **Sources and data:** detected under the home, listing only the browsers whose data folder exists. Nothing in them is read until the person picks one: only then are its profiles read (Chromium's `Local State`, Firefox's `profiles.ini`), the last used preselected.
  - **Chrome and its cousins** (Brave, Edge, Vivaldi, Opera): the engine's own migrators.
  - **Arc:** the engine's `ChromeProfileMigrator`, pointed at Arc's folder and keychain item (`chromiumMigrator` in `chrome/store/import/sources.ts`).
  - **Firefox and Zen:** subclasses that read the source's own `profiles.ini` and a copy of `places.sqlite`.
  - **Safari:** the engine's migrator.
  - There is no engine patch: the subclasses live in our chrome code.
- **Bookmarks:** they go into Places through `PlacesUtils.bookmarks.insertTree`, skipping a URL already in a folder of the same title; a folder already there of the same title gets the new ones. They are never shown in the sidebar. They are searchable from ⌘T (« Favoris ») and by the agent (`search_bookmarks`, through the host RPC `bookmarks.search` to the chrome).
- **History:** during a run, `MigrationUtils.insertVisitsWrapper` is swapped to send each batch (5 000 visits) to the host RPC `history.import`. The visits land in the kernel history under `IMPORTED_SPACE` (`"import"`), never private, within `RETENTION_DAYS`. For the run, the engine's Chromium caps are lifted:
  - `browser.migrate.chrome.history.limit` is set to 0;
  - `browser.migrate.history.maxAgeInDays` is set to 183;
  - both are restored afterwards.
- **Passwords:**
  - Chromium: the engine reads them, and macOS asks for the source's keychain item.
  - Safari, Firefox and Zen: by CSV, with a guide on screen. The import uses `LoginCSVImport`.
- **Arc and Zen spaces** (`chrome/store/import/spaces.ts`): spaces, favorites and pinned tabs become Ressac spaces, essentials and pinned tabs. They go through the store actions `createSpace` (with `pinned`) and `addFavorites`. A space with the same name is reused, a URL already present is skipped, and a private space never receives anything.
- **Source icons:** the screen shows each installed app's own icon. The store reads `moz-icon:` for the bundle in `/Applications` or `~/Applications` and hands the UI a PNG `data:` URL (`appIcon`); an app that is not found has no icon.
- **Arc and Zen open tabs** (type `tabs`, its own checkbox « Onglets ouverts »): after the spaces, `planTabImport` opens each open tab in its space with `openTab` (`activate: false`, with its `title`), in the first window. No tab loads before it is displayed, and an address already open in the space is skipped. A space with neither pinned nor open tabs is not created.
  - The Arc sidebar format is assumed, not measured (no Arc on the dev Mac); see the `shortcut:` comment.
  - Zen is read from `zen-sessions.jsonlz4`.
- **Background run:** one import at a time, in the background. It ends with a macOS notification giving the counts per type, or what failed and why.
  - A locked or unreadable Chromium file is retried once on a copy in `<dataDir>/import-tmp/`.
  - That folder is removed at startup (a quit or crash mid-import may leave it) and at the end of every run, and « Exporter les données » never includes it.
- **Not imported:** cookies and logged-in sessions, and extensions.
- **Tests:**
  - `RESSAC_TEST_IMPORT_HOME` replaces the home for source paths. Every e2e launch defaults it to an empty folder, so a test never reads the real `~/Library`.
  - Under a test home, Safari's engine migrator never runs, and Chromium passwords never touch the keychain.
  - `RESSAC_TEST_IMPORT_CSV` replaces the CSV file picker.
- **Manual checks:**
  - a real Chrome import, with the keychain prompt;
  - a real Arc import (folders, keychain names, sidebar format);
  - Safari with Full Disk Access;
  - a Zen import.

## Site permissions

- Asked once per (origin, permission) and login profile: notifications, position, camera, microphone, plus DRM and MIDI. Screen sharing and links to another application are asked every time. Fullscreen and clipboard writes are granted without a question; everything else is refused without one (clipboard reads, `storage-access`, `xr`, persistent storage, local network, HID/serial/USB).
- The question is the Ressac banner over the page (`chrome/window/site-banner.ts`); the page moves down by its height (`--ressac-banner`). Firefox's own permission prompts never show.
- Decisions live in `permissions.json` (`permissions-<profile>.json` for the others), kept by `chrome/store/site-permissions.ts`, and are copied into Firefox's `Services.perms` with the profile's container (`permissions.isolateBy.userContext` is on), so `Notification.permission` and `permissions.query` answer right. At startup Firefox's stored site permissions are wiped and rebuilt from the files; a deleted profile takes its decisions.
- The hooks (`chrome/store/permission-hooks.ts`): `Integration.contentPermission` (position, notifications, DRM via `media.eme.require-app-approval`, MIDI), a wrap of `WebRTCParent.prototype.receiveMessage` (camera, micro, screen), of `nsContentDispatchChooser.prototype.handleURI` (external links) and `ClipboardContextMenu.confirmUserPaste` (clipboard reads). A page that navigates or closes during its question drops it (refused this time, asked again next time). Invisible reads are refused.
- Prefs set on the default branch at startup: `media.autoplay.default=0` (sounds play without a click), `privacy.popups.showBrowserMessage=false` (no popup-blocked bar), `full-screen-api.warning.timeout=0` (no fullscreen warning).
- « Navigation > Oublier les autorisations de ce site » in the menu bar forgets the active tab's origin in its space's profile.
- After a Firefox upgrade, rerun the probes: `RESSAC_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/permissions-spike.e2e.ts --silent=false`.

Limits:

- Screen sharing uses the macOS picker (no list in the banner, no tab sharing); without it (macOS < 14) screen sharing is refused.
- Widevine is downloaded by Firefox on first use (network); the banner comes after.
- Clipboard writes need a click (Firefox's rule).
- Firefox's site permissions stored before this block are lost (wiped at startup).
- Not checked headless: the real menu bar entry, the macOS screen picker, a real camera, Widevine, launching a real external application.

## Agent dev tools

The agent reads a tab's console and network, runs JS, reloads, profiles and compares memory (`read_console`, `read_network`, `run_js`, `profile_performance`, `memory_snapshot`, `compare_memory`). The agent asks first through a consent card.

- No debugging port. `chrome/store/devtools.ts` plugs a DevTools client into Firefox's DevTools server through an in-memory pipe, the way the toolbox does. `devtools.debugger.remote-enabled` stays true, but nothing listens.
- The user's DevTools toolbox works on the same tab at the same time. `DevToolsBusy` is never raised.
- A tab other than the agent's local demos (`localhost`/`127.0.0.1` on the demo and app ports) needs the consent card; a private-space tab is refused before any client exists.
- The raw profile is a converted `.cpuprofile`. The raw memory snapshot is census JSON (`format: "ressac-firefox-census"`).

Known limits:

- The memory census names classes, not constructors: a page's own class shows as `Object`.
- `run_js` stops waiting after 10 s and drops the late result. An endless loop keeps running until Firefox's hang monitor stops it.
- Unhandled rejections from the agent's own code (source "debugger eval code") never reach `read_console`.
- Firefox's profiler is shared by the whole browser. An agent profile is refused while another one runs, with « Le profileur de Firefox est déjà en cours (about:profiling ou un autre profil de l'agent) … » (it is not queued). A profile the user starts during an agent profile is stopped with it.
- A dev tool call cut by the agent's own `navigate` to another site answers the generic cut text (`TEXT_CUT`), not « L'onglet a changé de site. »: the kernel cuts the right before the load commits. A page that leaves by itself still answers « L'onglet a changé de site. ».
- A page that does not answer within 10 s (an endless loop, a breakpoint): `memory_snapshot` fails with « La page ne répond pas. », `profile_performance` answers without `Nodes` and `JSHeapUsedSize`.
- Whether CORS/CSP platform warnings reach `read_console` was not probed.

## The home page

- The home page is the sidebar's no-tab screen (`ui/Home.svelte`, in `EmptyPage`; the address field, `Essentials` and the local-AI slot stay). A widget is a folder of the space, `workspace/home/widgets/<id>/` (`widget.json`, `display.html`, `harvest.mjs` or `workflow.json`, `example.json`): the agent writes files, there is no API.
- Service: the kernel host answers `home.*` (`read`, `place`, `remove`, `harvest`, `runs`, `run`, `grant`, `denyGrant`) and sends `home.change` after every write (a widget or the theme written by the agent, an accord, a removal, a harvest); a successful placement writes `layout.json`, which the `home/` watcher reports as `home.change`. The profiles offered by the accord card come from the renderer's state (`ui/home-profiles.ts`), not from the host. Widget data, states and accords live outside the space, in `<dataDir>/widgets`.
- Display: each widget with a `display.html` is served from `resource://ressac-widget-<id>/display-<mtime>.html`, in an iframe with `sandbox="allow-scripts"` (opaque origin). On every `home.read`, the sidebar (`ui/api.ts`) reads `<dataDir>/workspace/home/widgets/<id>/display.html` (the widget folder confined by `realpath`: a symlink leaving it is refused) and writes a sanitized copy to `<dataDir>/ressac-widgets/<id>/display-<mtime>.html` — regenerated only when the source's mtime changes, the `<mtime>` being what reloads the frame — then sets the `resource` substitution `ressac-widget-<id>` to that folder (`chrome/window/widget-frame.ts`) and rewrites the widget's `src`. The copy starts with `CSP_WIDGET` as an injected `<meta http-equiv>` (a `resource://` file cannot carry a response header) then the guard's `<script>`, after any doctype: no network, no form, no frame, inline scripts and styles only, Trusted Types; a display carrying a network hint (`<link>`, `<meta http-equiv>`, speculation rules) is replaced by `DISPLAY_DENIED` before any script. Removing a widget clears its substitution and copy folder. A custom `ressac-widget:` scheme was tried first and removed: measured in this Firefox, a frame never commits it (it stays `about:blank`, with no error) while `chrome://` and `resource://` frames load. Data arrives by `postMessage` (`data`, `size`, `px`, `state`); a widget link calls the page-world helper `window.ressacOpen(url)`, installed by the guard, which dispatches `ressac-open` on the frame's window; the chrome UI (`WidgetFrame.svelte`) listens for it on `contentWindow` and calls `api.home.open`, only after a real click (`isTrusted`) and only for an `http(s)` URL outside the machine (`openableUrl`). Measured: a sandboxed `resource://` frame cannot post to its chrome parent (`parent.postMessage` throws `Permission denied`), and `event.source !== parent` inside the frame; the helper replaces a `parent.postMessage` link protocol. The three shipped model widgets are updated at startup: a starter widget whose `display.html` sha256 matches a shipped pre-fix version (`packages/kernel/src/workspace/initialize.ts`) receives the current one, while a `display.html` the user or the agent edited (unknown hash) is left alone. A widget of the user's own that still keeps `e.source === parent` renders nothing (the sandboxed frame sees no message), and one that still calls `parent.postMessage` for links opens no link, until it uses the Firefox forms above; the agent can fix it on request.
- Guard: the widget guard, inlined as a `<script>` at the head of the served copy (`chrome/window/widget-frame.ts`), so it runs in the page world before the widget's own scripts: no WebRTC, Trusted Types by default, `<link>`, `<meta http-equiv>`, XSLT and code-as-text refused. A `widget-actor` `JSWindowActor` was tried first and removed: measured, its child does not act on these `resource://` frames in this Firefox (the parent exists and the frame is in-process, but `RTCPeerConnection` stays). The UI attaches the gesture listener itself: a capture-phase `pointerdown` on the frame's `contentWindow` from the chrome sidebar (`WidgetFrame.svelte`), calling `api.home.gesture`, and only when the guard installed (`RTCPeerConnection` gone and `trustedTypes` present) — if the guard threw, no click is recorded and no link opens. The WebRTC globals are shadowed with a non-configurable own `undefined` property, WebRTC last; deleting them did not work, measured: they live on `Window.prototype`, so the delete leaves the native function reachable, and the UI reads the page world through `wrappedJSObject` (an Xray would still show the native interface). The sidebar's own CSP carries `frame-src resource:` for the frame.
- Placement: free, in `workspace/home/layout.json` (`version: 3`): `x`/`w` in thousandths of the home width, `y`/`h` in pixels. Drag by the header, resize by the bottom-right handle; the widget cannot be dropped on another one and never moves it, but a drag may pass over a neighbour; the grid snaps (5 ‰ horizontally, 8 px vertically) with accent guides, holes are kept. A widget without a placement is put in the first free spot by the kernel on every read (`placeMissingFree`), so one the agent adds appears without a restart. A window resize stretches the thousandths and keeps the pixels.
- Theme: `workspace/home/theme.json`, written by the agent with its file tools. `packages/kernel/src/home/theme.ts` validates it (colours `#rrggbb`, `radius`/`spacing` 0–24, `font` `system`, `serif` or `mono`) and the home root applies it as CSS variables. Absent or invalid: the app's theme, a console warning, the file left untouched; delete it to come back to the default.
- Harvests: the kernel's scheduler (minutes or fixed hours), the workshop container `ressac-workshop-firefox`, `harvest.mjs` or a workflow; « Mettre à jour maintenant » in the widget menu. Accords: a widget with `sources.account` waits for the accord card, which names the domains read with the account and those contacted publicly and remembers the chosen login profile; the accord (domains and profile) is kept in `<dataDir>/widgets/grants.json`. Refusing erases the accord and what was read with the account and hides the banner for the session; removing a widget moves its folder to `workspace/home/.trash` and erases its accord and its data.
- Notifications: a finished harvest of a widget with `harvest.notify` shows a macOS alert through Firefox's alerts service (`Cc["@mozilla.org/alerts-service;1"]`, never the XUL fallback): title = widget name, text = number of new items, never their content. The e2e write one JSON line per notification to `RESSAC_TEST_NOTIFICATIONS` and show nothing.
- Host stopped: an action sent while the kernel host is stopped changes nothing; the card says « Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?) » after 6 s, and the page stays displayed.
- Builder: « Voir / modifier le workflow » opens the workflow builder on `ressac://workflow/<widget>`, in the sidebar frame (an action's « Voir le workflow » opens the same builder on its action, see « Actions »). On a widget's builder, its Agent tab, ⌘J and ✦ open the window's agent panel on the right (the same conversation) instead of hosting the terminal in the tab (`e2e/builder-agent.e2e.ts`). On an action's builder, ⌘J and ✦ open its Agent tab.
- Tests: `e2e/home.e2e.ts`, the watch and the notification click in `e2e/watch.e2e.ts`; the fake docker is `test/tools/docker` (the launcher puts it on `PATH`), so no test touches a real container.

Limits:

- One theme palette only (no light/dark variant), no free CSS; the sidebar, the agent and the panels keep the app's theme.
- A login profile that becomes private or is deleted does not re-ask at once: the accord is refused at the widget's next scheduled harvest (at the next read; no observer).
- `display.html` is written by the agent: the CSP and the guard are deterrence, not proof.
- One home page for every space: widgets, data and accords are not per space.
- `ai.*` blocks run entirely in Ollama: Gemma (`gemma4:e4b-mlx`) writes, and the decision model `pplx-decider-flash` replaces Kev (same `/v1/systemone` request and answers; compared on real widgets: 90–100 % same keep/drop decisions, score correlation ~0.9). Gemma is `gemma4:e4b-mlx`, or `gemma4:e4b` when only that one is installed (`check()` reports `gemmaModel`; generation uses the detected one). Réglages › IA locale has a « Télécharger » button next to an absent model while Ollama answers: the host's `settings.pullModel` (`host/ollama-pull.ts`) accepts only `gemma4:e4b-mlx` and the chosen decision model, posts Ollama's `/api/pull`, and the page polls `settings.pullProgress` for the percentage (one pull at a time, no cancel: quitting stops it and Ollama resumes later). A missing model fails the block with `Kev a répondu 404`. `RESSAC_KEV_URL` still points the decisions at a Kev server instead (the e2e use it for their fake).

## Actions

- An action is a folder of the space, `workspace/actions/<id>/` (`action.json`, `workflow.json`, its `.mjs`), and agent components live in `workspace/components/<name>/`; runs, results, accords and `launch-denials.json` live outside it, in `<dataDir>/actions/`.
- Launch: from the new tab and the ⌘T bar (suggestions, input asked as a second field), from the « Actions » page (`ressac://actions`), or by the agent. The tab shows the progress, then Gemma's page; previous results reopen without launching anything; two actions run at once, a third waits (« En attente : deux actions tournent déjà »). No action in a private space: the list is not even asked.
- Service: the kernel host (`host/actions.ts`, the disk half of the actions service) answers `actions.*` and sends `actions.change` and `actions.live`. The chrome half (`ui/actions-api.ts`) checks the private space before each request and again after its answer, dispatches, limits links to one per second, filters the live feed and offers the accord profiles. `open` runs in this order, split in two calls: private check, the host reads the action without launching it, private check again, `dispatch` `openAction`, then only the launch.
- Host stopped: the action page keeps its last read (no « Action inconnue »), and reads everything again once on the first `access` after the host comes back (« Réessayer »), without reopening the tab.
- Images: the host checks the conditions (no account, no accord, kept run, `https` address present as is in the results, neither local nor private); the chrome then loads the image through an anonymous channel (`LOAD_ANONYMOUS`: no cookie sent or stored, no referrer) in the internal `webaios-action-images` container, at most 3 checked redirects, `image/*` only, 5 MB at most, and gives it to the UI as `data:` (`ui/ActionImage.svelte`). Images load lazily (`IntersectionObserver`), once each; a decode error shows the neutral slot. The e2e set `RESSAC_TEST_ACTION_IMAGES=<origin>`: `https://<host><path>` is then asked from `<origin>/<host><path>`, a local server, and every redirect is refused; nothing leaves the machine.
- Components: a sanitized copy of `component.html` in `<dataDir>/ressac-components/<name>/component-<mtime>.html`, served by the `resource://ressac-component-<name>/` substitution (no content access) in a `sandbox="allow-scripts"` frame, with `CSP_WIDGET`, the widget guard and `COMPONENT_BRIDGE` first (`ui/ActionComponentFrame.svelte`). The bridge turns `parent.postMessage` into a `ressac-component` event; only a `{type:"height", px}` from this frame, showing the current copy, counts (clamped to 20–2000). The substitution and copies go when the last page showing the component closes; the folder is emptied at store start. `Components` is hidden in component frames only: it is Firefox's leftover web object (interfaces only), harmless, hidden so component pages never see it. A component cannot navigate to another `resource:` page, and a self-navigation to http reaches nothing.
- Builder: the action part of the builder is in `host/workflow.ts`; saves go through the `action:<id>` write queue.
- Tests: `e2e/actions-*.e2e.ts`, `e2e/builder-actions.e2e.ts`, the actions part of `e2e/command-bar.e2e.ts`; the probes `RESSAC_SPIKE=1 … e2e/actions-spike.e2e.ts`.

Limits:

- A running action takes over the widgets' AI; no « Mise en page… » in the builder; with the workshop stopped the page says « atelier arrêté »; DNS rebinding is not handled for images; the layout uses Gemma in Ollama, the fallback layout without it.
- The action builder reads and writes even with the kernel stopped (as widgets do in this host).
- A widget display that compares `e.source` to `parent` receives nothing (see « The home page »).

## Site apps

- An app is a folder of the space, `<dataDir>/workspace/sites/<id>/` (`site.json`, `home/`, written by the agent). What Ressac keeps lives outside it, in `<dataDir>/sites/<id>/` (`memory.json`, `url.json`) and in `sites.json` (window frame, favicon). « Supprimer » moves the folder to `workspace/sites/.trash/<id>-<time>` and wipes the session and the memory.
- Each app runs in its own internal container (`webaios-site-<id>`: cookies, localStorage, IndexedDB), in its own window (`chrome/store/sites.ts`, `ui/SiteWindow.svelte`): one `<browser>`, never a main window, never listed by ⌃Tab. A request guard (`http-on-modify-request`) keeps it on the app's domains and sign-in domains before anything leaves; the home screen is served from `resource://` in a sandboxed frame of the bar.
- The page's code runs in the `RessacSite` actor (`site-actor.sys.mjs`), one `Cu.Sandbox` per document. It is read through the symlinks of `build:ui`: after a change to the actor, ask for `build:ui` (the e2e use `testActor`, the packaged one with `RESSAC_E2E_PACKAGED_ACTOR=1`).
- The Applications page's « Sites » section (`ressac://apps`): the host (`host/sites.ts`) answers `sites.list` and `sites.act`, and sends `sites.change`. « Afficher le dossier » and « Relire » are the UI's (`ui/api.ts`). The command bar lists the apps; the agent has `list_sites`, `open_site`, `close_site` and `site_memory`.
- What the agent adds (plan 32):
  - **tweaks** (`tweaks/*.css`, `*.js`, `ressacSite`): the actor's child asks its parent what goes into each frame (`sendQuery`); the parent decides from its own `WindowGlobalParent` (`chrome/store/site-frames.ts`, `injectionFor`), never from what the frame says, and only for the app's view (never the sign-in window or a tab). Memory goes to the host (`host/site-memory.ts`); the retouches' console is relayed per frame;
  - the **accord card**: the view stays `about:blank` until the choice; rights that grow bring it back;
  - **video resume** (`ResumeTracking` of `core/resume.ts` in the actor, positions kept by the host) and the **address follow** (`UrlTracking` of `core/sites/tracking.ts`);
  - the **agent's tools** on `site:<id>` (`list_tabs`, `read_tab`, `capture_screen`, `navigate`, dev tools) behind the app's « widget_data » card;
  - **add-on buttons** in the app bar (`createSiteAddons`, `ui/SiteAddonsStrip.svelte`); the view is protected from add-ons (no remove, move, adopt, `windows.remove`, non-http loads; the request guard's net).
- The end-to-end scenario with AGENTS.md's examples: `e2e/sites-scenario.e2e.ts`.
- The probes: `RESSAC_SPIKE=1 corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/sites-spike.e2e.ts`, to run again after each Firefox update (measures the window, the routing, the sandbox and the home).

Limits:

- The apps' modules are global (§4.9 of the spec): one list for every app, not per app.
- No « Gérer » add-on menu in the app bar, and no title-bar drag region: Firefox keeps its native title bar.
- `about:srcdoc` and `about:blank` frames get video resume when the top page is on the app's domains; nothing else goes there.
- The « widget_data » card now covers widgets, actions and site apps; before plan 32, widget data read with an account was always refused.
- The request guard's net is always on, so the page's own navigations under the home or the card are dropped. `tabs.create` from an add-on opens in the main window.
- « Supprimer » withdraws the agent's accord on the app: an app made again under the same id asks again.
- The headless e2e decode no media: the 10 s `timeupdate` step and a real `ended` are covered by unit tests only. The packaged actor is checked with `RESSAC_E2E_PACKAGED_ACTOR=1` after each `build:ui`.
- A sign-in window opened by `window.open(url)` without features has no `opener` (a login waiting for `opener.postMessage` fails). A window opened with features towards a refused domain shows for an instant, then closes; nothing leaves. A TCP preconnect (no HTTP request) is not seen by the guard.
- Firefox does not resolve `*.localhost`: the e2e add a DNS override (`resolveLocalHosts`). Visits of an app window are not recorded (`places.history.enabled` is false).

## Agent applications

- An app the agent writes is a folder `<dataDir>/workspace/projects/<folder>/` with a `ressac.json` manifest, run by the kernel in Docker (`host/applications.ts`, the kernel's `ApplicationManager`). Its window is `chrome/store/apps.ts` + `chrome/window/app-window.ts`: one `<browser>` on the app's port, no bar, never a main window.
- Each app has its own internal container (`webaios-app-<folder>`) and a request guard that keeps it on its origin: other sites open in a tab of the main window; `file:`, `data:` and `blob:` are refused (also as http redirects); permissions are denied per origin and container; the view is protected from add-ons. Closing the window stops the app; so does the host stopping (the window closes). At quit the apps stop first, then the sessions.
- The Applications page's Docker section (`ui/api.ts`): launch, stop, delete, « Passer en application », debug (the terminal is filled, not sent), « Afficher le dossier » (`reveal`, never `launch`), « Relire ». ⇧⌘A opens the page; Firefox's own ⇧⌘A (about:addons) is disabled.
- The badge (top right of the window, `ui/badge-api.ts`) shows the agent's access to the app and lets one cut it or open the Review page; the page cannot reach it. « Mode design » and the basket in its menu drive the design mode of the app (see « Design mode »).
- The Review page covers these apps: the first snapshot is taken at start (apps without a manifest are skipped).
- The design viewfinder runs in the `RessacDesign` actor (`chrome/agent/design-actor.ts`, every frame, http/https). It is the one packaged file of this plan: after a change to it, ask for `build:ui` (the e2e use `testActor`, the packaged one with `RESSAC_E2E_PACKAGED_ACTOR=1`). Its guard sits on the `chromeEventHandler`; a cross-origin frame in another process is guarded by its own actor.
- Copies with drift tests: `validFolder` (`chrome/store/app-folder.ts`, `test/containers.test.ts`), the home's `MOUSE` (`chrome/store/design-home.ts`, `test/design-copies.test.ts`).
- Tests: `e2e/apps-window.e2e.ts`, `apps-page`, `apps-actions`, `apps-badge`, `design-actor`.

Limits:

- Firefox add-ons run in app windows (shared by every container, spec §13.8); there is no add-on bar there.
- Apps without a manifest (`no-manifest`) are not snapshotted for review.
- Downloads from an app container are not cancelled, and cross-origin frames load inside the app (both by design).
- A cached 301/308 to `file:` leaves the view on `about:blank`.
- Headless cannot route a real click into an out-of-process frame: the viewfinder's cross-origin case is tested through WebDriver actions, and a headed check is pending.

## Shortcuts and vim mode

### The binding table

`shared/shortcuts.ts` is the one table of window shortcuts. It has 17 ids (`command`, `address`, `closeTab`, `back`, `forward`, `reload`, `newWindow`, `agent`, `history`, `settings`, `reopen`, `reloadHard`, `closeWindow`, `downloads`, `compact`, `apps`, `design`), each with a label and a default binding. `chrome/window/keys.ts` matches a key event against the effective bindings (defaults plus `settings.shortcuts` overrides, read at each keydown); a digit binding matches `e.code` (AZERTY), any other key its character. The capture (`bindingFromKey`) also reads the zoom keys ⌘0 ⌘− ⌘= on `e.code`, so AZERTY's ⌘à is ⌘0.

- Not remappable: ⌘1–9, ⌃1–9 and ⌃Tab / ⌃⇧Tab are handled before the table.
- Reserved, refused with a reason: ⌘Q ⌘H ⌘M ⌘C ⌘V ⌘X ⌘A ⌘Z ⇧⌘Z ⌘F ⌘G ⌘P ⌘S ⌘O ⌘+ ⌘− ⌘0 ⌘⇥ ⌘`; ⌘ with an arrow, ⌫ or ⌦ (any ⇧ ⌥); ⌃ without ⌘ with A E B F N P D H K or an arrow (Cocoa text editing, Mission Control); ⌃⌘F, ⌃⌘Space; ⌘{ ⌘} and ⌃PageUp/PageDown, which the window consumes before the table. A binding needs ⌘ or ⌃; one already used by another id is refused too (`bindingProblem`).
- Persistence: `settings.shortcuts` holds only the overrides (`{}` by default). On load, unknown ids and malformed bindings are dropped; each override is then checked, in table order, against the other kept overrides and the defaults they leave, and dropped on a clash or a reserved key (so a swap survives a restart). Actions: `setShortcut`, `resetShortcut`, `resetShortcuts`.
- Capture gate: while Réglages › Raccourcis waits for a combination, the controller (`setCapturingShortcut`) lets the keys through to the page instead of running them. The capture ends on Échap, on a key, when Settings closes, or when the focus leaves the Settings frame.
- Labels follow the bindings: tips, welcome, sidebar, compact bar and design buttons call `shortcutLabel`; the site and agent app windows read `liveBindings()`; the design state carries its label (`DesignState.shortcut`), and a remap notifies the design listeners so open windows re-read it.

### Vim mode

Off by default (Réglages › Raccourcis › « Mode vim », `settings.vimMode`). It is the content actor `chrome/agent/vim-actor.ts` (`RessacVim`, bundled to `vim-actor.sys.mjs`). `chrome/store/index.ts` registers it only while the setting is on, so with the mode off no page has the actor or its listeners. Turning the mode off unregisters it, which destroys the actors: `didDestroy` removes the listeners and the layer (hints, pill). Turning it on registers it and sends `vim:mode` to the http(s) pages already open, whose child then installs its listeners.

| Key | Action |
|---|---|
| `j` `k` / `h` `l` | scroll 60 px down/up, left/right |
| `d` `u` | scroll half a page down/up |
| `gg` `G` | top / bottom |
| `H` `L` | back / forward |
| `r` | reload |
| `x` / `X` | close / reopen the tab |
| `J` `K` (and `gT` `gt`) | previous / next tab, in the sidebar's order, wrapping |
| `g0` `g$` | first / last tab |
| `t` | new tab (command bar) |
| `o` | address bar |
| `gs` `gS` | next / previous space, wrapping |
| `f` `F` | link hints; typing the letters opens the link (`F`: background tab) |
| `/` | Firefox's find bar |
| `yy` | copy the page address |
| `i` | pause the vim keys in this tab; `⇧Échap` resumes (and pauses when active) |
| `Échap` | drop hints, a pending prefix or the `?` sheet |
| `?` | show / hide the cheat sheet (bottom-right, same layer as the hints) |

- Where: web tabs (http/https, top frame) of main windows only. The parent answers `vim:state` true only when the setting is on, the window is a main window (`ressacWindow`) and the tab has a `ressac-tab-id`; it re-checks before each action.
- The guard: the child listens to keydown/keypress/keyup in capture on `docShell.chromeEventHandler`, so the page never sees a key the actor took (its own `window` capture listeners included). Untouched: keys with ⌘ ⌃ ⌥, IME composition, untrusted events, events from another document (frames, bfcache).
- Editable fields: when the target (chrome-only `composedTarget`, which a closed shadow root does not hide) is a text input, textarea, select or contenteditable, every key goes to the page, `i` and `⇧Échap` included; Échap also blurs the field, giving the keys back. A checkbox, radio, range, button, file or color input is not a field.
- Inner scrollers: scrolling moves the window while it can; otherwise the scrollable ancestor of the last element clicked or hovered; otherwise the largest visible scrollable element. `d`, `u`, `G`, `gg` use that box.
- Hints: labels sit in a div with a **closed** shadow root, styled by a constructed stylesheet (a `<style>` is blocked by page CSP). Colors come from the main window's tokens and the font bytes (Geist Mono woff2, read once) from the parent via `vim:style`, since a web process cannot fetch `chrome://` and a shadow root ignores `@font-face`. Only HTML links (not SVG `<a>`) whose centre point hits the link are labelled. The « vim en pause · ⇧Échap pour reprendre » pill (no `?` hint: while paused `?` belongs to the page) and the `?` sheet use the same layer.
- The cheat sheet: `shared/vim-keys.ts` (`VIM_KEYS`) is the one list of keys, bundled into the actor for the `?` sheet and read by Réglages › Raccourcis, which shows it while the mode is on (the only list: add a key there first). `test/vim-keys.test.ts` drives the actor's `run` over every printable key and fails if one it handles is missing from the list.
- The pause is per document: a reload or navigation ends it.

Build facts: changing the actor needs `pnpm build:ui`. A fresh engine needs `pnpm engine:import` first: it creates the `vim-actor.sys.mjs` link in `src/`, and without it `build:ui` fails. Tests: `e2e/vim.e2e.ts`, `e2e/settings-shortcuts.e2e.ts`, `test/shortcut-bindings.test.ts`, `test/vim-keys.test.ts`.

Limits: no links in cross-origin iframes; not in site app or agent app windows; the find bar is Firefox's own (English, not styled by Ressac).

## Design mode

- The ✎ button of the toolbar and ⇧⌘D (Firefox's own bookmark-all-tabs shortcut is disabled) start the viewfinder on the selected tab of a main window, or on an agent app window. Only a tab on a followed project (an agent demo, an agent app, a project connected by a Claude Code) is armed; elsewhere a message shows for 4 s and nothing is injected. 
- The chrome service (`chrome/store/design.ts`) arms only the `RessacDesign` actor of the target's current `WindowGlobal`, once at a time. Every process-root frame under it is guarded too, including frames added while aiming (`window-global-created`). A reload, another document, another tab, a crash or the window closing ends the mode; the cart stays. A stop that hangs is cut after 1 s.
- A click captures the element: `drawSnapshot` of `rectCapture`, cropped on a canvas (PNG of the rectangle's size at any zoom or density). The bubble, the message and the app window's cart are in a transparent chrome frame (`sidebar.html?overlay`) placed over the page; the main window's cart is a 300 px column (frame `#ressac-design-volet`) that narrows the page through `--ressac-panier`. The bubble takes the keyboard (⌘Enter adds, Escape cancels) and gives it back to the page. An overlay never names its target: the chrome binds it.
- The host (`host/design.ts`: `design.tracking`, `.add`, `.basket`, `.batches`, `.remove`, `.handled`, `.send`) re-checks every context and capture (PNG, 8 MiB at most). « Envoyer » fills the agent's terminal (no Enter) or, for an external project, queues the batch for Claude Code. With the host down the cart keeps its last read and the call's error shows.
- Agent app windows: the badge's « Mode design », « Panier » and « Relire ce projet » act on the window's own app; ⇧⌘D inside toggles its own mode.
- Copies with drift tests: `shared/design-guards.ts` (`test/review-host.test.ts`), `chrome/shims/kernel.ts` (`test/shims.test.ts`).
- Site app windows (plan 36): the ✎ button of the app bar (with its chevron: « Panier », « Relire ce projet ») and ⇧⌘D toggle the mode of that app; the target comes from the window, never from the page. The viewfinder is the packaged `RessacDesign` actor in its own sandbox next to the retouches' (no `build:ui`), without the source read; the bubble warns that a third-party page is captured. The app's home is a `resource://` frame of the bar in the parent process: the chrome aims it without an actor (`chrome/store/design-home.ts`, a Xray sandbox per document, armed only on the served home), and its remarks are tagged `[home]`. Unavailable on the accord card, the login page, in fullscreen (a 5 s `info` notice in the bar). ⌂, « Entrer dans le site », fullscreen, another document (a retouche reloads the view) or the window closing end the mode; the cart stays. In the small sign-in window ⇧⌘D toggles nothing and shows the notice. With the host down ✎ keeps its last state. The home's `source` read runs synchronously in the parent process: a home that loops in `closest` freezes the browser.
- Tests: `e2e/design-service.e2e.ts`, `design-overlay`, `design-button`, `design-send`, `design-apps` (ports 15300-15324), `design-sites-view`, `-bar`, `-home`, `-send` (15345-15364, helpers in `design-sites.ts`); the actor ones also run packaged with `RESSAC_E2E_PACKAGED_ACTOR=1` (`design-actor`, `design-service`).

Limits:

- A page CSS can hide the viewfinder, a batch stays « read » until marked done, a retouch that reloads the page ends the mode.
- Add-on frames (`moz-extension:`) are not guarded; a frame added during aiming is guarded only once its actor answers (a few ms); Escape inside a cross-origin frame that has the keyboard does not stop the viewfinder.

## External MCP and Review

The host runs the external MCP server (port 5279, `RESSAC_PORT_MCP_EXTERNAL` changes it, `0` in the tests) without the kernel: `host/design.ts` creates the remarks, the registries of external clients and projects, and the review service. It listens on 127.0.0.1 only, checks Host and Origin, keeps only the SHA-256 of each token, and never falls back to another port (« Le port 5279 est pris »). It stops with the host; « Réessayer » restarts it on the same port with the same tokens.

- The « Projets externes » section of the Applications page connects a Claude Code (the command with the token shows once), declares projects, revokes a client, forgets a project. A project folder under the data folder is refused (`SPACE_FOLDER`). Registries, private repositories (`design/review/`) and batches (`design/remarks/`) live under `<dataDir>/design`, never in the space.
- The Review page (`ressac://review`) shows the diff of an external project or of a site app since the last « Marquer comme relu ». Comments go to Claude Code (`read_remarks`, `wait_for_remarks`) or, for a site app, into the agent panel: the text waits there and Enter sends it (`design.agentWindow`, `design.giveAgent`).
- `host/review.ts` (the review service) and `shared/design-guards.ts` (the input checks) are tested by `test/review-host.test.ts`. `core/design/external.ts` and `send.ts` are imported as is.
- Tests: `e2e/external-mcp.e2e.ts`, `e2e/review.e2e.ts`, `e2e/review-comments.e2e.ts`.

## The UI's network

The UI (sidebar, agent panel, site bars, badges, overlays, widgets, components, site homes) reaches no web server. Tabs, reads, site apps and agent apps keep their network. Five pieces:

- **Predicate** (`chrome/store/ui-network.ts`): a document is the UI's by its own address or an in-process ancestor's (past 32 ancestors it counts as the UI's). Tabs and `browser.xhtml` are not. A frame's navigation is judged by its target context, the frame (its `APP_TYPE_MAIL` mark or its UI parent document), not by `browsingContext`, which is the parent's. A dedicated worker's load falls back to its associated context. A load with no document and no context (WebTransport; a worker's fetch in the parent process) is judged by its principal: a UI address, or system for WebTransport.
- **Content policy**: refuses http, https, ws and wss from opaque UI documents, whatever the host. System documents skip content policies.
- **Observer** (`http-on-opening-request`): cancels the same loads. It is the only layer for system documents.
- **Frame flags** (`cutFrameNetwork` in `chrome/window/frame-network.ts`): `allowDNSPrefetch = false` and `APP_TYPE_MAIL` on each UI frame, which cuts DNS prefetch and link hints.
- **Press guard**: a capture `mousedown` on `windowRoot` is consumed on a link (`:any-link`) in any UI document, system ones included, so no speculative connect starts. The walk follows slots and shadow hosts and fails closed past 1024 steps. The click still works. History links no longer take focus, selection or drag on press.

WebRTC is refused by a `PeerConnection:request` observer for UI documents.

Rule: every new UI frame calls `cutFrameNetwork(frame)` after it is inserted and before its `src` is set. If the observer failed to install, no UI frame gets its `src`.

Test hook: `RESSAC_TEST_UI_NETWORK_FAIL=policy|observer|webrtc` forces an install failure.

Limits:
- `moz-remote-image:` wrapping an http URL, and any script, in a system document are not covered (only our code runs there).
- WebRTC from system documents is not refused.
- A system document's worker or WebTransport without a context is not refused (only our code runs there). The widget guard removes `WebTransport`.
- `media.navigator.permission.disabled = true` lifts the WebRTC refusal for opaque documents.
- A widget link press loses focus. A plain `<a href>` in a widget no longer navigates its frame.
- Favicons are fetched by the tab, with its container's cookies, never by the UI.

Tests: `test/ui-network.test.ts`, `e2e/ui-network.e2e.ts`, `e2e/ui-network-fail.e2e.ts` (helpers in `e2e/ui-network.ts`).

## Known gaps

- site-app permission checks;
- the host does not restart on its own after a crash: « Réessayer » in the panel relaunches it;
- internal `ressac:` pages without a Firefox version yet show a "not available yet" message;
- tab previews in ⌃Tab: the cards show the icon;
- zoom is not tracked in the state;

## The window

No title bar (`browser.tabs.inTitlebar`, in `ressac.js`: needs `pnpm build:ui`). macOS places its window buttons on the box `#ressac-window-buttons` and hides them when there is none, as in compact mode (the theme geometry of `-moz-window-button-box`). The sidebar drags the window through `-moz-window-dragging`, which only counts in a nested document whose docShell has `windowDraggingAllowed`.

Sidebar side (Réglages › Vie privée › Interface › « Barre de navigation »): `settings.sidebarSide` (`left` by default). On `right`, the controller sets `ressac-sidebar-side="right"` on the chrome root and `window.css` mirrors the frames: the sidebar on the right edge, the agent panel on the left, the design basket between the page and the agent. The window buttons stay in the sidebar's top row, which is still the drag zone. The UI follows the state: full-window pages (`App.svelte`), the compact column (it folds out to the right), the context menu clamp, and the agent's resize handle (on its right edge, one signed drag handler). The compact mouse zone uses `innerWidth - x`. Tests: `e2e/sidebar-right.e2e.ts` and the right-side cases in `agent-panel` and `compact`.

## Worktrees

`engine/` is shared by all checkouts (it links to `~/Ressac-firefox/engine`), and the import links `src/` files of the checkout that ran it. Run `pnpm engine:import` in the checkout you build. Links left behind by a deleted worktree are dangling: `engine:import` prunes them first (`scripts/engine.sh prune`), otherwise surfer fails with ENOENT.

## Calls in a background tab

A tab that uses the camera or the microphone when it is left (`TabSelect`, `chrome/window/calls.ts`) gets `tab.call` (`{ mic, camera }`, volatile) and the sidebar shows a call bar above its footer (`ui/components/CallBar.svelte`): back to the call, microphone, camera. The tab's actor (`chrome/agent/call-actor.ts`, `RessacCall`, every http(s) frame) reads the state every 500 ms while watched and relays changes; the bar goes when the tab is shown again, the call ends or the tab closes.

- Buttons: on a site of `shared/call-sites.ts` (Meet, Teams, Zoom) the actor dispatches the site's own macOS shortcut in the page (a chrome-made key event is trusted), so the site and the other participants see the change; the state shown is the site's buttons when it has `buttons` (`data-is-muted`), else what the window captures (`mediaCaptureWindowState`). On any other site Firefox mutes what the window sends (`getUserMedia:muteAudio` / `muteVideo`): the site's own UI does not show it. More sites without a build: pref `ressac.call.sites`, a JSON array of `CallSite` (read in the parent: a web process does not get a user string pref).
- Video: Firefox's automatic picture-in-picture on a tab switch is on (`media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`), kept for calls only: `chrome/store/call-player.ts` wraps `PictureInPictureToggleParent.receiveMessage` and, instead of Firefox's own choice (which refuses a live stream without a sound track), asks the call actor, which hands the largest playing video of a capturing page to `PictureInPictureLauncher`. Firefox closes the player when the tab is shown again.
- Tests: `e2e/calls.e2e.ts`, on fake devices (`media.navigator.streams.fake`; they count as a capture only with `media.navigator.permission.fake`). Not measured on the real Meet, Teams or Zoom.
- Build facts: as the vim actor, a new checkout needs the `call-actor.sys.mjs` link in the engine (`pnpm engine:import`).

## Sound and playback in tabs

- Sound pictogram: `tab.sound` (`"playing"` / `"muted"`, volatile) follows the XUL tab's `soundplaying` and `muted` attributes (`TabAttrModified`, `chrome/window/tabs.ts`). `ui/components/SoundButton.svelte` shows it on the tab's row, on its pinned row and in the media bar; a click calls `tab.toggleMuteAudio()` (`ressacWindow.toggleMute`). A muted tab keeps its pictogram until unmuted. Essentials (icon tiles) have none.
- Media bar: `tab.playback` (`"playing"` / `"paused"`, volatile) follows the tab's `browsingContext.mediaController` (Firefox's media keys' session: `activated`, `deactivated`, `playbackstatechange`), listened to from the first sound or when the tab is left. `"paused"` is kept only for a background tab that was playing (a tab left with nothing playing has no bar). A tab with `playback` that is not the one shown gets a bar above the sidebar's footer (in `CallBar.svelte`, under the calls): back to the tab, play / pause (`mediaController.play()` / `pause("user")`: `pause` needs its reason), sound. A tab in a call has the call bar only. Videos do not float (calls only).
- Tests: `e2e/media-bar.e2e.ts`. Sound does not decode in a hidden test browser, so real playback (the session's events, play / pause on a real page) is not covered there.

## Pitfalls

- The macOS 27 SDK breaks Mozilla's linker (unknown `arm64e.x1`): SDK 26.5 is forced (`configs/macos/mozconfig`, `scripts/env.sh`).
- A truncated Firefox archive stays cached in `.surfer/engine/` after an interrupted download: delete it.
- surfer declares a git fork of `is-apple-silicon`, which pnpm rejects: replaced by the registry version (`pnpm-workspace.yaml`).

## Folders of pinned tabs, sending a tab to another space

- **Folders** (`ui/components/Pinned.svelte`): a space has `folders` (`{ id, name, collapsed }`, one level), and a pinned tab names its folder in `Favorite.folder`. `pinned` stays one flat list, so everything that reads it is unchanged. The folders come first, then the pinned tabs outside any folder. Actions: `createFolder` (optionally around a pinned tab), `renameFolder`, `deleteFolder` (its tabs stay pinned), `toggleFolder`, `moveToFolder`, and `pinTab` with `folderId` (a tab dropped on a folder). A new folder's name is typed in place.
- **Sending a tab** (`moveTabToSpace`): a normal tab goes to the end of another space's list, in the background. `TabSync.sync` already reopens a page whose container changed, so a space with another login profile reloads it at the same address. A pinned tab or an essential does not move.

## Release notes

`shared/release-notes.ts` lists what changed, newest first. At each start the store dispatches `noteVersion` with the running version: when it differs from `settings.seenVersion` and the newest entry is for that version, the internal page `ressac://release-notes` (« Nouveautés ») opens once. A first launch only records the version. The page stays reachable from Réglages › À propos. When bumping `version` in `package.json`, add its entry.

## Publish a release

For a version that goes to testers only. Ressac updates itself from `https://updates.getressac.app` (Cloudflare R2 bucket `ressac-update`, or `RESSAC_R2_BUCKET`). The beta is invite-only, so nothing there has a path written in this code: everything sits under `updates/<RESSAC_UPDATE_KEY>/`, a random folder name (24 to 64 lowercase letters or digits, e.g. `openssl rand -hex 16`) kept outside the repository and set at package time. `package` writes it into the app's `application.ini` (`[AppUpdate] URL`) and into `update.xml`; Réglages › À propos derives its « Télécharger » link from that URL. Anyone holding a DMG can read the key from it: it hides the feed from readers of the code, not from testers.

1. Bump `version` in `package.json` and add its entry at the top of `shared/release-notes.ts`.
2. `pnpm run package` with the signing, notarization and MAR key and `RESSAC_UPDATE_KEY` set up: it writes `dist/Ressac-<version>.dmg`, `.mar` and `dist/update.xml`. Without the key it packages no update archive.
3. `pnpm run release:publish` with the same `RESSAC_UPDATE_KEY` (once before: `npx wrangler login`). `scripts/publish.sh` refuses unless the DMG is notarized, the MAR verifies against `dep1.der`, `update.xml` and the top release notes entry are for this version, `update.xml` was packaged with this key, and `releases/<version>/` is not on the server yet (a published version is never rewritten). It then uploads, under `updates/<key>/`: `releases/<version>/Ressac-<version>.mar` and `.dmg`, `Ressac.dmg` (the latest, `Cache-Control: max-age=300` so Cloudflare does not keep an old one), and last `browser/Darwin_aarch64-gcc3/ressac/update.xml` with `Cache-Control: no-cache`, so it never points at a file not uploaded yet. Not `pnpm publish`: that is pnpm's own command. If an upload fails halfway, run it again: a MAR already on the server that is byte-identical to `dist/`'s is a retry and the uploads resume; a different one is refused.
4. A tester's download link: `pnpm run release:invite [days]` prints a presigned link to the latest DMG, valid 1 to 7 days (7 by default, the longest S3 allows). It needs an R2 API token with read access on the bucket (Cloudflare › R2 › Manage API tokens): `RESSAC_R2_ACCOUNT_ID`, `RESSAC_R2_ACCESS_KEY_ID`, `RESSAC_R2_SECRET_ACCESS_KEY`.

Rolling back is a new version: put the old code back, bump to a new, higher number (Ressac drops any update whose version is not above the running one, see `chrome/store/updates.ts`; Firefox itself only skips the same build ID, since every Ressac MAR carries the same Gecko version), add its notes entry (« Retour en arrière sur … »), package and publish as above.
