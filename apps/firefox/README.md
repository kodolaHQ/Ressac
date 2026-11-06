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

The noyau (`@webaios/noyau`) runs in a separate Node process, `noyau/host.ts`, started by Firefox and spoken to in JSON-RPC over stdio (one message per line). Its console output goes to Firefox's console prefixed `[noyau]`; stdout carries only the protocol. The Node and tsx paths are frozen at build time (`scripts/paths.ts`): a dev build only runs on the machine that built it.

The agent's workshop container is `webaios-atelier-firefox` (`WEBAIOS_CONTENEUR`), so it never touches the Electron app's `webaios-atelier`. It publishes ports 5300-5319 (`WEBAIOS_PORTS_CONTENEUR`), since the Electron app's container holds 5280-5299. Both share the `webaios-home` volume.

Invisible reads run in a windowless browser, in a private container cleared before and after each read. Every request from a reading container is checked: an address that is local, or a name that resolves to one (or fails to resolve), is refused. Known limits, marked `shortcut:` in `chrome/agent/local-guard.ts` and `invisible.ts`: custom-scheme navigations, preconnects, Alt-Svc, WebRTC, and service workers in a login profile's container. Paced reads (the workflows' `web` widgets) wait for another site's turn before following a navigation to it: the read stops at that site's document, gives its place back, waits, then resumes (`chrome/agent/invisible.ts`, `noyau/remote-bridge.ts`).

## Work loop

- Changed `ui/` or `chrome/` (files already declared in `jar.inc.mn`): `pnpm ui`, then restart the app with `-purgecaches` (otherwise an existing profile keeps running the old scripts from its startup cache). No `mach`, no build: the app reads our files through symlinks.
- Changed a `src/**` `.js`/`.css`/`.html` file: `pnpm build:ui` (~17 s: Vite, then `mach build faster`).
- Added a file to `src/`: `pnpm engine:import` (builds the UI first, so the generated sidebar files get linked), then `pnpm build:ui`.
- Changed a `*.patch`, or anything compiled (C++, Rust, `jar.mn`): `pnpm engine:import`, then `pnpm build`.
- Tests: `pnpm test` (unit), `pnpm e2e` (headless Firefox with a temporary profile, driven over Marionette).
- Bench against the Electron app: `pnpm bench -- --out <file>.json` (invisible reads), `pnpm bench -- --headed --out <file>.json` (tab and space switches; opens windows and takes the focus). It runs Electron, Firefox, Electron, Firefox, Electron, Firefox, never together, and compares the medians. The bench tests are skipped unless `WEBAIOS_BENCH` is set.

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

Each is copied, signed by AMO (unlisted) and installed as an add-on (`<folder>@agent.webaios`); the noyau host keeps the registry and sends the grants to the chrome (`extensions.portees`). The guards of the copy (`webaios-garde-*.js`) ask the chrome through the extension actor (`window.__webaios`, defined on the agent's extension pages before their first script); the chrome also refuses every http request an agent extension loads or starts outside its grant, whatever its type (an `http-on-modify-request` observer on the loading or triggering principal, so a notification icon too), the `window.open` of its pages, and a `runtime.setUninstallURL` outside its grant.

Setup and files:

- Signing: AMO, unlisted channel. The keys sit in the macOS keychain, read by the noyau host at each upload and never written anywhere: `security add-generic-password -s webaios-amo -a <JWT issuer> -w` (the password is the JWT secret). Without them a grant answers « Clés AMO absentes » and nothing leaves the machine.
- Files in `<dataDir>/extensions`: `etat.json` (registry: grants, scopes, state), `copies/<folder>@agent.webaios/` (the modified copy), `signes/` (the signed `.xpi` kept, reinstalled at startup if missing), `amo-versions.json` (the counter per id; never lowered nor cleared, not even by « Supprimer », because AMO never reuses a number).
- Id `<folder>@agent.webaios`; version `<a>.<b>.<c>.<n>` (the agent's version completed with zeros to three numbers, then the counter; four numbers are refused).
- Signing takes 154 to 298 s (median 284 s, spike S1, `docs/superpowers/notes/2026-11-04-extensions-agent-essai.md`); the timeout is `DELAI_SIGNATURE_MS` = 900 000 ms.
- The actor `extension-actor.sys.mjs` is a packaged file (jar line): run `pnpm build:ui` after pulling it. The e2e load it instead through a `resource://` substitution (`WEBAIOS_TEST_EXTENSION_ACTOR=<src/browser/base/content/webaios>` plus the `security.sandbox.content.mac.testing_read_path1` pref); after a `build:ui`, rerun the `agent-extensions-*.e2e.ts` files once without that variable.
- Messages between the window and the host: `extensions.*` (`liste`, `portees`, `accord`, `installer`, `basculer`, `supprimer`, `console`, `plantage`, `amo`, …).
- Tests: the e2e never reach the network. `WEBAIOS_TEST_AMO_URL` (API base of `test/fake-amo.ts`) and `WEBAIOS_TEST_AMO_CLES` (`issuer:secret`, absent = no keys) make the chrome install what the fake server returns as a temporary add-on; `WEBAIOS_TEST_WATCHDOG_MS` shortens the crash watchdog window. The one real test is `WEBAIOS_AMO=1 pnpm exec vitest run test/amo.test.ts` (keys in the keychain, network, one throwaway signature). `WEBAIOS_SPIKE=1` runs the probes of `e2e/extensions-spike.e2e.ts`.

The copy accepts only the rights Electron's agent extensions can use (`scripting`, `storage`, `unlimitedStorage`, `tabs`, `contextMenus`, `cookies`, `webNavigation`, `alarms`, `offscreen`, `clipboardRead`, `clipboardWrite`, `declarativeNetRequest*`), in `permissions` and `optional_permissions`; any other right (`activeTab` included, unsupported in Electron too; a host pattern in `permissions` too, which Electron reads as a host: stricter, so safe), or a manifest key that grants a power (`chrome_settings_overrides`, `protocol_handlers`, `user_scripts`, `experiment_apis`, `theme_experiment`, `omnibox`), is refused before any card with « Droit non pris en charge par WebAiOs : <name> ». Firefox-only APIs (`identity`, `dns`, `find`, `notifications`, …) are thus out of reach. `tabs.captureVisibleTab`, `tabs.captureTab`, `tabs.detectLanguage`, `tabs.saveAsPDF`, `tabs.print`, `tabs.printPreview` and `tabs.toggleReaderMode`, which Electron has not, are refused in the parent for every page of an agent extension (« <api> non pris en charge par WebAiOs »): Firefox grants activeTab to an MV3 extension on a click of its button, its menu item or its command even without the right. The copy's pages are sandboxed without `allow-popups` (`content_security_policy.extension_pages`): `document.open(url, "_blank")` and `<a target=_blank>` open nothing, as Electron refuses every window.

Limits:

- An `about:blank` frame of an agent page inherits its principal, and Firefox would give it the whole extension API without the guard: the extension actor (registered without `matches`, so it reaches those frames) defines `__webaios` there and takes out `chrome`, `browser`, `window.open` and WebRTC, before the page's script reads the frame. A page of the extension loaded in a frame reuses that window: it keeps no extension API (its guard then does nothing; its scripts cannot call `chrome.*`). A `srcdoc` frame is cross-origin to the page and runs none of its scripts.
- Before the first host sent the grants, the actor's answers wait 5 s at most, then refuse; the request observer refuses at once (fail closed): a background fetch right after a restart can be cancelled until `extensions.portees` arrives.
- `action.setIcon` with an absolute address is accepted by Firefox; no load was seen headless (the strip does not render it yet). Recheck when the strip renders action icons.
- Per space, only the content scripts follow the switches of a space's settings: they run in a WebAiOs tab of a non-private space whose profile the extension is active in, and in that profile's container (never an invisible read, which has no tab id). Firefox runs one copy of each add-on for every profile, so its background, its `declarativeNetRequest` rules and `tabs` stay global: active in one space, its background sees the tabs (with the right) and its rules apply in every non-private space. Never a private space: its tabs are hidden from the agent's extensions (`tabManager.canAccessTab`), a profile turned private reloads at once, in the chrome (host or not), every tab of that profile an agent script was let into, even one of an extension switched off there since; the noyau then takes the profile out of every agent extension (`extensions.profilsPrives`) and disables it where it is active nowhere else. Disabling an add-on stops its scripts already injected in Firefox (Electron keeps them until a reload).
- A tab the agent cannot read sends `extensions.aTourne` once per extension and profile: the registry masks its console there (`consoleMasquee`) and by add-on id (`consolesMasquees`, never emptied). A note sent while no host runs is sent again on the next check.
- Firefox specifics of the content guard (`webaios-garde-*.js`, shared with Electron): a content script's `window` is the page's window through an Xray, so every member the guard sets on the content script's global (`open`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `FormData`, the `on…` key and input handlers) is set on that window too; the agent's files are injected one `executeScript` per file, because Firefox drops a whole call when one file fails to compile. A `url()` in an agent stylesheet loads with the extension's principal, so the request observer cancels it outside the grant (Electron loads it). The conduit wrap that refuses the capture, print and PDF tab calls has no startup self-check: the same rerun after an upgrade covers it (it detects `detectLanguage`).
- The content guard is deterrence, not a guarantee (its header lists what stays open). Code in the page's world escapes it, as in Electron (an inline `<script>`, an `on…` attribute); on Firefox the same door is also `wrappedJSObject` and `XPCNativeWrapper.unwrap` (the page's own objects: password values, listeners, the page's `fetch` and `open`, whose loads carry the page's principal, so the request observer does not see them). An `about:blank` frame the content script creates has no guard either: its `fetch` and `open` go out (`open` can open a tab). The same holds for a same-origin frame the page already has, reached through `frames[i]` (its `FormData` reads passwords, its `fetch` and `XMLHttpRequest` go out).
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

- The history is `historique.sqlite` in the data folder, kept by the noyau host with Electron's `Historique` class (the later import is a file copy). The window talks to it through the `historique.*` messages.
- Firefox's own Places is turned off at runtime (`places.history.enabled=false` on the default branch, set when the store starts): it records no visit, so there is no `:visited` colour. Tab history, favicons and reopening closed tabs still work.
- Visits are noted by `chrome/window/visits.ts`; the page text the agent can search is retained through the actor's `getText` message (`body.innerText` only). Private spaces are replayed to the host on each host start.
- The download list is Firefox's (`Downloads.getList`), shown in the reused Electron panel; it is kept for the session only.
- Native keys and commands that would open Firefox's own history, bookmarks or downloads UI are disabled (⌘Y, ⇧⌘H, ⇧⌘O, ⇧⌘⌫, `Browser:ShowAllHistory`, `Browser:ShowAllBookmarks`, `Tools:Downloads`, `Tools:Sanitize`).
- After a Firefox upgrade, rerun the probes: `WEBAIOS_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/history-spike.e2e.ts --silent=false`. Details: `docs/superpowers/notes/2026-11-04-historique-telechargements-essai.md`.

Limits:

- Firefox picks the free name of a repeated download: `file(1).txt`, without Electron's space.
- The retained text matches Electron's (`meta` description then body; title, channel and description on a YouTube watch page, composition in `shared/page-text.ts`). The page actor must be rebuilt (`pnpm build:ui`): an older build silently retains the body text alone.
- A visit or text sent while the host is down is lost.
- The download list is not kept across a restart (the panel says « Aucun téléchargement pendant cette session. »).
- A download from a private space stays in the list.
- A file Firefox blocks shows « Interrompu », without « Garder quand même »; a blocked or cancelled download may leave its partial file in the folder.
- `/coupee` (truncated page) is not ported: Firefox may count a cut page as loaded.

## Site permissions

- Asked once per (origin, permission) and login profile, as in Electron: notifications, position, camera, microphone, plus DRM and MIDI. Screen sharing and links to another application are asked every time. Fullscreen and clipboard writes are granted without a question; everything else is refused without one (clipboard reads, `storage-access`, `xr`, persistent storage, local network, HID/serial/USB).
- The question is the WebAiOs banner over the page (`chrome/window/site-banner.ts`); the page moves down by its height (`--webaios-banner`). Firefox's own permission prompts never show.
- Decisions live in Electron's `permissions.json` (`permissions-<profile>.json` for the others), kept by `chrome/store/site-permissions.ts`, and are copied into Firefox's `Services.perms` with the profile's container (`permissions.isolateBy.userContext` is on), so `Notification.permission` and `permissions.query` answer right. At startup Firefox's stored site permissions are wiped and rebuilt from the files; a deleted profile takes its decisions.
- The hooks (`chrome/store/permission-hooks.ts`): `Integration.contentPermission` (position, notifications, DRM via `media.eme.require-app-approval`, MIDI), a wrap of `WebRTCParent.prototype.receiveMessage` (camera, micro, screen), of `nsContentDispatchChooser.prototype.handleURI` (external links) and `ClipboardContextMenu.confirmUserPaste` (clipboard reads). A page that navigates or closes during its question drops it (refused this time, asked again next time). Invisible reads are refused.
- Prefs set on the default branch at startup: `media.autoplay.default=0` (sounds play without a click), `privacy.popups.showBrowserMessage=false` (no popup-blocked bar), `full-screen-api.warning.timeout=0` (no fullscreen warning, as in Electron).
- « Navigation > Oublier les autorisations de ce site » in the menu bar forgets the active tab's origin in its space's profile.
- After a Firefox upgrade, rerun the probes: `WEBAIOS_SPIKE=1 pnpm exec vitest run -c vitest.e2e.config.ts e2e/permissions-spike.e2e.ts --silent=false`. Details: `docs/superpowers/notes/2026-11-05-permissions-sites-recherche.md`.

Limits:

- Screen sharing uses the macOS picker (no list in the banner, no tab sharing); without it (macOS < 14) screen sharing is refused.
- Widevine is downloaded by Firefox on first use (network); the banner comes after.
- Clipboard writes need a click (Firefox's rule); Electron allowed them without one.
- Firefox's site permissions stored before this block are lost (wiped at startup).
- Not checked headless: the real menu bar entry, the macOS screen picker, a real camera, Widevine, launching a real external application.

## Agent dev tools

The agent reads a tab's console and network, runs JS, reloads, profiles and compares memory (`lire_console`, `lire_reseau`, `executer_js`, `profiler_performances`, `instantane_memoire`, `comparer_memoire`). Same tools, texts and consent card as the Electron app.

- No debugging port. `chrome/store/devtools.ts` plugs a DevTools client into Firefox's DevTools server through an in-memory pipe, the way the toolbox does. `devtools.debugger.remote-enabled` stays true, but nothing listens.
- The user's DevTools toolbox works on the same tab at the same time. `OutilsDevOccupes` is never raised.
- A tab other than the agent's local demos (`localhost`/`127.0.0.1` on the demo and app ports) needs the consent card; a private-space tab is refused before any client exists.
- The raw profile is a converted `.cpuprofile`. The raw memory snapshot is census JSON (`format: "webaios-firefox-census"`).

Known limits:

- The memory census names classes, not constructors: a page's own class shows as `Object`.
- `executer_js` stops waiting after 10 s and drops the late result. An endless loop keeps running until Firefox's hang monitor stops it.
- Unhandled rejections from the agent's own code (source "debugger eval code") never reach `lire_console`.
- Firefox's profiler is shared by the whole browser. An agent profile is refused while another one runs, with « Le profileur de Firefox est déjà en cours (about:profiling ou un autre profil de l'agent) … » (Electron queued the second request). A profile the user starts during an agent profile is stopped with it.
- A dev tool call cut by the agent's own `naviguer` to another site answers the generic cut text (`TEXTE_COUPE`), not « L'onglet a changé de site. »: the noyau cuts the right before the load commits. A page that leaves by itself still answers « L'onglet a changé de site. ».
- A page that does not answer within 10 s (an endless loop, a breakpoint): `instantane_memoire` fails with « La page ne répond pas. », `profiler_performances` answers without `Nodes` and `JSHeapUsedSize`.
- Whether CORS/CSP platform warnings reach `lire_console` was not probed.

## The home page

- The home page is the sidebar's no-tab screen (`ui/Accueil.svelte`, replacing Electron's grid in `PageVide`; the address field, `Essentiels` and the local-AI slot stay). A widget is a folder of the space, `espace/accueil/widgets/<id>/` (`widget.json`, `affichage.html`, `recolte.mjs` or `workflow.json`, `exemple.json`): the agent writes files, there is no API.
- Service: the noyau host answers `accueil.*` (`lire`, `placer`, `retirer`, `recolter`, `executions`, `execution`, `accorder`, `refuserAccord`) and sends `accueil.change` after every write (a widget or the theme written by the agent, an accord, a removal, a harvest); a successful placement writes `disposition.json`, which the `accueil/` watcher reports as `accueil.change`. The profiles offered by the accord card come from the renderer's state (`ui/accueil-profils.ts`), not from the host. Widget data, states and accords live outside the space, in `<dataDir>/widgets`.
- Display: each widget with an `affichage.html` is served from `resource://webaios-widget-<id>/affichage-<mtime>.html`, in an iframe with `sandbox="allow-scripts"` (opaque origin). On every `accueil.lire`, the sidebar (`ui/api.ts`) reads `<dataDir>/espace/accueil/widgets/<id>/affichage.html` (the widget folder confined by `realpath`: a symlink leaving it is refused) and writes a sanitized copy to `<dataDir>/webaios-widgets/<id>/affichage-<mtime>.html` — regenerated only when the source's mtime changes, the `<mtime>` being what reloads the frame — then sets the `resource` substitution `webaios-widget-<id>` to that folder (`chrome/window/widget-frame.ts`) and rewrites the widget's `src`. The copy starts with Electron's `CSP_WIDGET` as an injected `<meta http-equiv>` (a `resource://` file cannot carry a response header) then the guard's `<script>`, after any doctype: no network, no form, no frame, inline scripts and styles only, Trusted Types; an `affichage` carrying a network hint (`<link>`, `<meta http-equiv>`, speculation rules) is replaced by `AFFICHAGE_REFUSE` before any script. Removing a widget clears its substitution and copy folder. A custom `webaios-widget:` scheme was tried first and removed: measured in this Firefox, a frame never commits it (it stays `about:blank`, with no error) while `chrome://` and `resource://` frames load. Data arrives by `postMessage` (`donnees`, `taille`, `px`, `etat`); a widget link calls the page-world helper `window.webaiosOuvrir(url)`, installed by the guard, which dispatches `webaios-ouvrir` on the frame's window; the chrome UI (`CadreWidget.svelte`) listens for it on `contentWindow` and calls `api.accueil.ouvrir`, only after a real click (`isTrusted`) and only for an `http(s)` URL outside the machine (`urlOuvrable`). Measured: a sandboxed `resource://` frame cannot post to its chrome parent (`parent.postMessage` throws `Permission denied`), and `event.source !== parent` inside the frame; the helper replaces Electron's `parent.postMessage` link protocol. The three shipped model widgets are migrated at startup: a starter widget whose `affichage.html` sha256 matches a shipped pre-fix version (`packages/noyau/src/espace/initialiser.ts`) receives the current one, while an `affichage.html` The owner or the agent edited (unknown hash) is left alone. A widget of the owner's own that still keeps `e.source === parent` renders nothing (the sandboxed frame sees no message), and one that still calls `parent.postMessage` for links opens no link, until it uses the Firefox forms above; the agent can fix it on request.
- Guard: Electron's `garde-widget`, inlined as a `<script>` at the head of the served copy (`chrome/window/widget-frame.ts`), so it runs in the page world before the widget's own scripts: no WebRTC, Trusted Types by default, `<link>`, `<meta http-equiv>`, XSLT and code-as-text refused. A `widget-actor` `JSWindowActor` was tried first and removed: measured, its child does not act on these `resource://` frames in this Firefox (the parent exists and the frame is in-process, but `RTCPeerConnection` stays). The UI attaches the gesture listener itself: a capture-phase `pointerdown` on the frame's `contentWindow` from the chrome sidebar (`CadreWidget.svelte`), calling `api.accueil.geste`, and only when the guard installed (`RTCPeerConnection` gone and `trustedTypes` present) — if the guard threw, no click is recorded and no link opens. The WebRTC globals are shadowed with a non-configurable own `undefined` property, WebRTC last; deleting them did not work, measured: they live on `Window.prototype`, so the delete leaves the native function reachable, and the UI reads the page world through `wrappedJSObject` (an Xray would still show the native interface). The sidebar's own CSP carries `frame-src resource:` for the frame.
- Placement: free, in `espace/accueil/disposition.json` (`version: 3`): `x`/`l` in thousandths of the home width, `y`/`h` in pixels. Drag by the header, resize by the bottom-right handle; the widget cannot be dropped on another one and never moves it, but a drag may pass over a neighbour; the grid snaps (5 ‰ horizontally, 8 px vertically) with accent guides, holes are kept. A widget without a placement is put in the first free spot by the noyau on every read (`placerManquantsLibre`), so one the agent adds appears without a restart. A window resize stretches the thousandths and keeps the pixels.
- Theme: `espace/accueil/theme.json`, written by the agent with its file tools. `packages/noyau/src/accueil/theme.ts` validates it (colours `#rrggbb`, `rayon`/`espace` 0–24, `police` `system`, `serif` or `mono`) and the home root applies it as CSS variables. Absent or invalid: the app's theme, a console warning, the file left untouched; delete it to come back to the default.
- Harvests: the noyau's scheduler (minutes or fixed hours), the workshop container `webaios-atelier-firefox`, `recolte.mjs` or a workflow; « Mettre à jour maintenant » in the widget menu. Accords: a widget with `sources.compte` waits for the accord card, which names the domains read with the account and those contacted publicly and remembers the chosen login profile; the accord (domains and profile) is kept in `<dataDir>/widgets/accords.json`. Refusing erases the accord and what was read with the account and hides the banner for the session; removing a widget moves its folder to `espace/accueil/.corbeille` and erases its accord and its data.
- Notifications: a finished harvest of a widget with `recolte.notifier` shows a macOS alert through Firefox's alerts service (`Cc["@mozilla.org/alerts-service;1"]`, never the XUL fallback): title = widget name, text = number of new items, never their content. The e2e write one JSON line per notification to `WEBAIOS_TEST_NOTIFICATIONS` and show nothing.
- Host stopped: an action sent while the noyau host is stopped changes nothing; the card says « Sans effet pour l'instant : le service des widgets ne répond pas (agent arrêté ?) » after 6 s, and the page stays displayed.
- Builder: « Voir / modifier le workflow » opens Electron's workflow builder on `webaios://workflow/<widget>`, in the sidebar frame. Its Agent tab, ⌘J and ✦ open the window's agent panel on the right (the same conversation) instead of hosting the terminal in the tab: the only visible difference with Electron (`e2e/builder-agent.e2e.ts`).
- Tests: `e2e/accueil.e2e.ts`, the watch and the notification click in `e2e/watch.e2e.ts`; the fake docker is `test/outils/docker` (the launcher puts it on `PATH`), so no test touches a real container.

Limits:

- One theme palette only (no light/dark variant), no free CSS; the sidebar, the agent and the panels keep the app's theme.
- A login profile that becomes private or is deleted does not re-ask at once: the accord is refused at the widget's next scheduled harvest (as in Electron, at the next read; no observer).
- `affichage.html` is written by the agent: the CSP and the guard are deterrence, not proof (same limit as Electron).
- One home page for every space (as in Electron): widgets, data and accords are not per space.
- `ia.*` blocks run entirely in Ollama: Gemma (`gemma4:e4b-mlx`) writes, and the decision model `pplx-decider-flash` replaces Electron's Kev (same `/v1/systemone` request and answers; compared on the owner's real widgets: 90–100 % same keep/drop decisions, score correlation ~0.9). Nothing is installed by WebAiOs-Firefox: run `ollama pull pplx-decider-flash` once; a missing model fails the block with `Kev a répondu 404`. `WEBAIOS_KEV_URL` still points the decisions at a Kev server instead (the e2e use it for their fake).

## Site apps

- An app is a folder of the space, `<dataDir>/espace/sites/<id>/` (`site.json`, `accueil/`, written by the agent). What WebAiOs keeps lives outside it, in `<dataDir>/sites/<id>/` (`memoire.json`, `adresse.json`) and in `sites.json` (window frame, favicon). « Supprimer » moves the folder to `espace/sites/.corbeille/<id>-<time>` and wipes the session and the memory.
- Each app runs in its own internal container (`webaios-site-<id>`: cookies, localStorage, IndexedDB), in its own window (`chrome/store/sites.ts`, `ui/SiteWindow.svelte`): one `<browser>`, never a main window, never listed by ⌃Tab. A request guard (`http-on-modify-request`) keeps it on the app's domains and sign-in domains before anything leaves; the home screen is served from `resource://` in a sandboxed frame of the bar.
- The page's code runs in the `WebAiOsSite` actor (`site-actor.sys.mjs`), one `Cu.Sandbox` per document. It is read through the symlinks of `build:ui`: after a change to the actor, ask for `build:ui` (the e2e use `testActor`, the packaged one with `WEBAIOS_E2E_PACKAGED_ACTOR=1`).
- The Applications page's « Sites » section is Electron's, as is (`webaios://applications`): the host (`noyau/sites.ts`) answers `sites.liste` and `sites.agir`, and sends `sites.change`. « Afficher le dossier » and « Relire » are the UI's (`ui/api.ts`). The command bar lists the apps; the agent has `lister_sites`, `ouvrir_site` and `memoire_site`.
- The probes: `WEBAIOS_SPIKE=1 corepack pnpm --filter firefox-webaios exec vitest run -c vitest.e2e.config.ts e2e/sites-spike.e2e.ts`, to run again after each Firefox update (measures the window, the routing, the sandbox and the home).

Limits:

- The apps' modules are global (§4.9 of the spec): one list for every app, not per app.
- No Review page (« Relire » opens the internal « not available yet » page), no design mode, and no title-bar drag region: Firefox keeps its native title bar.
- Opened as Electron's « Ouvrir sans retouches »: no retouches injected, no address tracking and no accord card until plan 32, so `memoire_site` answers « refusé » (`SITE_REFUSE`).
- A sign-in window opened by `window.open(url)` without features has no `opener` (a login waiting for `opener.postMessage` fails). A window opened with features towards a refused domain shows for an instant, then closes; nothing leaves. A TCP preconnect (no HTTP request) is not seen by the guard.
- Firefox does not resolve `*.localhost`: the e2e add a DNS override (`resolveLocalHosts`). Visits of an app window are not recorded (`places.history.enabled` is false).
- The « Projets externes » block of the page shows an off server and no project (external MCP not migrated).

## Not migrated yet (step 4)

- site-app permission checks;
- the host does not restart on its own after a crash: « Réessayer » in the panel relaunches it;
- design mode;
- internal `webaios:` pages: a "not available yet" message (the Applications page shows its Sites section only; the Docker applications and « Projets externes » are not migrated);
- tab previews in ⌃Tab: the cards show the icon;
- zoom is not tracked in the state;
- the actions' workflow builder: `webaios://workflow/action/<id>` shows the internal page « Pas encore disponible dans WebAiOs-Firefox. »;

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
