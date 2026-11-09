# WebAiOs on Firefox

WebAiOs rebuilt on stable Firefox. Built with [surfer](https://github.com/zen-browser/surfer), which downloads Firefox into `engine/`, symlinks our `src/` files into it (same relative path), applies our `*.patch` files (`git apply`) and runs `mach`.

## Requirements (macOS arm64)

- `brew install gnu-tar python@3.12`; Rust in `~/.cargo/bin`; Mozilla toolchains in `~/.mozbuild` (installed by `engine:bootstrap` if needed).
- About 25 GB free: the Firefox sources live in `~/WebAiOs-firefox/engine`, and `engine/` is a symlink to them.
- Every command goes through `scripts/env.sh` (PATH, SDK): use the pnpm scripts.

## First install

```sh
pnpm --filter firefox-webaios engine:install   # downloads Firefox 159.0.1, moves it out of the repo, links it
zsh apps/firefox/scripts/branding.sh           # placeholder icons (Firefox "unofficial" branding)
cd apps/firefox && pnpm exec surfer set brand webaios
pnpm engine:import                             # links src/ and applies the patches
pnpm build                                     # full build (~20 min)
```

In a new checkout or worktree: `pnpm engine:link` then `pnpm engine:import`. The `engine` tree is shared between checkouts: run `engine:import` in the checkout you work in before building.

## The bundles

`scripts/ui.sh` builds five bundles with Vite from `ui/` and `chrome/`, into `src/browser/base/content/webaios/` (generated, git-ignored):

- `sidebar`: the Svelte UI, loaded in an iframe of the browser window;
- `window`: the window controller (syncs WebAiOs tabs and spaces with Firefox tabs and containers, shortcuts);
- `store`: the shared state module (`store.sys.mjs`: session file, containers, shutdown save, the agent host), imported by the window at runtime;
- `agent`: the agent panel (terminal), a second iframe on the right of the window;
- `actor`: the page and extension JSWindowActors (`page-actor.sys.mjs`, `extension-actor.sys.mjs`). These are **copied** into the build, not linked (the macOS content sandbox cannot read a file outside the source and object trees): after changing `chrome/agent/page-actor.ts` or `extension-actor.ts`, run `pnpm build:ui`. The e2e load the extension actor as `pnpm ui` built it, through a `resource://` substitution (`WEBAIOS_TEST_EXTENSION_ACTOR` plus the `security.sandbox.content.mac.testing_read_path1` pref), so they need no rebuild. After each `build:ui`, run them once against the packaged actor with `WEBAIOS_E2E_PACKAGED_ACTOR=1`.

## The agent

The kernel (`@webaios/kernel`) runs in a separate Node process, `host/host.ts`, started by Firefox and spoken to in JSON-RPC over stdio (one message per line). Its console output goes to Firefox's console prefixed `[kernel]`; stdout carries only the protocol. The Node and tsx paths are frozen at build time (`scripts/paths.ts`): a dev build only runs on the machine that built it.

The agent's workshop container is `webaios-atelier-firefox` (`WEBAIOS_CONTENEUR`). It publishes ports 5300-5319 (`WEBAIOS_PORTS_CONTENEUR`) and mounts the `webaios-home` volume. These names stay: renaming them would orphan the existing container.

Invisible reads run in a windowless browser, in a private container cleared before and after each read. Every request from a reading container is checked: an address that is local, or a name that resolves to one (or fails to resolve), is refused. Known limits, marked `shortcut:` in `chrome/agent/local-guard.ts` and `invisible.ts`: custom-scheme navigations, preconnects, Alt-Svc, WebRTC, and service workers in a login profile's container. Paced reads (the workflows' `web` widgets) wait for another site's turn before following a navigation to it: the read stops at that site's document, gives its place back, waits, then resumes (`chrome/agent/invisible.ts`, `host/remote-bridge.ts`).

## Work loop

- Changed `ui/` or `chrome/` (files already declared in `jar.inc.mn`): `pnpm ui`, then restart the app with `-purgecaches` (otherwise an existing profile keeps running the old scripts from its startup cache). No `mach`, no build: the app reads our files through symlinks.
- Changed a `src/**` `.js`/`.css`/`.html` file: `pnpm build:ui` (~17 s: Vite, then `mach build faster`).
- Added a file to `src/`: `pnpm engine:import` (builds the UI first, so the generated sidebar files get linked), then `pnpm build:ui`.
- Changed a `*.patch`, or anything compiled (C++, Rust, `jar.mn`): `pnpm engine:import`, then `pnpm build`.
- Tests: `pnpm test` (unit), `pnpm e2e` (headless Firefox with a temporary profile, driven over Marionette).

## Data

The WebAiOs state (session, settings) lives in `~/WebAiOs-firefox/data` by default, next to `engine/`, never in `~/WebAiOs`. Set `WEBAIOS_DATA_DIR` to use another folder. The e2e always sets it to a temporary folder.

Two instances must never share a data folder: the session's temporary file name is the same in both (no pid in Firefox), so they would overwrite each other's session.

## Add-ons

Add-ons are shared by every login profile. Signing is required (`MOZ_REQUIRE_SIGNING`), so the e2e install temporary add-ons (`Addon:Install`, `temporary: true`).

- Anchors: the add-on popups and the permission and site prompts open on the address bar of the sidebar (`#webaios-anchor`); the toolbar buttons of the sidebar strip have their own anchor (`#webaios-action-anchor`). Three hooks make this work: `gUnifiedExtensions.getPopupAnchorID`, `PopupNotifications._getVisibleAnchorElement`, and the panel anchor lookup (`_getPanelAnchor`). Prompts follow their tab and stay open across tab switches (site prompts too).
- `about:addons` is the management page: it opens as a WebAiOs tab (« Gérer » in the strip).
- Pins: the `webaios.extensions.pinned` pref (add-on ids, in order); the ⧉ button lists the others.
- Profile containers are internal (`userContextIdInternal.webaios-<id>`, private non-policy identities, so add-ons such as Multi-Account Containers never list them). `migrateContainers` converts the old public ones in place at startup; cookies are kept.
- The agent's public reads run in a private windowless browser (`privateBrowsingId: 1`): add-ons (`webRequest` included) do not run there. Its cookies are cleared with `{ userContextId, privateBrowsingId: 1 }`.
- The user agent has `Firefox/<version>` (`general.useragent.compatMode.firefox` in `webaios.js`, needs `pnpm build:ui`): AMO needs it to offer « Add to Firefox ».
- After a Firefox upgrade, rerun the probes: `WEBAIOS_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/addons-spike.e2e.ts --silent=false`. Private fields we rely on: `lastClickInfo`, `openPopupWithoutUserInteraction`, `_getVisibleAnchorElement`, `_getPanelAnchor`, `_hidePanel` / `_ignoreDismissal`, `ContextualIdentityService._identities` / `_lastUserContextId`, the parking tab `isEmpty` override. Details and limits: `docs/superpowers/notes/2026-11-04-modules-firefox-essai.md`.

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

Each is copied, signed by AMO (unlisted) and installed as an add-on (`<folder>@agent.webaios`); the kernel host keeps the registry and sends the grants to the chrome (`extensions.portees`). The guards of the copy (`webaios-garde-*.js`) ask the chrome through the extension actor (`window.__webaios`, defined on the agent's extension pages before their first script); the chrome also refuses every http request an agent extension loads or starts outside its grant, whatever its type (an `http-on-modify-request` observer on the loading or triggering principal, so a notification icon too), the `window.open` of its pages, and a `runtime.setUninstallURL` outside its grant.

Setup and files:

- Signing: AMO, unlisted channel. The keys sit in the macOS keychain, read by the kernel host at each upload and never written anywhere: `security add-generic-password -s webaios-amo -a <JWT issuer> -w` (the password is the JWT secret). Without them a grant answers « Clés AMO absentes » and nothing leaves the machine.
- Files in `<dataDir>/extensions`: `etat.json` (registry: grants, scopes, state), `copies/<folder>@agent.webaios/` (the modified copy), `signes/` (the signed `.xpi` kept, reinstalled at startup if missing), `amo-versions.json` (the counter per id; never lowered nor cleared, not even by « Supprimer », because AMO never reuses a number).
- Id `<folder>@agent.webaios`; version `<a>.<b>.<c>.<n>` (the agent's version completed with zeros to three numbers, then the counter; four numbers are refused).
- Signing takes 154 to 298 s (median 284 s, spike S1, `docs/superpowers/notes/2026-11-04-extensions-agent-essai.md`); the timeout is `SIGNATURE_DELAY_MS` = 900 000 ms.
- The actor `extension-actor.sys.mjs` is a packaged file (jar line): run `pnpm build:ui` after pulling it. The e2e load it instead through a `resource://` substitution (`WEBAIOS_TEST_EXTENSION_ACTOR=<src/browser/base/content/webaios>` plus the `security.sandbox.content.mac.testing_read_path1` pref); after a `build:ui`, rerun the `agent-extensions-*.e2e.ts` files once without that variable.
- Messages between the window and the host: `extensions.*` (`liste`, `portees`, `accord`, `installer`, `basculer`, `supprimer`, `console`, `plantage`, `amo`, …).
- Tests: the e2e never reach the network. `WEBAIOS_TEST_AMO_URL` (API base of `test/fake-amo.ts`) and `WEBAIOS_TEST_AMO_CLES` (`issuer:secret`, absent = no keys) make the chrome install what the fake server returns as a temporary add-on; `WEBAIOS_TEST_WATCHDOG_MS` shortens the crash watchdog window. The one real test is `WEBAIOS_AMO=1 pnpm exec vitest run test/amo.test.ts` (keys in the keychain, network, one throwaway signature). `WEBAIOS_SPIKE=1` runs the probes of `e2e/extensions-spike.e2e.ts`.

The copy accepts only the rights an agent extension may use (`scripting`, `storage`, `unlimitedStorage`, `tabs`, `contextMenus`, `cookies`, `webNavigation`, `alarms`, `offscreen`, `clipboardRead`, `clipboardWrite`, `declarativeNetRequest*`), in `permissions` and `optional_permissions`; any other right (`activeTab` included; a host pattern in `permissions` too: stricter, so safe), or a manifest key that grants a power (`chrome_settings_overrides`, `protocol_handlers`, `user_scripts`, `experiment_apis`, `theme_experiment`, `omnibox`), is refused before any card with « Droit non pris en charge par WebAiOs : <name> ». Firefox-only APIs (`identity`, `dns`, `find`, `notifications`, …) are thus out of reach. `tabs.captureVisibleTab`, `tabs.captureTab`, `tabs.detectLanguage`, `tabs.saveAsPDF`, `tabs.print`, `tabs.printPreview` and `tabs.toggleReaderMode` are refused in the parent for every page of an agent extension (« <api> non pris en charge par WebAiOs »): Firefox grants activeTab to an MV3 extension on a click of its button, its menu item or its command even without the right. The copy's pages are sandboxed without `allow-popups` (`content_security_policy.extension_pages`): `document.open(url, "_blank")` and `<a target=_blank>` open nothing: an agent page opens no window.

Limits:

- An `about:blank` frame of an agent page inherits its principal, and Firefox would give it the whole extension API without the guard: the extension actor (registered without `matches`, so it reaches those frames) defines `__webaios` there and takes out `chrome`, `browser`, `window.open` and WebRTC, before the page's script reads the frame. A page of the extension loaded in a frame reuses that window: it keeps no extension API (its guard then does nothing; its scripts cannot call `chrome.*`). A `srcdoc` frame is cross-origin to the page and runs none of its scripts.
- Before the first host sent the grants, the actor's answers wait 5 s at most, then refuse; the request observer refuses at once (fail closed): a background fetch right after a restart can be cancelled until `extensions.portees` arrives.
- `action.setIcon` with an absolute address is accepted by Firefox; no load was seen headless (the strip does not render it yet). Recheck when the strip renders action icons.
- Per space, only the content scripts follow the switches of a space's settings: they run in a WebAiOs tab of a non-private space whose profile the extension is active in, and in that profile's container (never an invisible read, which has no tab id). Firefox runs one copy of each add-on for every profile, so its background, its `declarativeNetRequest` rules and `tabs` stay global: active in one space, its background sees the tabs (with the right) and its rules apply in every non-private space. Never a private space: its tabs are hidden from the agent's extensions (`tabManager.canAccessTab`), a profile turned private reloads at once, in the chrome (host or not), every tab of that profile an agent script was let into, even one of an extension switched off there since; the kernel then takes the profile out of every agent extension (`extensions.profilsPrives`) and disables it where it is active nowhere else. Disabling an add-on stops its scripts already injected.
- A tab the agent cannot read sends `extensions.aTourne` once per extension and profile: the registry masks its console there (`consoleMasquee`) and by add-on id (`consolesMasquees`, never emptied). A note sent while no host runs is sent again on the next check.
- Firefox specifics of the content guard (`webaios-garde-*.js`, from the kernel): a content script's `window` is the page's window through an Xray, so every member the guard sets on the content script's global (`open`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `FormData`, the `on…` key and input handlers) is set on that window too; the agent's files are injected one `executeScript` per file, because Firefox drops a whole call when one file fails to compile. A `url()` in an agent stylesheet loads with the extension's principal, so the request observer cancels it outside the grant. The conduit wrap that refuses the capture, print and PDF tab calls has no startup self-check: the same rerun after an upgrade covers it (it detects `detectLanguage`).
- The content guard is deterrence, not a guarantee (its header lists what stays open). Code in the page's world escapes it (an inline `<script>`, an `on…` attribute); on Firefox the same door is also `wrappedJSObject` and `XPCNativeWrapper.unwrap` (the page's own objects: password values, listeners, the page's `fetch` and `open`, whose loads carry the page's principal, so the request observer does not see them). An `about:blank` frame the content script creates has no guard either: its `fetch` and `open` go out (`open` can open a tab). The same holds for a same-origin frame the page already has, reached through `frames[i]` (its `FormData` reads passwords, its `fetch` and `XMLHttpRequest` go out).
- Crashes (3 in 60 s disable the extension everywhere, « Réactiver » on the Extensions page): Firefox names no extension that crashes (spike S7), so the chrome counts:
  - an uncaught error of its background window within 1 s of the background's start. The parent's console proves it uncaught but has no window; the console actor's relay has the window. The same file and text from both is one load error. An MV3 event page sends its start again on each wake, so an uncaught error in a listener in that first second counts too;
  - an extension process that crashes;
  - an extension process that stops answering the console actor's ping. The ping runs only while an agent background runs. The process is killed after two consecutive 10 s windows without an answer, measured on a monotonic clock; a window whose timer fires late, or a wake from sleep, starts the count again. The kill is skipped (logged) when Firefox is one crash away from its respawn limit (`extensions.webextensions.crash.threshold`).

  That process runs every add-on, Mozilla's included: its crash or kill stops them all, and counts one crash for each agent extension whose background was running, whichever caused it. A hung background is killed after at least 20 s, and it does not restart by itself, so three hangs in a minute need restarts in between. Crashes seen while no host runs are sent with the next `extensions.pret`, at their own time.
- Every grant and every reload goes over the network and waits for Mozilla (about 5 minutes); the code leaves the machine for Mozilla, under the AMO account whose keys are in the keychain.
- At startup, a source changed while the app was closed is signed again (within the scope already granted; a wider scope disables the extension and keeps the grant). That is the one upload not triggered by an agent call.
- A version number that goes down is accepted by AMO (measured) and installed over the newer one by Firefox (not tried).
- `importScripts` and `clients` do not exist in a translated background (it is a page, not a service worker); calling them throws in the agent's console.
- Mozilla's add-ons (AMO modules) are active in every space, private ones included, and are listed as store add-ons with no console.
- The e2e install temporary add-ons: `onInstalled` after a restart and the kept storage are checked only by the real test (`WEBAIOS_AMO=1`) and the manual checks.
- New French texts: « Installation impossible : <message> », « Droit non pris en charge par WebAiOs : <name> », « <api> non pris en charge par WebAiOs », « Espace disparu pendant la carte : rien n'est activé », « Paramètres invalides » (internal).
- The AMO linter's view of the CSP `sandbox` directive is unchecked (S1 signed a copy with it; the real test covers it).
- After a Firefox upgrade, rerun `e2e/agent-extensions-guards.e2e.ts`: the `runtime.setUninstallURL` guard redefines the `uninstallURL` field Firefox reads (`ext-browser.js`); if Firefox makes it private or renames it, the guard does nothing and only the `setUninstallURL` test notices (measured: with the hook inert, it fails).

## History and downloads

- The history is `historique.sqlite` in the data folder, kept by the kernel host with the `Historique` class of `core/history.ts`. The window talks to it through the `historique.*` messages.
- Firefox's own Places is turned off at runtime (`places.history.enabled=false` on the default branch, set when the store starts): it records no visit, so there is no `:visited` colour. Tab history, favicons and reopening closed tabs still work.
- Visits are noted by `chrome/window/visits.ts`; the page text the agent can search is retained through the actor's `getText` message (`body.innerText` only). Private spaces are replayed to the host on each host start.
- The download list is Firefox's (`Downloads.getList`), shown in the UI's downloads panel; it is kept for the session only.
- Native keys and commands that would open Firefox's own history, bookmarks or downloads UI are disabled (⌘Y, ⇧⌘H, ⇧⌘O, ⇧⌘⌫, `Browser:ShowAllHistory`, `Browser:ShowAllBookmarks`, `Tools:Downloads`, `Tools:Sanitize`).
- After a Firefox upgrade, rerun the probes: `WEBAIOS_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/history-spike.e2e.ts --silent=false`. Details: `docs/superpowers/notes/2026-11-04-historique-telechargements-essai.md`.

Limits:

- Firefox picks the free name of a repeated download: `file(1).txt`, with no space before the number.
- The retained text is the `meta` description then body; title, channel and description on a YouTube watch page, composition in `shared/page-text.ts`. The page actor must be rebuilt (`pnpm build:ui`): an older build silently retains the body text alone.
- A visit or text sent while the host is down is lost.
- The download list is not kept across a restart (the panel says « Aucun téléchargement pendant cette session. »).
- A download from a private space stays in the list.
- A file Firefox blocks shows « Interrompu », without « Garder quand même »; a blocked or cancelled download may leave its partial file in the folder.
- `/coupee` (truncated page) is not ported: Firefox may count a cut page as loaded.

## Site permissions

- Asked once per (origin, permission) and login profile: notifications, position, camera, microphone, plus DRM and MIDI. Screen sharing and links to another application are asked every time. Fullscreen and clipboard writes are granted without a question; everything else is refused without one (clipboard reads, `storage-access`, `xr`, persistent storage, local network, HID/serial/USB).
- The question is the WebAiOs banner over the page (`chrome/window/site-banner.ts`); the page moves down by its height (`--webaios-banner`). Firefox's own permission prompts never show.
- Decisions live in `permissions.json` (`permissions-<profile>.json` for the others), kept by `chrome/store/site-permissions.ts`, and are copied into Firefox's `Services.perms` with the profile's container (`permissions.isolateBy.userContext` is on), so `Notification.permission` and `permissions.query` answer right. At startup Firefox's stored site permissions are wiped and rebuilt from the files; a deleted profile takes its decisions.
- The hooks (`chrome/store/permission-hooks.ts`): `Integration.contentPermission` (position, notifications, DRM via `media.eme.require-app-approval`, MIDI), a wrap of `WebRTCParent.prototype.receiveMessage` (camera, micro, screen), of `nsContentDispatchChooser.prototype.handleURI` (external links) and `ClipboardContextMenu.confirmUserPaste` (clipboard reads). A page that navigates or closes during its question drops it (refused this time, asked again next time). Invisible reads are refused.
- Prefs set on the default branch at startup: `media.autoplay.default=0` (sounds play without a click), `privacy.popups.showBrowserMessage=false` (no popup-blocked bar), `full-screen-api.warning.timeout=0` (no fullscreen warning).
- « Navigation > Oublier les autorisations de ce site » in the menu bar forgets the active tab's origin in its space's profile.
- After a Firefox upgrade, rerun the probes: `WEBAIOS_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/permissions-spike.e2e.ts --silent=false`. Details: `docs/superpowers/notes/2026-11-05-permissions-sites-recherche.md`.

Limits:

- Screen sharing uses the macOS picker (no list in the banner, no tab sharing); without it (macOS < 14) screen sharing is refused.
- Widevine is downloaded by Firefox on first use (network); the banner comes after.
- Clipboard writes need a click (Firefox's rule).
- Firefox's site permissions stored before this block are lost (wiped at startup).
- Not checked headless: the real menu bar entry, the macOS screen picker, a real camera, Widevine, launching a real external application.

## Agent dev tools

The agent reads a tab's console and network, runs JS, reloads, profiles and compares memory (`lire_console`, `lire_reseau`, `executer_js`, `profiler_performances`, `instantane_memoire`, `comparer_memoire`). The agent asks first through a consent card.

- No debugging port. `chrome/store/devtools.ts` plugs a DevTools client into Firefox's DevTools server through an in-memory pipe, the way the toolbox does. `devtools.debugger.remote-enabled` stays true, but nothing listens.
- The user's DevTools toolbox works on the same tab at the same time. `DevToolsBusy` is never raised.
- A tab other than the agent's local demos (`localhost`/`127.0.0.1` on the demo and app ports) needs the consent card; a private-space tab is refused before any client exists.
- The raw profile is a converted `.cpuprofile`. The raw memory snapshot is census JSON (`format: "webaios-firefox-census"`).

Known limits:

- The memory census names classes, not constructors: a page's own class shows as `Object`.
- `executer_js` stops waiting after 10 s and drops the late result. An endless loop keeps running until Firefox's hang monitor stops it.
- Unhandled rejections from the agent's own code (source "debugger eval code") never reach `lire_console`.
- Firefox's profiler is shared by the whole browser. An agent profile is refused while another one runs, with « Le profileur de Firefox est déjà en cours (about:profiling ou un autre profil de l'agent) … » (it is not queued). A profile the user starts during an agent profile is stopped with it.
- A dev tool call cut by the agent's own `naviguer` to another site answers the generic cut text (`TEXT_CUT`), not « L'onglet a changé de site. »: the kernel cuts the right before the load commits. A page that leaves by itself still answers « L'onglet a changé de site. ».
- A page that does not answer within 10 s (an endless loop, a breakpoint): `instantane_memoire` fails with « La page ne répond pas. », `profiler_performances` answers without `Nodes` and `JSHeapUsedSize`.
- Whether CORS/CSP platform warnings reach `lire_console` was not probed.

## The home page

- The home page is the sidebar's no-tab screen (`ui/Home.svelte`, in `EmptyPage`; the address field, `Essentials` and the local-AI slot stay). A widget is a folder of the space, `espace/accueil/widgets/<id>/` (`widget.json`, `affichage.html`, `recolte.mjs` or `workflow.json`, `exemple.json`): the agent writes files, there is no API.
- Service: the kernel host answers `accueil.*` (`lire`, `placer`, `retirer`, `recolter`, `executions`, `execution`, `accorder`, `refuserAccord`) and sends `accueil.change` after every write (a widget or the theme written by the agent, an accord, a removal, a harvest); a successful placement writes `disposition.json`, which the `accueil/` watcher reports as `accueil.change`. The profiles offered by the accord card come from the renderer's state (`ui/home-profiles.ts`), not from the host. Widget data, states and accords live outside the space, in `<dataDir>/widgets`.
- Display: each widget with an `affichage.html` is served from `resource://webaios-widget-<id>/affichage-<mtime>.html`, in an iframe with `sandbox="allow-scripts"` (opaque origin). On every `accueil.lire`, the sidebar (`ui/api.ts`) reads `<dataDir>/espace/accueil/widgets/<id>/affichage.html` (the widget folder confined by `realpath`: a symlink leaving it is refused) and writes a sanitized copy to `<dataDir>/webaios-widgets/<id>/affichage-<mtime>.html` — regenerated only when the source's mtime changes, the `<mtime>` being what reloads the frame — then sets the `resource` substitution `webaios-widget-<id>` to that folder (`chrome/window/widget-frame.ts`) and rewrites the widget's `src`. The copy starts with `CSP_WIDGET` as an injected `<meta http-equiv>` (a `resource://` file cannot carry a response header) then the guard's `<script>`, after any doctype: no network, no form, no frame, inline scripts and styles only, Trusted Types; an `affichage` carrying a network hint (`<link>`, `<meta http-equiv>`, speculation rules) is replaced by `DISPLAY_DENIED` before any script. Removing a widget clears its substitution and copy folder. A custom `webaios-widget:` scheme was tried first and removed: measured in this Firefox, a frame never commits it (it stays `about:blank`, with no error) while `chrome://` and `resource://` frames load. Data arrives by `postMessage` (`donnees`, `taille`, `px`, `etat`); a widget link calls the page-world helper `window.webaiosOuvrir(url)`, installed by the guard, which dispatches `webaios-ouvrir` on the frame's window; the chrome UI (`WidgetFrame.svelte`) listens for it on `contentWindow` and calls `api.accueil.ouvrir`, only after a real click (`isTrusted`) and only for an `http(s)` URL outside the machine (`openableUrl`). Measured: a sandboxed `resource://` frame cannot post to its chrome parent (`parent.postMessage` throws `Permission denied`), and `event.source !== parent` inside the frame; the helper replaces a `parent.postMessage` link protocol. The three shipped model widgets are migrated at startup: a starter widget whose `affichage.html` sha256 matches a shipped pre-fix version (`packages/kernel/src/workspace/initialiser.ts`) receives the current one, while an `affichage.html` the user or the agent edited (unknown hash) is left alone. A widget of the user's own that still keeps `e.source === parent` renders nothing (the sandboxed frame sees no message), and one that still calls `parent.postMessage` for links opens no link, until it uses the Firefox forms above; the agent can fix it on request.
- Guard: the widget guard, inlined as a `<script>` at the head of the served copy (`chrome/window/widget-frame.ts`), so it runs in the page world before the widget's own scripts: no WebRTC, Trusted Types by default, `<link>`, `<meta http-equiv>`, XSLT and code-as-text refused. A `widget-actor` `JSWindowActor` was tried first and removed: measured, its child does not act on these `resource://` frames in this Firefox (the parent exists and the frame is in-process, but `RTCPeerConnection` stays). The UI attaches the gesture listener itself: a capture-phase `pointerdown` on the frame's `contentWindow` from the chrome sidebar (`WidgetFrame.svelte`), calling `api.accueil.geste`, and only when the guard installed (`RTCPeerConnection` gone and `trustedTypes` present) — if the guard threw, no click is recorded and no link opens. The WebRTC globals are shadowed with a non-configurable own `undefined` property, WebRTC last; deleting them did not work, measured: they live on `Window.prototype`, so the delete leaves the native function reachable, and the UI reads the page world through `wrappedJSObject` (an Xray would still show the native interface). The sidebar's own CSP carries `frame-src resource:` for the frame.
- Placement: free, in `espace/accueil/disposition.json` (`version: 3`): `x`/`l` in thousandths of the home width, `y`/`h` in pixels. Drag by the header, resize by the bottom-right handle; the widget cannot be dropped on another one and never moves it, but a drag may pass over a neighbour; the grid snaps (5 ‰ horizontally, 8 px vertically) with accent guides, holes are kept. A widget without a placement is put in the first free spot by the kernel on every read (`placeMissingFree`), so one the agent adds appears without a restart. A window resize stretches the thousandths and keeps the pixels.
- Theme: `espace/accueil/theme.json`, written by the agent with its file tools. `packages/kernel/src/home/theme.ts` validates it (colours `#rrggbb`, `rayon`/`espace` 0–24, `police` `system`, `serif` or `mono`) and the home root applies it as CSS variables. Absent or invalid: the app's theme, a console warning, the file left untouched; delete it to come back to the default.
- Harvests: the kernel's scheduler (minutes or fixed hours), the workshop container `webaios-atelier-firefox`, `recolte.mjs` or a workflow; « Mettre à jour maintenant » in the widget menu. Accords: a widget with `sources.compte` waits for the accord card, which names the domains read with the account and those contacted publicly and remembers the chosen login profile; the accord (domains and profile) is kept in `<dataDir>/widgets/accords.json`. Refusing erases the accord and what was read with the account and hides the banner for the session; removing a widget moves its folder to `espace/accueil/.corbeille` and erases its accord and its data.
- Notifications: a finished harvest of a widget with `recolte.notifier` shows a macOS alert through Firefox's alerts service (`Cc["@mozilla.org/alerts-service;1"]`, never the XUL fallback): title = widget name, text = number of new items, never their content. The e2e write one JSON line per notification to `WEBAIOS_TEST_NOTIFICATIONS` and show nothing.
- Host stopped: an action sent while the kernel host is stopped changes nothing; the card says « Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?) » after 6 s, and the page stays displayed.
- Builder: « Voir / modifier le workflow » opens the workflow builder on `webaios://workflow/<widget>`, in the sidebar frame (an action's « Voir le workflow » opens the same builder on its action, see « Actions »). On a widget's builder, its Agent tab, ⌘J and ✦ open the window's agent panel on the right (the same conversation) instead of hosting the terminal in the tab (`e2e/builder-agent.e2e.ts`). On an action's builder, ⌘J and ✦ open its Agent tab.
- Tests: `e2e/home.e2e.ts`, the watch and the notification click in `e2e/watch.e2e.ts`; the fake docker is `test/tools/docker` (the launcher puts it on `PATH`), so no test touches a real container.

Limits:

- One theme palette only (no light/dark variant), no free CSS; the sidebar, the agent and the panels keep the app's theme.
- A login profile that becomes private or is deleted does not re-ask at once: the accord is refused at the widget's next scheduled harvest (at the next read; no observer).
- `affichage.html` is written by the agent: the CSP and the guard are deterrence, not proof.
- One home page for every space: widgets, data and accords are not per space.
- `ia.*` blocks run entirely in Ollama: Gemma (`gemma4:e4b-mlx`) writes, and the decision model `pplx-decider-flash` replaces Kev (same `/v1/systemone` request and answers; compared on the owner's real widgets: 90–100 % same keep/drop decisions, score correlation ~0.9). Nothing is installed by WebAiOs-Firefox: run `ollama pull pplx-decider-flash` once; a missing model fails the block with `Kev a répondu 404`. `WEBAIOS_KEV_URL` still points the decisions at a Kev server instead (the e2e use it for their fake).

## Actions

- An action is a folder of the space, `espace/actions/<id>/` (`action.json`, `workflow.json`, its `.mjs`), and agent components live in `espace/composants/<nom>/`; runs, results, accords and `refus-lancement.json` live outside it, in `<dataDir>/actions/`.
- Launch: from the new tab and the ⌘T bar (suggestions, input asked as a second field), from the « Actions » page (`webaios://actions`), or by the agent. The tab shows the progress, then Gemma's page; previous results reopen without launching anything; two actions run at once, a third waits (« En attente : deux actions tournent déjà »). No action in a private space: the list is not even asked.
- Service: the kernel host (`host/actions.ts`, the disk half of the actions service) answers `actions.*` and sends `actions.change` and `actions.direct`. The chrome half (`ui/actions-api.ts`) checks the private space before each request and again after its answer, dispatches, limits links to one per second, filters the live feed and offers the accord profiles. `ouvrir` runs in this order, split in two calls: private check, the host reads the action without launching it, private check again, `dispatch` `openAction`, then only the launch.
- Host stopped: the action page keeps its last read (no « Action inconnue »), and reads everything again once on the first `acces` after the host comes back (« Réessayer »), without reopening the tab.
- Images: the host checks the conditions (no account, no accord, kept run, `https` address present as is in the results, neither local nor private); the chrome then loads the image through an anonymous channel (`LOAD_ANONYMOUS`: no cookie sent or stored, no referrer) in the internal `webaios-action-images` container, at most 3 checked redirects, `image/*` only, 5 MB at most, and gives it to the UI as `data:` (`ui/ActionImage.svelte`). Images load lazily (`IntersectionObserver`), once each; a decode error shows the neutral slot. The e2e set `WEBAIOS_TEST_ACTION_IMAGES=<origin>`: `https://<host><path>` is then asked from `<origin>/<host><path>`, a local server, and every redirect is refused; nothing leaves the machine.
- Components: a sanitized copy of `composant.html` in `<dataDir>/webaios-composants/<nom>/composant-<mtime>.html`, served by the `resource://webaios-composant-<nom>/` substitution (no content access) in a `sandbox="allow-scripts"` frame, with `CSP_WIDGET`, the widget guard and `COMPONENT_BRIDGE` first (`ui/ActionComponentFrame.svelte`). The bridge turns `parent.postMessage` into a `webaios-composant` event; only a `{type:"hauteur", px}` from this frame, showing the current copy, counts (clamped to 20–2000). The substitution and copies go when the last page showing the component closes; the folder is emptied at store start. `Components` is hidden in component frames only: it is Firefox's leftover web object (interfaces only), harmless, hidden so component pages never see it. A component cannot navigate to another `resource:` page, and a self-navigation to http reaches nothing.
- Builder: the action part of the builder is in `host/workflow.ts`; saves go through the `action:<id>` write queue.
- Tests: `e2e/actions-*.e2e.ts`, `e2e/builder-actions.e2e.ts`, the actions part of `e2e/command-bar.e2e.ts`; the probes `WEBAIOS_SPIKE=1 … e2e/actions-spike.e2e.ts`. Mechanisms, limits and manual checks: `docs/superpowers/notes/2026-11-06-actions-firefox-spike.md` (« Plan 33 »).

Limits:

- A running action takes over the widgets' AI; no « Mise en page… » in the builder; with the workshop stopped the page says « atelier arrêté »; DNS rebinding is not handled for images; the layout uses Gemma in Ollama, the fallback layout without it.
- The action builder reads and writes even with the kernel stopped (as widgets do in this host).
- A widget display that compares `e.source` to `parent` receives nothing (see « The home page »).

## Site apps

- An app is a folder of the space, `<dataDir>/espace/sites/<id>/` (`site.json`, `accueil/`, written by the agent). What WebAiOs keeps lives outside it, in `<dataDir>/sites/<id>/` (`memoire.json`, `adresse.json`) and in `sites.json` (window frame, favicon). « Supprimer » moves the folder to `espace/sites/.corbeille/<id>-<time>` and wipes the session and the memory.
- Each app runs in its own internal container (`webaios-site-<id>`: cookies, localStorage, IndexedDB), in its own window (`chrome/store/sites.ts`, `ui/SiteWindow.svelte`): one `<browser>`, never a main window, never listed by ⌃Tab. A request guard (`http-on-modify-request`) keeps it on the app's domains and sign-in domains before anything leaves; the home screen is served from `resource://` in a sandboxed frame of the bar.
- The page's code runs in the `WebAiOsSite` actor (`site-actor.sys.mjs`), one `Cu.Sandbox` per document. It is read through the symlinks of `build:ui`: after a change to the actor, ask for `build:ui` (the e2e use `testActor`, the packaged one with `WEBAIOS_E2E_PACKAGED_ACTOR=1`).
- The Applications page's « Sites » section (`webaios://applications`): the host (`host/sites.ts`) answers `sites.liste` and `sites.agir`, and sends `sites.change`. « Afficher le dossier » and « Relire » are the UI's (`ui/api.ts`). The command bar lists the apps; the agent has `lister_sites`, `ouvrir_site` and `memoire_site`.
- What the agent adds (plan 32):
  - **retouches** (`retouches/*.css`, `*.js`, `webaiosSite`): the actor's child asks its parent what goes into each frame (`sendQuery`); the parent decides from its own `WindowGlobalParent` (`chrome/store/site-frames.ts`, `injectionFor`), never from what the frame says, and only for the app's view (never the sign-in window or a tab). Memory goes to the host (`host/site-memory.ts`); the retouches' console is relayed per frame;
  - the **accord card**: the view stays `about:blank` until the choice; rights that grow bring it back;
  - **video resume** (`ResumeTracking` of `core/resume.ts` in the actor, positions kept by the host) and the **address follow** (`UrlTracking` of `core/sites/tracking.ts`);
  - the **agent's tools** on `site:<id>` (`lister_onglets`, `lire_onglet`, `capture_ecran`, `naviguer`, dev tools) behind the app's « donnees-widget » card;
  - **add-on buttons** in the app bar (`createSiteAddons`, `ui/SiteAddonsStrip.svelte`); the view is protected from add-ons (no remove, move, adopt, `windows.remove`, non-http loads; the request guard's net).
- The end-to-end scenario with AGENTS.md's examples: `e2e/sites-scenario.e2e.ts`. The manual checks of plan 32 are in `docs/superpowers/notes/2026-11-06-applis-de-site-firefox-spike.md` (« Plan 32 »).
- The probes: `WEBAIOS_SPIKE=1 corepack pnpm --filter firefox-webaios exec vitest run -c vitest.e2e.config.ts e2e/sites-spike.e2e.ts`, to run again after each Firefox update (measures the window, the routing, the sandbox and the home).

Limits:

- The apps' modules are global (§4.9 of the spec): one list for every app, not per app.
- No « Gérer » add-on menu in the app bar, and no title-bar drag region: Firefox keeps its native title bar.
- `about:srcdoc` and `about:blank` frames get video resume when the top page is on the app's domains; nothing else goes there.
- The « donnees-widget » card now covers widgets, actions and site apps; before plan 32, widget data read with an account was always refused.
- The request guard's net is always on, so the page's own navigations under the home or the card are dropped. `tabs.create` from an add-on opens in the main window.
- « Supprimer » withdraws the agent's accord on the app: an app made again under the same id asks again.
- The headless e2e decode no media: the 10 s `timeupdate` step and a real `ended` are covered by unit tests only. The packaged actor is checked with `WEBAIOS_E2E_PACKAGED_ACTOR=1` after each `build:ui`.
- A sign-in window opened by `window.open(url)` without features has no `opener` (a login waiting for `opener.postMessage` fails). A window opened with features towards a refused domain shows for an instant, then closes; nothing leaves. A TCP preconnect (no HTTP request) is not seen by the guard.
- Firefox does not resolve `*.localhost`: the e2e add a DNS override (`resolveLocalHosts`). Visits of an app window are not recorded (`places.history.enabled` is false).

## Agent applications

- An app the agent writes is a folder `<dataDir>/espace/projets/<folder>/` with a `webaios.json` manifest, run by the kernel in Docker (`host/applications.ts`, the kernel's `ApplicationManager`). Its window is `chrome/store/apps.ts` + `chrome/window/app-window.ts`: one `<browser>` on the app's port, no bar, never a main window.
- Each app has its own internal container (`webaios-app-<folder>`) and a request guard that keeps it on its origin: other sites open in a tab of the main window; `file:`, `data:` and `blob:` are refused (also as http redirects); permissions are denied per origin and container; the view is protected from add-ons. Closing the window stops the app; so does the host stopping (the window closes). At quit the apps stop first, then the sessions.
- The Applications page's Docker section (`ui/api.ts`): launch, stop, delete, « Passer en application », debug (the terminal is filled, not sent), « Afficher le dossier » (`reveal`, never `launch`), « Relire ». ⇧⌘A opens the page; Firefox's own ⇧⌘A (about:addons) is disabled.
- The badge (top right of the window, `ui/badge-api.ts`) shows the agent's access to the app and lets one cut it or open the Review page; the page cannot reach it. « Mode design » and the basket in its menu drive the design mode of the app (see « Design mode »).
- The Review page covers these apps: the first snapshot is taken at start (apps without a manifest are skipped).
- The design viewfinder runs in the `WebAiOsDesign` actor (`chrome/agent/design-actor.ts`, every frame, http/https). It is the one packaged file of this plan: after a change to it, ask for `build:ui` (the e2e use `testActor`, the packaged one with `WEBAIOS_E2E_PACKAGED_ACTOR=1`). Its guard sits on the `chromeEventHandler`; a cross-origin frame in another process is guarded by its own actor.
- Copies with drift tests: `validFolder` (`chrome/store/app-folder.ts`, `test/containers.test.ts`), the home's `MOUSE` (`chrome/store/design-home.ts`, `test/design-copies.test.ts`).
- Tests: `e2e/apps-window.e2e.ts`, `apps-page`, `apps-actions`, `apps-badge`, `design-actor`. The test ports (with their gaps), the limits and the manual checks are in `docs/superpowers/notes/2026-11-06-mode-design-firefox.md` (« Plan 35a »).

Limits:

- Firefox add-ons run in app windows (shared by every container, spec §13.8); there is no add-on bar there.
- Apps without a manifest (`sans-fiche`) are not snapshotted for review.
- Downloads from an app container are not cancelled, and cross-origin frames load inside the app (both by design).
- A cached 301/308 to `file:` leaves the view on `about:blank`.
- Headless cannot route a real click into an out-of-process frame: the viewfinder's cross-origin case is tested through WebDriver actions, and a headed check is pending.

## Design mode

- The ✎ button of the toolbar and ⇧⌘D (Firefox's own bookmark-all-tabs shortcut is disabled) start the viewfinder on the selected tab of a main window, or on an agent app window. Only a tab on a followed project (an agent demo, an agent app, a project connected by a Claude Code) is armed; elsewhere a message shows for 4 s and nothing is injected. 
- The chrome service (`chrome/store/design.ts`) arms only the `WebAiOsDesign` actor of the target's current `WindowGlobal`, once at a time. Every process-root frame under it is guarded too, including frames added while aiming (`window-global-created`). A reload, another document, another tab, a crash or the window closing ends the mode; the cart stays. A stop that hangs is cut after 1 s.
- A click captures the element: `drawSnapshot` of `rectCapture`, cropped on a canvas (PNG of the rectangle's size at any zoom or density). The bubble, the message and the app window's cart are in a transparent chrome frame (`sidebar.html?calque`) placed over the page; the main window's cart is a 300 px column (frame `#webaios-design-volet`) that narrows the page through `--webaios-panier`. The bubble takes the keyboard (⌘Enter adds, Escape cancels) and gives it back to the page. An overlay never names its target: the chrome binds it.
- The host (`host/design.ts`: `design.suivi`, `.ajouter`, `.panier`, `.lots`, `.retirer`, `.traite`, `.envoyer`) re-checks every context and capture (PNG, 8 MiB at most). « Envoyer » fills the agent's terminal (no Enter) or, for an external project, queues the batch for Claude Code. With the host down the cart keeps its last read and the call's error shows.
- Agent app windows: the badge's « Mode design », « Panier » and « Relire ce projet » act on the window's own app; ⇧⌘D inside toggles its own mode.
- Copies with drift tests: `shared/design-guards.ts` (`test/review-host.test.ts`), `chrome/shims/kernel.ts` (`test/shims.test.ts`).
- Site app windows (plan 36): the ✎ button of the app bar (with its chevron: « Panier », « Relire ce projet ») and ⇧⌘D toggle the mode of that app; the target comes from the window, never from the page. The viewfinder is the packaged `WebAiOsDesign` actor in its own sandbox next to the retouches' (no `build:ui`), without the source read; the bubble warns that a third-party page is captured. The app's home is a `resource://` frame of the bar in the parent process: the chrome aims it without an actor (`chrome/store/design-home.ts`, a Xray sandbox per document, armed only on the served home), and its remarks are tagged `[accueil]`. Unavailable on the accord card, the login page, in fullscreen (a 5 s `info` notice in the bar). ⌂, « Entrer dans le site », fullscreen, another document (a retouche reloads the view) or the window closing end the mode; the cart stays. In the small sign-in window ⇧⌘D toggles nothing and shows the notice. With the host down ✎ keeps its last state. The home's `source` read runs synchronously in the parent process: a home that loops in `closest` freezes the browser.
- Tests: `e2e/design-service.e2e.ts`, `design-overlay`, `design-button`, `design-send`, `design-apps` (ports 15300-15324), `design-sites-view`, `-bar`, `-home`, `-send` (15345-15364, helpers in `design-sites.ts`); the actor ones also run packaged with `WEBAIOS_E2E_PACKAGED_ACTOR=1` (`design-actor`, `design-service`). The test ports (with their gaps), the limits and the manual checks are in `docs/superpowers/notes/2026-11-06-mode-design-firefox.md` (« Plan 35b » and « Plan 36 »).

Limits:

- A page CSS can hide the viewfinder, a batch stays « read » until marked done, a retouch that reloads the page ends the mode.
- Add-on frames (`moz-extension:`) are not guarded; a frame added during aiming is guarded only once its actor answers (a few ms); Escape inside a cross-origin frame that has the keyboard does not stop the viewfinder.

## External MCP and Review

The host runs the external MCP server (port 5279, `WEBAIOS_PORT_MCP_EXTERNE` changes it, `0` in the tests) without the kernel: `host/design.ts` creates the remarks, the registries of external clients and projects, and the review service. It listens on 127.0.0.1 only, checks Host and Origin, keeps only the SHA-256 of each token, and never falls back to another port (« Le port 5279 est pris »). It stops with the host; « Réessayer » restarts it on the same port with the same tokens.

- The « Projets externes » section of the Applications page connects a Claude Code (the command with the token shows once), declares projects, revokes a client, forgets a project. A project folder under the data folder is refused (`SPACE_FOLDER`). Registries, private repositories (`design/relecture/`) and batches (`design/remarques/`) live under `<dataDir>/design`, never in the space.
- The Review page (`webaios://relecture`) shows the diff of an external project or of a site app since the last « Marquer comme relu ». Comments go to Claude Code (`lire_remarques`, `attendre_remarques`) or, for a site app, into the agent panel: the text waits there and Enter sends it (`design.fenetreAgent`, `design.donnerAgent`).
- `host/review.ts` (the review service) and `shared/design-guards.ts` (the input checks) are tested by `test/review-host.test.ts`. `core/design/external.ts` and `send.ts` are imported as is.
- Tests: `e2e/external-mcp.e2e.ts`, `e2e/review.e2e.ts`, `e2e/review-comments.e2e.ts`. The manual checks and the test ports (with their gaps) are in `docs/superpowers/notes/2026-11-06-mode-design-firefox.md` (« Plan 34 »).

## The UI's network

The UI (sidebar, agent panel, site bars, badges, overlays, widgets, components, site homes) reaches no web server. Tabs, reads, site apps and agent apps keep their network. Five pieces:

- **Predicate** (`chrome/store/ui-network.ts`): a document is the UI's by its own address or an in-process ancestor's (past 32 ancestors it counts as the UI's). Tabs and `browser.xhtml` are not. A frame's navigation is judged by its target context, the frame (its `APP_TYPE_MAIL` mark or its UI parent document), not by `browsingContext`, which is the parent's. A dedicated worker's load falls back to its associated context. A load with no document and no context (WebTransport; a worker's fetch in the parent process) is judged by its principal: a UI address, or system for WebTransport.
- **Content policy**: refuses http, https, ws and wss from opaque UI documents, whatever the host. System documents skip content policies.
- **Observer** (`http-on-opening-request`): cancels the same loads. It is the only layer for system documents.
- **Frame flags** (`cutFrameNetwork` in `chrome/window/frame-network.ts`): `allowDNSPrefetch = false` and `APP_TYPE_MAIL` on each UI frame, which cuts DNS prefetch and link hints.
- **Press guard**: a capture `mousedown` on `windowRoot` is consumed on a link (`:any-link`) in any UI document, system ones included, so no speculative connect starts. The walk follows slots and shadow hosts and fails closed past 1024 steps. The click still works. History links no longer take focus, selection or drag on press.

WebRTC is refused by a `PeerConnection:request` observer for UI documents.

Rule: every new UI frame calls `cutFrameNetwork(frame)` after it is inserted and before its `src` is set. If the observer failed to install, no UI frame gets its `src`.

Test hook: `WEBAIOS_TEST_UI_NETWORK_FAIL=policy|observer|webrtc` forces an install failure.

Limits:
- `moz-remote-image:` wrapping an http URL, and any script, in a system document are not covered (only our code runs there).
- WebRTC from system documents is not refused.
- A system document's worker or WebTransport without a context is not refused (only our code runs there). The widget guard removes `WebTransport`.
- `media.navigator.permission.disabled = true` lifts the WebRTC refusal for opaque documents.
- A widget link press loses focus. A plain `<a href>` in a widget no longer navigates its frame.
- Favicons are fetched by the tab, with its container's cookies, never by the UI.

Tests: `test/ui-network.test.ts`, `e2e/ui-network.e2e.ts`, `e2e/ui-network-fail.e2e.ts` (helpers in `e2e/ui-network.ts`). Notes and manual checks: `docs/superpowers/notes/2026-11-08-reseau-interfaces-spikes.md` (« Construction (plan 37) »).

## Not migrated yet (step 4)

- site-app permission checks;
- the host does not restart on its own after a crash: « Réessayer » in the panel relaunches it;
- design mode;
- internal `webaios:` pages: a "not available yet" message;
- tab previews in ⌃Tab: the cards show the icon;
- zoom is not tracked in the state;

## The window

No title bar (`browser.tabs.inTitlebar`, in `webaios.js`: needs `pnpm build:ui`). macOS places its window buttons on the box `#webaios-window-buttons` and hides them when there is none, as in compact mode (the theme geometry of `-moz-window-button-box`). The sidebar drags the window through `-moz-window-dragging`, which only counts in a nested document whose docShell has `windowDraggingAllowed`.

## Worktrees

`engine/` is shared by all checkouts (it links to `~/WebAiOs-firefox/engine`), and the import links `src/` files of the checkout that ran it. Run `pnpm engine:import` in the checkout you build. Links left behind by a deleted worktree are dangling: `engine:import` prunes them first (`scripts/engine.sh prune`), otherwise surfer fails with ENOENT.

## Measured times (M5 Pro, 2026-11-03, Firefox 159 + Zen patches)

Full build 20–23 min; `build:ui` after a UI change 17 s; adding the sidebar files (`jar.mn` + `browser.xhtml` patches) 21 s; one C++ or Objective-C++ file 23–25 s; build with no change 21 s.

## Pitfalls

- The macOS 27 SDK breaks Mozilla's linker (unknown `arm64e.x1`): SDK 26.5 is forced (`configs/macos/mozconfig`, `scripts/env.sh`).
- A truncated Firefox archive stays cached in `.surfer/engine/` after an interrupted download: delete it.
- surfer declares a git fork of `is-apple-silicon`, which pnpm rejects: replaced by the registry version (`pnpm-workspace.yaml`).
- The icons in `configs/branding/webaios/` are placeholders.
