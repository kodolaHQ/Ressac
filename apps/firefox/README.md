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
- `actor`: the page and extension JSWindowActors (`page-actor.sys.mjs`, `extension-actor.sys.mjs`). These are **copied** into the build, not linked (the macOS content sandbox cannot read a file outside the source and object trees): after changing `chrome/agent/page-actor.ts` or `extension-actor.ts`, run `pnpm build:ui`. The e2e load the extension actor as `pnpm ui` built it, through a `resource://` substitution (`WEBAIOS_TEST_EXTENSION_ACTOR` plus the `security.sandbox.content.mac.testing_read_path1` pref), so they need no rebuild.

## The agent

The noyau (`@webaios/noyau`) runs in a separate Node process, `noyau/host.ts`, started by Firefox and spoken to in JSON-RPC over stdio (one message per line). Its console output goes to Firefox's console prefixed `[noyau]`; stdout carries only the protocol. The Node and tsx paths are frozen at build time (`scripts/paths.ts`): a dev build only runs on the machine that built it.

The agent's workshop container is `webaios-atelier-firefox` (`WEBAIOS_CONTENEUR`), so it never touches the Electron app's `webaios-atelier`. It publishes ports 5300-5319 (`WEBAIOS_PORTS_CONTENEUR`), since the Electron app's container holds 5280-5299. Both share the `webaios-home` volume.

Invisible reads run in a windowless browser, in a private container cleared before and after each read. Every request from a reading container is checked: an address that is local, or a name that resolves to one (or fails to resolve), is refused. Known limits, marked `shortcut:` in `chrome/agent/local-guard.ts` and `invisible.ts`: custom-scheme navigations, preconnects, Alt-Svc, WebRTC, and service workers in a login profile's container.

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
- `lister_extensions` does not see add-ons yet; themes do not restyle our UI.

## The agent's extensions

Each is copied, signed by AMO (unlisted) and installed as an add-on (`<folder>@agent.webaios`); the noyau host keeps the registry and sends the grants to the chrome (`extensions.portees`). The guards of the copy (`webaios-garde-*.js`) ask the chrome through the extension actor (`window.__webaios`, defined on the agent's extension pages before their first script); the chrome also refuses every http request an agent extension loads or starts outside its grant, whatever its type (an `http-on-modify-request` observer on the loading or triggering principal, so a notification icon too), the `window.open` of its pages, and a `runtime.setUninstallURL` outside its grant.

The copy accepts only the rights Electron's agent extensions can use (`scripting`, `storage`, `unlimitedStorage`, `tabs`, `contextMenus`, `cookies`, `webNavigation`, `alarms`, `offscreen`, `clipboardRead`, `clipboardWrite`, `declarativeNetRequest*`), in `permissions` and `optional_permissions`; any other right (`activeTab` included, unsupported in Electron too; a host pattern in `permissions` too, which Electron reads as a host: stricter, so safe), or a manifest key that grants a power (`chrome_settings_overrides`, `protocol_handlers`, `user_scripts`, `experiment_apis`, `theme_experiment`, `omnibox`), is refused before any card with « Droit non pris en charge par WebAiOs : <name> ». Firefox-only APIs (`identity`, `dns`, `find`, `notifications`, …) are thus out of reach. `tabs.captureVisibleTab`, `tabs.captureTab`, `tabs.detectLanguage`, `tabs.saveAsPDF`, `tabs.print`, `tabs.printPreview` and `tabs.toggleReaderMode`, which Electron has not, are refused in the parent for every page of an agent extension (« <api> non pris en charge par WebAiOs »): Firefox grants activeTab to an MV3 extension on a click of its button, its menu item or its command even without the right. The copy's pages are sandboxed without `allow-popups` (`content_security_policy.extension_pages`): `document.open(url, "_blank")` and `<a target=_blank>` open nothing, as Electron refuses every window.

Limits:

- An `about:blank` frame of an agent page inherits its principal, and Firefox would give it the whole extension API without the guard: the extension actor (registered without `matches`, so it reaches those frames) defines `__webaios` there and takes out `chrome`, `browser`, `window.open` and WebRTC, before the page's script reads the frame. A page of the extension loaded in a frame reuses that window: it keeps no extension API (its guard then does nothing; its scripts cannot call `chrome.*`). A `srcdoc` frame is cross-origin to the page and runs none of its scripts.
- Before the first host sent the grants, the actor's answers wait 5 s at most, then refuse; the request observer refuses at once (fail closed): a background fetch right after a restart can be cancelled until `extensions.portees` arrives.
- `action.setIcon` with an absolute address is accepted by Firefox; no load was seen headless (the strip does not render it yet). Recheck when the strip renders action icons.
- Per space, only the content scripts follow the switches of a space's settings: they run in a WebAiOs tab of a non-private space whose profile the extension is active in, and in that profile's container (never an invisible read, which has no tab id). Firefox runs one copy of each add-on for every profile, so its background, its `declarativeNetRequest` rules and `tabs` stay global: active in one space, its background sees the tabs (with the right) and its rules apply in every non-private space. Never a private space: its tabs are hidden from the agent's extensions (`tabManager.canAccessTab`), a profile turned private leaves every agent extension (`extensions.profilsPrives`), the tabs of that profile its scripts were let into are reloaded (`extensions.rechargerOnglets`), and it is disabled where it is active nowhere else. Disabling an add-on stops its scripts already injected in Firefox (Electron keeps them until a reload).
- A tab the agent cannot read sends `extensions.aTourne` once per extension and profile: the registry masks its console there (`consoleMasquee`) and by add-on id (`consolesMasquees`, never emptied). A note sent while no host runs is sent again on the next check.
- Firefox specifics of the content guard (`webaios-garde-*.js`, shared with Electron): a content script's `window` is the page's window through an Xray, so every member the guard sets on the content script's global (`open`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `FormData`, the `on…` key and input handlers) is set on that window too; the agent's files are injected one `executeScript` per file, because Firefox drops a whole call when one file fails to compile. A `url()` in an agent stylesheet loads with the extension's principal, so the request observer cancels it outside the grant (Electron loads it).
- The content guard is deterrence, not a guarantee (its header lists what stays open). Code in the page's world escapes it, as in Electron (an inline `<script>`, an `on…` attribute); on Firefox the same door is also `wrappedJSObject` and `XPCNativeWrapper.unwrap` (the page's own objects: password values, listeners, the page's `fetch` and `open`, whose loads carry the page's principal, so the request observer does not see them). An `about:blank` frame the content script creates has no guard either: its `fetch` and `open` go out (`open` can open a tab). The same holds for a same-origin frame the page already has, reached through `frames[i]` (its `FormData` reads passwords, its `fetch` and `XMLHttpRequest` go out).
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

## Not migrated yet (step 4)

- compact mode;
- the agent's dev tools, widget data and site-app permission checks;
- « lecture ménagée » (changing host): refused with « Lecture ménagée pas encore disponible »;
- the host does not restart on its own after a crash: « Réessayer » in the panel relaunches it;
- design mode;
- internal `webaios:` pages: a "not available yet" message;
- tab previews in ⌃Tab: the cards show the icon;
- zoom is not tracked in the state;

## Worktrees

`engine/` is shared by all checkouts (it links to `~/WebAiOs-firefox/engine`), and the import links `src/` files of the checkout that ran it. Run `pnpm engine:import` in the checkout you build. Links left behind by a deleted worktree are dangling: `engine:import` prunes them first (`scripts/engine.sh prune`), otherwise surfer fails with ENOENT.

## Measured times (M5 Pro, 2026-11-03, Firefox 159 + Zen patches)

Full build 20–23 min; `build:ui` after a UI change 17 s; adding the sidebar files (`jar.mn` + `browser.xhtml` patches) 21 s; one C++ or Objective-C++ file 23–25 s; build with no change 21 s.

## Pitfalls

- The macOS 27 SDK breaks Mozilla's linker (unknown `arm64e.x1`): SDK 26.5 is forced (`configs/macos/mozconfig`, `scripts/env.sh`).
- A truncated Firefox archive stays cached in `.surfer/engine/` after an interrupted download: delete it.
- surfer declares a git fork of `is-apple-silicon`, which pnpm rejects: replaced by the registry version (`pnpm-workspace.yaml`).
- The icons in `configs/branding/webaios/` are placeholders.
