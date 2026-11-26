# Ressac on Firefox

Ressac rebuilt on stable Firefox. Built with [surfer](https://github.com/zen-browser/surfer), which downloads Firefox into `engine/`, symlinks our `src/` files into it (same relative path), applies our `*.patch` files (`git apply`) and runs `mach`.

## Requirements (macOS arm64)

- `brew install gnu-tar python@3.12`; Rust in `~/.cargo/bin`; Mozilla toolchains in `~/.mozbuild` (installed by `engine:bootstrap` if needed).
- About 25 GB free: the Firefox sources live in `~/Ressac-firefox/engine`, and `engine/` is a symlink to them.
- Every command goes through `scripts/env.sh` (PATH, SDK): use the pnpm scripts.

## First install

```sh
pnpm --filter firefox-ressac engine:install   # downloads Firefox 160.0, moves it out of the repo, links it
pnpm --filter firefox-ressac engine:import    # links src/ and applies the patches
pnpm --filter firefox-ressac build            # full build (~20 min)
```

In a new checkout or worktree: `pnpm engine:link` then `pnpm engine:import`. The `engine` tree is shared between checkouts: run `engine:import` in the checkout you work in before building.

## The bundles

`scripts/ui.sh` builds five bundles with Vite from `ui/` and `chrome/`, into `src/browser/base/content/ressac/` (generated, git-ignored):

- `sidebar`: the Svelte UI, loaded in an iframe of the browser window;
- `window`: the window controller (syncs Ressac tabs and spaces with Firefox tabs and containers, shortcuts);
- `store`: the shared state module (`store.sys.mjs`: session file, containers, shutdown save, the agent host), imported by the window at runtime;
- `agent`: the agent panel (chat by default, terminal in Mode avancé), a second iframe on the right of the window;
- `actor`: the JSWindowActors (`page-actor.sys.mjs`, `site-actor.sys.mjs`, `design-actor.sys.mjs`…). These are **copied** into the build, not linked (the macOS content sandbox cannot read a file outside the source and object trees): after changing one under `chrome/agent/`, run `pnpm build:ui`. The e2e load the actors as `pnpm ui` built them, through a `resource://` substitution (`RESSAC_TEST_EXTENSION_ACTOR` plus the `security.sandbox.content.mac.testing_read_path1` pref), so they need no rebuild. After each `build:ui`, run them once against the packaged actor with `RESSAC_E2E_PACKAGED_ACTOR=1`.

## The agent

The kernel (`@ressac/kernel`) runs in a separate Node process, `host/host.ts`, started by Firefox and spoken to in JSON-RPC over stdio (one message per line). Its console output goes to Firefox's console prefixed `[kernel]`; stdout carries only the protocol. The Node and tsx paths are frozen at build time (`scripts/paths.ts`): a dev build only runs on the machine that built it.

The agent's workshop container is `ressac-workshop-firefox` (`RESSAC_CONTAINER`), from the image `ressac-workshop:1`. It publishes ports 5300-5319 (`RESSAC_CONTAINER_PORTS`) and mounts the `webaios-home` volume (kept: it holds the agent's login).

When the image is missing or out of date, the kernel runs `build` with the active engine (Podman in Ressac's machine, Docker as fallback) and streams its stderr; `parseBuildStep` (`packages/kernel/src/container/workshop.ts`) turns the BuildKit lines `#N [k/n] FROM|RUN …` into a step and a label in the shown language (`parseBuildStep(line, locale)`), sent to every window waiting on that start (`Workshop.onBuildProgress`, replayed to late joiners) and shown in the agent panel (« Préparation de l'agent, étape k/n : … (m min) »). Without step lines (classic builder) the panel keeps its plain text. The 20 min cap and the error tail are unchanged. `FAKE_DOCKER_BUILD_STEP_MS` paces the fake docker's build lines in the e2e.

Web search goes through the browser: the agent searches in its own visible tab (`search_web`, `read_pages`, `hand_over`; see « Chercher et lire le web » in `packages/kernel/templates/fr/AGENTS.md`, « Searching and reading the web » in `templates/en/AGENTS.md`), and the Claude profile passes `--disallowedTools WebSearch,WebFetch`, so Claude's own web tools are off. The research notebook (`<workspace>/.ressac/browsing-notes.md`, read-only in the container) is for Atelier sessions only: a Navigateur session gets no `note_lesson` and no lessons at a search's start, and its Claude deny list covers the file. It holds the agent's general lessons from hand-overs: the kernel writes one only through `note_lesson`, once right after a `lost` hand-over (any other tool closes the chance), stamped with the date and that hand-over's sites, and gives the latest ones back (4,000 characters at most, framed as data) with the `search_web` that gives a search its goal (`packages/kernel/src/search/notes.ts`; Settings › Données › « Carnet de recherche » › « Afficher dans le Finder »). The old `/workspace/browsing-notes.md` is deleted when left as shipped; an edited one stays, never read by Ressac (a customised AGENTS.md may still point the agent at it).

Invisible reads run in a windowless browser, in a private container cleared before and after each read. Every request from a reading container is checked: an address that is local, or a name that resolves to one (or fails to resolve), is refused. Known limits, marked `shortcut:` in `chrome/agent/local-guard.ts` and `invisible.ts`: custom-scheme navigations, preconnects, Alt-Svc, WebRTC, and service workers in a login profile's container. Paced reads (the workflows' `web` widgets) wait for another site's turn before following a navigation to it: the read stops at that site's document, gives its place back, waits, then resumes (`chrome/agent/invisible.ts`, `host/remote-bridge.ts`).

### The chat

The panel shows a discussion (`ui/components/chat/`) unless Réglages › Agent › « Affichage de l'agent » is set to the terminal (Mode avancé). The host owns the discussions (`core/agent/chats.ts`, `chat.*` in `host/host.ts`): several per window, each its own context, at most 3 live in the app (the others are paused and resumed by id); history is kept 30 days, masked text only, in `<dataDir>/chats/`. Claude runs through the Agent SDK inside the host, driving the pinned Claude Code in the workshop; Codex through `codex app-server`. The first sign-in runs `claude auth login` in a small terminal (Codex keeps its device login); a mode change during it interrupts it. The composer calls `masker.maskTypedFor` (the discussion's own session) before sending and shows « masqué » chips (« Envoyer en clair » per value); pasted text never counts as typed. Mode avancé starts the window terminal on the resumed conversation once the discussion's engine has closed.

« Votre modèle » (engine id `own`) is the user's own model, in Navigateur only, with no terminal and no workshop. Two kinds: an Ollama the user runs on this Mac (loopback address only; a cloud model is allowed, shown « en ligne » with the `remote_host` it forwards to) or an OpenAI-compatible API (`https://`, or `http://` on this Mac; a remote one is shown « en ligne »). The loop runs in the host (`core/agent/chat/own.ts`, prompts in `own-prompts.ts`): one JSON action per step under a schema (`ACTION_SCHEMA`; on the API kind `json_schema`, then `json_object`, then the schema in the prompt when a server refuses it), at most 10 steps and 5 minutes per turn, tool results cut at 6,000 characters, a 16,384-token context pruned at 75 %. Its tools are the kernel's 11 read-only `HOST_AGENT_TOOLS` (`packages/kernel/src/mcp/host-agent.ts`), called over MCP with a host session's own token, bound to the window. The clients are `ollamaClient` and `openAiClient` (`host/own-model.ts`); the API key is the keychain item `ressac-own-api`, sent only to the origin it was saved for. A change of the setting pauses the live discussions; they resume from the masked transcript. No streamed answer and no question cards yet.

### Agent engines

Settings › Agent lets each agent pick its engine. Codex: the ChatGPT subscription, Ollama, or an OpenAI-compatible API. Claude: the subscription, Ollama, or an Anthropic-compatible API (`claudeEngine` in the settings; the host passes `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, the per-tier `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` to the session). An API key stays in the keychain: the session only gets a relay session token. For Ollama the model is picked from the installed ones (the host reads `/api/tags` at the chosen address; « Actualiser » reads again; a saved model that is gone is marked « (non installé) »). Claude Code sends very long prompts: use a large model with a large context window (the card says so); Ollama's default context is short, so set `OLLAMA_CONTEXT_LENGTH` (e.g. 65536) for Claude Code. On Ollama or an API the sign-in button is quiet and the sign-in hint is hidden. At first use (a panel, a sign-in or a subscription write) the host downloads the pinned linux-arm64 Claude Code or Codex (`host/agent-cli.ts`, about 170 MB, checked against its SHA-256) into `<workspace>/.ressac/cli/<agent>/`, read-only in the container and first on its `PATH`; only the chosen agent is downloaded. `test/tools/fake-docker.cjs` records the `RESSAC_*`, `ANTHROPIC_*` and `CLAUDE_CODE_*` variables of the session in `fake-agent-env.json`.

### Local models

Ressac's local AI is one GGUF model, served by the `llama-server` shipped with the app (`RESSAC_LLAMA_SERVER`, set by `chrome/agent/command.ts`; `scripts/llama-server.sh` fetches it) in its own process, managed by `LocalAi` (`packages/kernel/src/ai/`). The search server is started by the host's page indexer and by ⌘T (warmed when the bar switches to « Demander ») and stops after 2 minutes idle:

- **EmbeddingGemma 300M** (Google, Gemma Terms of Use, `EMBED_MODEL`: ggml-org's Q8_0 GGUF, 334 MB, a free port per launch, `--embedding --pooling mean`): ⌘T Demander. The page indexer (`host/page-indexer.ts`) computes a vector per visited page in the background while AI is on (a pass when 32 pages wait or 10 minutes after the last one, so ordinary browsing does not keep the search server up), from its title, host and the first 300 characters of its kept text; the vectors live in `history.sqlite` (table `vectors`) and are erased with their pages. Private visits and private spaces are never embedded. `host/ask.ts` and `host/ask-rules.ts` read the period, the video sites and the action requests from the question, then show the three nearest pages above a cosine of 0.30; nothing above it, or an action request, goes to the agent.

The model is downloaded once from Hugging Face at a pinned revision (`EMBED_REVISION`) into `<dataDir>/local-ai/<name>/` (resumable `.part`, capped at its pinned size, checked against its SHA-256) when AI starts and it is missing; Réglages › IA locale shows its row (progress, « installé », a « Télécharger » button, or the last failure). Nothing else is installed: Ressac no longer installs or starts Ollama. The agents' Ollama engine (Settings › Agent) talks to an Ollama the user runs. A dev build downloads the same files, with no variable to set. Dev and tests only: `RESSAC_EMBED_URL` / `RESSAC_EMBED_SHA256` point the download at another file (the e2e use local fakes, never the real model), `RESSAC_EMBED_SERVER_URL` uses a search server already running. The old `local-ai/d1/` folder of an older Ressac is removed at start.

### Docker (fallback only)

The agent's workshop runs in Ressac's own machine (Lima + Podman, see « Publish a release » and `host/machine.ts`); Docker is used only while that machine is not ready, or for good where it cannot run. For that case, same idea for the container app (`host/docker-runtime.ts`): when Docker does not answer and OrbStack or Docker Desktop is installed, Ressac opens it in the background at launch (`open -ga`), and the welcome and Settings › Atelier show « Démarrer <app> » if that failed. Ressac never quits it and never installs it: with none on the machine the pages keep the link to OrbStack's download. `RESSAC_TEST_DOCKER_KIND` fixes the status for the e2e.

## Usage levels: AI and the lab

Three levels: Navigateur (no AI), IA, and the lab (tier 3: the Atelier, workflows and watches, actions, site apps, agent apps, design mode, the external MCP, `run_js` and the dev tools). Réglages › Agent › « Niveau d'usage » holds two switches, « IA » and « Labo (expérimental) »; the lab needs AI, and turning it on goes through a card (`ui/components/LabCard.svelte`) that lists what it exposes. The welcome offers only Navigateur or IA, never the lab.

- `settings.lab` (`boolean | null`; `false` for a new user). The effective lab is `labOn(s) = s.aiEnabled && s.lab === true` (`shared/tiers.ts`). A session saved before tiers has `null`: at the first start the host decides once (`lab.decide`, `host/tiers.ts` `labInUse`): on when `agentMode` is `workshop`, or `actions/`, `sites/` or `components/` hold a non-hidden entry, or a tier-3 widget sits in `home/widgets/` (empty folders do not count, `initSpace` creates them).
- Enforced in three layers. The kernel leaves `LAB_TOOLS` out of the MCP list and refuses them (`kernel-mcp-lab-off`), refuses an Atelier session (`kernel-err-lab-off`), reads the tier-3 stores as empty, and does not harvest tier-3 widgets (`widgets/tier.ts`). The host refuses every `workflow.*`, `actions.*`, `sites.*`, design and `apps.act` call with `lab-off`, and starts the external MCP server only while the lab is on. The UI hides or disables the entry points (`settings-lab-off`). Turning the lab off stops what runs (actions, tier-3 harvests, apps, design mode, site-app windows and essential tabs, an Atelier session relaunched in Navigateur) and deletes nothing.
- In Navigateur mode, whatever the lab, `actions/`, `sites/` and `components/` are mounted read-only in the container (`packages/kernel/src/container/workshop.ts`, container shape label `ressac.shape`).

`settings.aiEnabled` (the « IA » switch; the welcome's page 4 asks Navigateur or IA first) turns every AI feature on or off. Existing sessions keep it on; a fresh install starts with the question. Off, the chrome tells the host (`start` and the live `ai.enabled` message, applied in order): `host/host.ts` starts no Docker, local model or kernel, and refuses their work with `Error("ai-off")`. Every AI entry point (agent panel, command bar, home, empty page, agent apps) shows the `AiAsleep` card (`ui/components/AiAsleep.svelte`) instead, with a button to switch AI on. Switching on after the welcome runs the AI-only setup. In the e2e, `RESSAC_TEST_AI=0` starts with AI off (`launchRessac({ ai: false })`; the default is on). `RESSAC_TEST_LAB=0` does the same for the lab (`launchRessac({ lab: false })`).

## Work loop

- Changed `ui/` or `chrome/` (files already declared in `jar.inc.mn`): `pnpm ui`, then restart the app with `-purgecaches` (otherwise an existing profile keeps running the old scripts from its startup cache). No `mach`, no build: the app reads our files through symlinks.
- Changed a `src/**` `.js`/`.css`/`.html` file: `pnpm build:ui` (~17 s: Vite, then `mach build faster`).
- Added a file to `src/`: `pnpm engine:import` (builds the UI first, so the generated sidebar files get linked), then `pnpm build:ui`.
- Changed a `*.patch`, or anything compiled (C++, Rust, `jar.mn`): `pnpm engine:import`, then `pnpm build`.
- Tests: `pnpm test` (unit), `pnpm e2e` (headless Firefox with a temporary profile, driven over Marionette).

## Reports (Sentry)

A packaged build with a DSN (`RESSAC_SENTRY_DSN` at package time, never in the repo) sends, while the switch in Réglages is on (pref `ressac.telemetry.enabled`): errors (`errorEnvelope`, no page address, IP sent as `0.0.0.0`), native crashes only if their own switch is on too (pref `ressac.telemetry.crashReports`, off by default: minidumps hold memory and are not scrubbed), and one session per launch (`sessionEnvelope` in `shared/telemetry.ts`, item type `session`, `status: "exited"`) carrying a random install id kept in the pref `ressac.telemetry.installId`. Sentry › Releases then counts installs (users) and launches (sessions) per version. The version is `version` in `apps/firefox/package.json`, baked into the UI by `build:ui` (`__RESSAC_VERSION__`): Sentry's release, Réglages › À propos, the DMG name and the Finder version (`Info.plist`, rewritten by `scripts/package.sh` before signing) all read it. Bump it for each DMG sent to testers; it costs a normal package. `displayVersion` in `surfer.json` is compiled into Gecko (a near-full rebuild) and only moves with Firefox engine updates. Turning the switch off deletes the install id; nothing is sent while it is off. One « exited » session per launch: no live session nor crash-free rate (`shortcut:` comment). With crash reports on, pending ones go at the next launch unasked (`unsubmittedCheck.autoSubmit2`). A run that never quit cleanly (a mark `ressac-run.json` left in the profile) is reported at the next launch as an `AbruptExit` error (`chrome/store/abrupt-exit.ts`): sent, and macOS's DiagnosticReports read (system `JetsamEvent-*`, then `ressac*` in both folders, the 20 newest of each since that run started, matched by pid), only while reports are on and their notice has shown (`telemetry.consented`); no page data, only tags — macOS's verdict when a report names our `ressac` process (a `JetsamEvent` memory kill and its reason, a crash or a hang), time since the last wake and memory pressure, tab and process counts.

## Data

The Ressac state (session, settings) lives in the `data` folder next to `engine/` by default, never in `~/Ressac`. Set `RESSAC_DATA_DIR` to use another folder (dev builds only: the packaged app ignores it, as it ignores the `RESSAC_TEST_*` hooks and the host's dev overrides). The e2e always sets it to a temporary folder.

Two instances must never share a data folder: the session's temporary file name is the same in both (no pid in Firefox), so they would overwrite each other's session.

## Old names

Ressac was called WebAiOs. Stored formats that keep the old spelling: the container identities `userContextIdInternal.webaios-<id>` (logins of spaces, site apps and agent apps), the Docker volume `webaios-home` (the agent's logins) and the profile name `webaios-carried`. Old names still read in the agent's own files: `webaios.json` (new: `ressac.json`), `webaiosOpen` and `webaiosSite` (new: `ressacOpen`, `ressacSite`), the review mark `refs/webaios/relu` and the old workshop container `webaios-<name>` (removed before the new one is created).

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

## Extension quarantine

Réglages › Confidentialité « Extensions hors des sites sensibles » (`settings.extensionQuarantine`, on by default; `chrome/store/quarantine.ts`). On: `extensions.quarantinedDomains.enabled` is forced on and the static sensitive hosts (`SENSITIVE_HOSTS` and their `www.`) are merged into `extensions.quarantinedDomains.list`, put back at once if either pref is edited. Off: those hosts leave the list (an entry the user also typed that is one of them goes too), the user's other entries stay, and `enabled` goes back to Firefox's default.

Agent-written extensions were removed in 0.1.27. At the first launch of that version, the chrome uninstalls every `*@agent.ressac` add-on and clears their `extensions.quarantineIgnoredByUser.*` prefs (`chrome/store/extensions-removal.ts`, once: `ressac.agentExtensionsRemoved`), and the host deletes `<dataDir>/extensions`, `<workspace>/extensions` and the `ressac-amo` keychain items (`host/extensions-removal.ts`, once: `<dataDir>/agent-extensions-removed`).

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
  - Folder, keychain names and sidebar format were checked by a beta tester's real Arc import (2026-11).
  - Zen is read from `zen-sessions.jsonlz4`.
- **Background run:** one import at a time, in the background. It ends with a macOS notification giving the counts per type, or what failed and why.
  - A locked or unreadable Chromium file is retried once on a copy in `<dataDir>/import-tmp/`.
  - That folder is removed at startup (a quit or crash mid-import may leave it) and at the end of every run, and « Exporter les données » never includes it.
- **Not imported:** cookies and logged-in sessions, and extensions.
- **Tests:**
  - `RESSAC_TEST_IMPORT_HOME` replaces the home for source paths. Every e2e launch defaults it to an empty folder, so a test never reads the real `~/Library`.
  - Under a test home, Safari's engine migrator never runs, and Chromium passwords never touch the keychain.
  - `RESSAC_TEST_IMPORT_CSV` replaces the CSV file picker.
- **Tried for real** during the beta: Arc, Chrome (with the keychain prompt) and Zen imports.
- **Manual check left:** Safari with Full Disk Access.

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

- No debugging port. `chrome/store/devtools.ts` plugs a DevTools client into Firefox's DevTools server through an in-memory pipe, the way the toolbox does. `devtools.debugger.remote-enabled` is false, so no socket can open.
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
- Display: the agent-written frames (widget displays, site-app homes, action components) are not iframes of the parent process any more: each is a remote `<browser>` (`ui/RemoteFrame.svelte`, `chrome/window/remote-frame.ts`) in ONE shared web content process (`remoteType=webIsolated=resource://ressac-frames-<token>`, no `maychangeremoteness`, one browsing context group), sandboxed like `sandbox="allow-scripts"` (`sandboxFlags` set before the first load: opaque origin). Copies are sanitized files under `<profile>/chrome/ressac-frames/{widgets,sites,components}/` (the content sandbox reads only `<profile>/chrome`), wiped at every start and served by one `resource://ressac-frames-<token>` substitution with content access; the token is drawn at each launch (`chrome/window/frames-root.ts`) and never given to a page, so no web page can guess a copy's address. Older `<dataDir>/ressac-{widgets,sites,components}` folders are erased at start. A widget's copy is `widgets/<id>/display-<mtime>.html`, written on each `home.read` by the sidebar (`ui/api.ts`) from `<dataDir>/workspace/home/widgets/<id>/display.html` (folder confined by `realpath`) and regenerated only when the source's mtime changes, the `<mtime>` being what reloads the frame. The copy starts with `CSP_WIDGET` as an injected `<meta http-equiv>` (a `resource://` file cannot carry a header) then the guard's `<script>`, after any doctype: no network, no form, no frame, inline scripts and styles only, Trusted Types; a display carrying a network hint (`<link>`, `<meta http-equiv>`, speculation rules) is replaced by `DISPLAY_DENIED` before any script. Data arrives by `postMessage` (`data`, `size`, `px`, `state`), sent through the `RessacFrame` actor (the parent cannot `postMessage` to a remote context); a widget link calls the page-world helper `window.ressacOpen(url)`, which the actor forwards as `open`; the UI calls `api.home.open` only after a real press (`isTrusted`, forwarded as `press`) and only for an `http(s)` URL outside the machine (`openableUrl`). The frames' process is not trusted: the actor (`chrome/agent/frame-actor.ts`, `messageManagerGroups: ["ressac-frames"]`, `safeForUntrustedWebProcess`) forwards only a few known names with bounded fields, and the parent validates their content (link address, home messages, component height). A compromised frames process can still forge `press`: a link opened under a gesture is only as strong as that process. The process refuses http(s)/ws(s) loads itself, and its loads count as the UI's for `ui-network`. No document of the frames' process has `RTCPeerConnection`, `webkitRTCPeerConnection` or `navigator.mediaDevices`, nested frames included: the `RessacFrameRtc` actor (`allFrames`, `DOMWindowCreated`, `chrome/agent/frame-actor.ts`) sets them undefined and non-configurable before any script, on top of the widget guard. Measured: a PeerConnection the parent refused made the socket process exit as its frame went away, and a tab's call started at that moment gathered no ICE candidate (e2e/ui-network.e2e.ts). The parent's peer-connection blocker (`frameRtcBlocker` in `chrome/store/ui-network.ts`) stays as a second line. A `<profile>/chrome` that is a symbolic link makes the host refuse the home and component copies (they show nothing); widgets still work. Measured: a frame never commits a custom `ressac-widget:` scheme (it stays `about:blank`), `resource://` loads. The three shipped model widgets are updated at startup: a starter widget whose `display.html` sha256 matches a shipped pre-fix version (`packages/kernel/src/workspace/initialize.ts`) receives the current one, while a `display.html` the user or the agent edited is left alone. A widget of the user's own that still keeps `e.source === parent` renders nothing, and one that still calls `parent.postMessage` for links opens no link, until it uses the forms above; the agent can fix it on request.
- Guard: the widget guard, inlined as a `<script>` at the head of the served copy (`chrome/window/widget-frame.ts`), so it runs in the page world before the widget's own scripts: no WebRTC, Trusted Types by default, `<link>`, `<meta http-equiv>`, XSLT and code-as-text refused. The WebRTC globals are shadowed with a non-configurable own `undefined` property in the top document, WebRTC last; deleting them did not work, measured: they live on `Window.prototype`, so the delete leaves the native function reachable. What the guard misses (a nested `srcdoc` frame) the parent's `frameRtcBlocker` denies. Pressing and focus are the user's own events, caught by the actor on the chrome event handler in front of any page listener.
- Manual checks a human must do (no e2e sees them): drag a widget over another one (pointer events on a remote `<browser>`); a Meet call after visiting the home (the shared process must not disturb WebRTC of other tabs); the dark-mode look of widgets, components and site homes (the frame browsers are transparent over the card); a `<select>` and a date picker inside a frame (Firefox draws them in the parent, in the document holding the `<browser>`). The `*-spike.e2e.ts` files run only with `RESSAC_SPIKE=1`: they still describe the old in-parent frames, left as they are.
- Each frame loads its copy twice on first open, on purpose: ignoring the initial `about:blank` report (so owners would not reload) leaves the home unloaded, measured (`e2e/sites-home.e2e.ts` fails 9 tests); `RemoteFrame`'s « address its owner does not `accept` → reload » is what really loads it. That revert is bounded (`frameReverter`, one per browser, shared with the site home's guard in `chrome/store/sites.ts`): once per address until a load the owner keeps, at least 1 s apart, so a missing copy (a neterror page) or a page that keeps leaving does not loop in the shared process (measured over 3 s: 64 and 104 loads before, 2 and 7 after). A same-document change (`history.pushState`, which Firefox allows in the sandboxed copy) is not a load: the home's guard leaves it, and RemoteFrame drops the page's messages while its address is not accepted (a home router pushing `/settings` on load: 286 loads over 3 s before, 0 to 3 after: its first loads).
- One process, one failure, recovered: when the frames' process dies (a crash, memory exhausted) every frame browser gets `oop-browser-crashed`; `remote-frame.ts` takes it before Firefox's tab handlers (no tab crash page), then takes each browser out and puts it back (a new frame loader and browsing context, same element) and loads its last copy, so its owner feeds it again on `loaded` (a widget its data, a home its memory, a component its props and so its height; the home's guard follows the new context). Firefox drops a remote browser's `remoteType` attribute once it is up, so every insertion sets the attributes again (without it a revived frame went to a shared `web` process, measured); the revived frames start a new browsing context group (joining the dead one gave two processes, measured). Bounded: 3 revivals a minute per frame (`REVIVES_PER_MINUTE`), then it stays empty with « Cet affichage s'est arrêté plusieurs fois : il reste vide. »; logged once per crash. Measured (`e2e/frames.e2e.ts`, `home`, `sites-home`, `actions-render`): before, a killed frames process left every frame blank for good; after, all come back with their data, and a tab's crash leaves the frames alone.
- Refused explicitly, not by the sandbox's side effects (frames are top-level contexts, not nested iframes): a link to another application (`mailto:`, an app scheme) from a browser of the `ressac-frames` message manager group is dropped in the `handleURI` hook (`chrome/store/permission-hooks.ts`); fullscreen through `disablefullscreen` on the frame browser (`document.fullscreenEnabled` is false). And fail closed: a frame whose current document is not a null principal in the frames' process (`frameSandboxed`: should Firefox's sandbox flag numbering behind `SANDBOX_ALLOW_SCRIPTS` drift) is sent nothing and is never its owner's; logged once.
- Limit: a home looping in `closest` while design mode reads its source stalls the shared frames process (every widget, home and component) until `SOURCE_TIMEOUT_MS` ends the read; the script keeps running after.
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
- `ai.*` blocks go to the host's writer (`host/writer.ts`), the default profile's agent first, then the other: an API key from Settings › Agent (`claude-haiku-4-5` on `api.anthropic.com`, `CODEX_WRITER_MODEL` on `api.openai.com`, the configured model on another API), then a configured Ollama, then the subscription CLI in the workshop container: Claude Haiku (`claude -p --model haiku`, tools/MCP/settings off) when a Claude Code account is signed in, else Codex (`codex exec`, `gpt-5.1-codex-mini`, tools disabled). `ai.write` (`ressac.gemma(...)` keeps its name for compatibility) writes; `ai.sort` scores a whole list through the same writer, in chunks of 50 numbered items (`ressac.sort`; `ressac.kev` throws and points to it). With none of them it fails with « Connectez Claude Code ou Codex dans Réglages › Agent pour les résumés » (shown on the widget's home card); each call counts against the subscription or key limits; Réglages › IA locale has a « Rédaction » row. The Codex path was tried with a real ChatGPT account during the beta. The host's `settings.pullModel` accepts only the search model and the page polls `settings.pullProgress` for the percentage (one download at a time; quitting stops it and the next start resumes).

## Actions

- An action is a folder of the space, `workspace/actions/<id>/` (`action.json`, `workflow.json`, its `.mjs`), and agent components live in `workspace/components/<name>/`; runs, results, accords and `launch-denials.json` live outside it, in `<dataDir>/actions/`.
- Launch: from the new tab and the ⌘T bar (suggestions, input asked as a second field), from the « Actions » page (`ressac://actions`), or by the agent. The tab shows the progress, then the writer's page; previous results reopen without launching anything; two actions run at once, a third waits (« En attente : deux actions tournent déjà »). No action in a private space: the list is not even asked.
- Service: the kernel host (`host/actions.ts`, the disk half of the actions service) answers `actions.*` and sends `actions.change` and `actions.live`. The chrome half (`ui/actions-api.ts`) checks the private space before each request and again after its answer, dispatches, limits links to one per second, filters the live feed and offers the accord profiles. `open` runs in this order, split in two calls: private check, the host reads the action without launching it, private check again, `dispatch` `openAction`, then only the launch.
- Host stopped: the action page keeps its last read (no « Action inconnue »), and reads everything again once on the first `access` after the host comes back (« Réessayer »), without reopening the tab.
- Images: the host checks the conditions (no account, no accord, kept run, `https` address present as is in the results, neither local nor private); the chrome then loads the image through an anonymous channel (`LOAD_ANONYMOUS`: no cookie sent or stored, no referrer) in the internal `webaios-action-images` container, at most 3 checked redirects, `image/*` only, 5 MB at most, and gives it to the UI as `data:` (`ui/ActionImage.svelte`). Images load lazily (`IntersectionObserver`), once each; a decode error shows the neutral slot. The e2e set `RESSAC_TEST_ACTION_IMAGES=<origin>`: `https://<host><path>` is then asked from `<origin>/<host><path>`, a local server, and every redirect is refused; nothing leaves the machine.
- Components: a sanitized copy of `component.html` in `<profile>/chrome/ressac-frames/components/<name>/component-<mtime>.html` (see « The home page »), in a remote frame of the shared frames process (`ui/ActionComponentFrame.svelte`), with `CSP_WIDGET`, the widget guard and `COMPONENT_BRIDGE` first. The bridge turns `parent.postMessage` into a `ressac-component` event that the frame actor forwards; only a `{type:"height", px}` from this frame, showing the current copy, counts (clamped to 20–2000). The copies go when the last page showing the component closes, and the folder is emptied at store start. `Components` is hidden in component frames only: it is Firefox's leftover web object (interfaces only), harmless, hidden so component pages never see it. A component cannot navigate to another `resource:` page, and a self-navigation to http reaches nothing.
- Builder: the action part of the builder is in `host/workflow.ts`; saves go through the `action:<id>` write queue.
- Tests: `e2e/actions-*.e2e.ts`, `e2e/builder-actions.e2e.ts`, the actions part of `e2e/command-bar.e2e.ts`; the probes `RESSAC_SPIKE=1 … e2e/actions-spike.e2e.ts`.

Limits:

- A running action takes over the widgets' AI; no « Mise en page… » in the builder; with the workshop stopped the page says « atelier arrêté »; DNS rebinding is not handled for images; the layout is written by the user's agent account, the fallback layout without one.
- The action builder reads and writes even with the kernel stopped (as widgets do in this host).
- A widget display that compares `e.source` to `parent` receives nothing (see « The home page »).

## Site apps

- An app is a folder of the space, `<dataDir>/workspace/sites/<id>/` (`site.json`, `home/`, written by the agent). What Ressac keeps lives outside it, in `<dataDir>/sites/<id>/` (`memory.json`, `url.json`) and in `sites.json` (window frame, favicon). « Supprimer » moves the folder to `workspace/sites/.trash/<id>-<time>` and wipes the session and the memory.
- Each app runs in its own internal container (`webaios-site-<id>`: cookies, localStorage, IndexedDB), in its own window (`chrome/store/sites.ts`, `ui/SiteWindow.svelte`): one `<browser>`, never a main window, never listed by ⌃Tab. A request guard (`http-on-modify-request`) keeps it on the app's domains and sign-in domains before anything leaves; the home screen is served from `resource://` in a remote frame of the bar (the shared frames process, see « The home page »).
- The page's code runs in the `RessacSite` actor (`site-actor.sys.mjs`), one `Cu.Sandbox` per document. It is read through the symlinks of `build:ui`: after a change to the actor, ask for `build:ui` (the e2e use `testActor`, the packaged one with `RESSAC_E2E_PACKAGED_ACTOR=1`).
- The Applications page's « Sites » section (`ressac://apps`): the host (`host/sites.ts`) answers `sites.list` and `sites.act`, and sends `sites.change`. « Afficher le dossier » and « Relire » are the UI's (`ui/api.ts`). The command bar lists the apps; the agent has `list_sites`, `open_site`, `close_site` and `site_memory`.
- What the agent adds (plan 32):
  - **tweaks** (`tweaks/*.css`, `*.js`, `ressacSite`): the actor's child asks its parent what goes into each frame (`sendQuery`); the parent decides from its own `WindowGlobalParent` (`chrome/store/site-frames.ts`, `injectionFor`), never from what the frame says, and only for the app's view (never the sign-in window or a tab). Memory goes to the host (`host/site-memory.ts`); the retouches' console is relayed per frame;
  - the **accord card**: the view stays `about:blank` until the choice; rights that grow bring it back;
  - **video resume** (`ResumeTracking` of `core/resume.ts` in the actor, positions kept by the host) and the **address follow** (`UrlTracking` of `core/sites/tracking.ts`);
  - the **agent's tools** on `site:<id>` (`list_tabs`, `read_tab`, `capture_screen`, `navigate`, dev tools) behind the app's « widget_data » card;
  - **add-on buttons** in the app bar (`createSiteAddons`, `ui/SiteAddonsStrip.svelte`); the view is protected from add-ons (no remove, move, adopt, `windows.remove`, non-http loads; the request guard's net).
- The end-to-end scenario with the examples of the site apps guide (`packages/kernel/templates/fr/guides/site-apps.md`): `e2e/sites-scenario.e2e.ts`.
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

- An app the agent writes is a folder `<dataDir>/workspace/projects/<folder>/` with a `ressac.json` manifest, run by the kernel in the workshop's engine (`host/applications.ts`, the kernel's `ApplicationManager`). Its window is `chrome/store/apps.ts` + `chrome/window/app-window.ts`: one `<browser>` on the app's port, no bar, never a main window.
- Each app has its own internal container (`webaios-app-<folder>`) and a request guard that keeps it on its origin: other sites open in a tab of the main window; `file:`, `data:` and `blob:` are refused (also as http redirects); permissions are denied per origin and container; the view is protected from add-ons. Closing the window stops the app; so does the host stopping (the window closes). At quit the apps stop first, then the sessions.
- The Applications page's agent apps section (`ui/api.ts`): launch, stop, delete, « Passer en application », debug (the terminal is filled, not sent), « Afficher le dossier » (`reveal`, never `launch`), « Relire ». ⇧⌘A opens the page; Firefox's own ⇧⌘A (about:addons) is disabled.
- The badge (top right of the window, `ui/badge-api.ts`) shows the agent's access to the app and lets one cut it or open the Review page; the page cannot reach it. « Mode design » and the basket in its menu drive the design mode of the app (see « Design mode »).
- The Review page covers these apps: the first snapshot is taken at start (apps without a manifest are skipped).
- The design viewfinder runs in the `RessacDesign` actor (`chrome/agent/design-actor.ts`, every frame, http/https). It is the one packaged file of this plan: after a change to it, ask for `build:ui` (the e2e use `testActor`, the packaged one with `RESSAC_E2E_PACKAGED_ACTOR=1`). Its guard sits on the `chromeEventHandler`; a cross-origin frame in another process is guarded by its own actor.
- Copies with drift tests: `validFolder` (`chrome/store/app-folder.ts`, `test/containers.test.ts`).
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
- Site app windows (plan 36): the ✎ button of the app bar (with its chevron: « Panier », « Relire ce projet ») and ⇧⌘D toggle the mode of that app; the target comes from the window, never from the page. The viewfinder is the packaged `RessacDesign` actor in its own sandbox next to the retouches' (no `build:ui`), without the source read; the bubble warns that a third-party page is captured. The app's home is a remote frame of the bar (frames group): the same actor registered as `RessacDesignFrames` aims it, armed only on the served home copy the parent names, and its remarks are tagged `[home]`. Unavailable on the accord card, the login page, in fullscreen (a 5 s `info` notice in the bar). ⌂, « Entrer dans le site », fullscreen, another document (a retouche reloads the view) or the window closing end the mode; the cart stays. In the small sign-in window ⇧⌘D toggles nothing and shows the notice. With the host down ✎ keeps its last state.
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

Sidebar side (Réglages › Général › « Barre de navigation »): `settings.sidebarSide` (`left` by default). On `right`, the controller sets `ressac-sidebar-side="right"` on the chrome root and `window.css` mirrors the frames: the sidebar on the right edge, the agent panel on the left, the design basket between the page and the agent. The window buttons stay in the sidebar's top row, which is still the drag zone. The UI follows the state: full-window pages (`App.svelte`), the compact column (it folds out to the right), the context menu clamp, and the agent's resize handle (on its right edge, one signed drag handler). The compact mouse zone uses `innerWidth - x`. Tests: `e2e/sidebar-right.e2e.ts` and the right-side cases in `agent-panel` and `compact`.

## Worktrees

`engine/` is shared by all checkouts (it links to `~/Ressac-firefox/engine`), and the import links `src/` files of the checkout that ran it. Run `pnpm engine:import` in the checkout you build. Links left behind by a deleted worktree are dangling: `engine:import` prunes them first (`scripts/engine.sh prune`), otherwise surfer fails with ENOENT.

## Calls in a background tab

A tab that uses the camera or the microphone when it is left (`TabSelect`, `chrome/window/calls.ts`) gets `tab.call` (`{ mic, camera }`, volatile) and the sidebar shows a call bar above its footer (`ui/components/CallBar.svelte`): back to the call, microphone, camera. The tab's actor (`chrome/agent/call-actor.ts`, `RessacCall`, every http(s) frame) reads the state every 500 ms while watched and relays changes; the bar goes when the tab is shown again, the call ends or the tab closes.

- Buttons: on a site of `shared/call-sites.ts` (Meet, Teams, Zoom) the actor dispatches the site's own macOS shortcut in the page (a chrome-made key event is trusted), so the site and the other participants see the change; the state shown is the site's buttons when it has `buttons` (`data-is-muted`), else what the window captures (`mediaCaptureWindowState`). On any other site Firefox mutes what the window sends (`getUserMedia:muteAudio` / `muteVideo`): the site's own UI does not show it. More sites without a build: pref `ressac.call.sites`, a JSON array of `CallSite` (read in the parent: a web process does not get a user string pref).
- Video: Firefox's automatic picture-in-picture on a tab switch is on (`media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled`), kept for calls only: `chrome/store/call-player.ts` wraps `PictureInPictureToggleParent.receiveMessage` and, instead of Firefox's own choice (which refuses a live stream without a sound track), asks the call actor, which hands the largest playing video of a capturing page to `PictureInPictureLauncher`. Firefox closes the player when the tab is shown again.
- Tests: `e2e/calls.e2e.ts`, on fake devices (`media.navigator.streams.fake`; they count as a capture only with `media.navigator.permission.fake`). Tried in real calls during the beta.
- Build facts: as the vim actor, a new checkout needs the `call-actor.sys.mjs` link in the engine (`pnpm engine:import`).

## Sound and playback in tabs

- Sound pictogram: `tab.sound` (`"playing"` / `"muted"`, volatile) follows the XUL tab's `soundplaying` and `muted` attributes (`TabAttrModified`, `chrome/window/tabs.ts`). `ui/components/SoundButton.svelte` shows it on the tab's row, on its pinned row and in the media bar; a click calls `tab.toggleMuteAudio()` (`ressacWindow.toggleMute`). A muted tab keeps its pictogram until unmuted. Essentials (icon tiles) have none.
- Media bar: `tab.playback` (`"playing"` / `"paused"`, volatile) follows the tab's `browsingContext.mediaController` (Firefox's media keys' session: `activated`, `deactivated`, `playbackstatechange`), listened to from the first sound or when the tab is left. `"paused"` is kept only for a background tab that was playing (a tab left with nothing playing has no bar). A tab with `playback` that is not the one shown gets a bar above the sidebar's footer (in `CallBar.svelte`, under the calls): back to the tab, play / pause (`mediaController.play()` / `pause("user")`: `pause` needs its reason), sound. A tab in a call has the call bar only. Videos do not float (calls only).
- Tests: `e2e/media-bar.e2e.ts`. Sound does not decode in a hidden test browser, so real playback (the session's events, play / pause on a real page) is not covered there.

## Memory

« Économiser la mémoire » (Réglages › Général, `settings.saveMemory`) is on by default on Macs with 8 GiB or less (`shared/settings.ts` `isSmallMac`); an explicit choice is kept. While it is on:
- Essentials load on first display instead of at launch, and Firefox may unload them under memory pressure. An essential is kept loaded, in the first window only, when the user ticks « Garder chargé (notifications) » in its menu, or by default when its host is a messaging or calendar site (`KEEP_LOADED_HOSTS`, `shared/model.ts`) and it may send notifications. WhatsApp Web and Gmail use no Web Push: they notify only while loaded.
- Scheduled widget harvests and page-indexing passes wait for normal macOS pressure (`kern.memorystatus_vm_pressure_level` = 1); manual and agent harvests do not.
- One preallocated content process instead of 3, and the aura stays still unless the user chose it.
- Background tabs become unloadable after 3 minutes of inactivity instead of 10 (`browser.tabs.min_inactive_duration_before_unload`, `shared/settings.ts` `memoryPrefs`). Firefox reads that pref once at startup, so `chrome/store/index.ts` wraps `TabUnloader.unloadTabAsync` to read it live when no floor is given, which is how the warn-level memory watcher calls it. At critical macOS pressure (sysctl level 4), the host checks every 10 s and the chrome unloads up to 3 least recently used eligible tabs at once (`TabUnloader.unloadLeastRecentlyUsedTab(0)`), with no inactivity floor; on entering it, the host also unloads the local models and stops an unused machine. Warn-level pressure is left to Firefox, whose watcher then unloads one eligible tab every second instead of every 10 (`browser.lowMemoryPollingIntervalMS`).

On every Mac, `browser.lowMemoryResponseMask` is 3: under pressure Firefox unloads background tabs that have been inactive for at least 10 minutes. It never unloads the shown tab, a call, a tab playing sound or in picture-in-picture, or the parking tab. The first unload also tells the host to unload the local models and stop an idle machine (`chrome/window/tabs.ts`).

On every Mac, scheduled harvests and page-indexing passes also wait 2 minutes after the Mac wakes (a jump of the wall clock, `createWakeGrace` in `host/machine.ts`), while Firefox reloads its pages; and the machine's idle delay counts time asleep.

Measured on an 8 GB VM: 3 spaces, 18 tabs, 7 essentials (logged out) and a call. The figure is the sum of `footprint` over every Ressac process, in GB:

| | 0.1.14 | setting on |
|---|---|---|
| Relaunch (90 s after start) | 2.7 | 0.6 |
| End of a pressure run | 2.4 | 0.8 |
| Unloaded under pressure | 0 | 7/7 essentials + 9 tabs |

The call kept running, and macOS killed nothing. With everything open the setting saves nothing: its gain is at launch and under pressure. Logged in, essentials weigh far more: Gmail about 730 MB, WhatsApp about 580 MB. That is why a messaging essential is kept loaded only when it may notify.

Not kept: Firefox's « Minimize memory usage » (`minimizeMemoryUsage`) on hidden kept-loaded essentials. It gains 7 to 9 % on logged-in Gmail and WhatsApp, almost all of it JavaScript heap, for a call that runs in every process.

To reproduce:
- Use a Tart macOS VM with 8 GB and 4 CPUs, running a `run package` build driven over Marionette.
- Measure with `footprint -p` on every Ressac process. Never use RSS: it counts shared and file-backed pages.
- Relaunch: start, wait 90 s, measure.
- Open everything: open every essential and tab, start a loopback call, wait 2 min, measure.
- Pressure: run node fillers of incompressible memory (2.8 GB, then +1 GB, then +1.5 GB, a few minutes each), sampled every 30 s.

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

For a version that goes to testers only. Ressac updates itself from `https://updates.getressac.app` (Cloudflare R2 bucket `ressac-update`, or `RESSAC_R2_BUCKET`). The beta is invite-only, so nothing there has a path written in this code: everything sits under `updates/<RESSAC_UPDATE_KEY>/`, a random folder name (24 to 64 lowercase letters or digits, e.g. `openssl rand -hex 16`) kept outside the repository and set at package time. `package` writes it into the app as the `AppUpdateURL` policy (`Contents/Resources/distribution/policies.json`: Firefox ignores `application.ini`'s `[AppUpdate] URL`, compiled into the binary) and into `update.xml`; Réglages › À propos derives its « Télécharger » link from that policy. Anyone holding a DMG can read the key from it: it hides the feed from readers of the code, not from testers.

1. Bump `version` in `package.json` and add its entry at the top of `shared/release-notes.ts`.
2. `pnpm run package` with the signing, notarization and MAR key and `RESSAC_UPDATE_KEY` set up: it writes `dist/Ressac-<version>.dmg`, `.mar` and `dist/update.xml`. Without the key it packages no update archive.
3. `pnpm run release:publish` with the same `RESSAC_UPDATE_KEY` (once before: `npx wrangler login`). `scripts/publish.sh` refuses unless the DMG is notarized, the MAR verifies against `dep1.der`, `update.xml` and the top release notes entry are for this version, `update.xml` was packaged with this key, and `releases/<version>/` is not on the server yet (a published version is never rewritten). It then uploads, under `updates/<key>/`: `releases/<version>/Ressac-<version>.mar` and `.dmg`, `Ressac.dmg` (the latest, `Cache-Control: max-age=300` so Cloudflare does not keep an old one), and last `browser/Darwin_aarch64-gcc3/ressac/update.xml` with `Cache-Control: no-cache`, so it never points at a file not uploaded yet. Not `pnpm publish`: that is pnpm's own command. If an upload fails halfway, run it again: a MAR already on the server that is byte-identical to `dist/`'s is a retry and the uploads resume; a different one is refused.
4. A tester's download link: `pnpm run release:invite [days]` prints a presigned link to the latest DMG, valid 1 to 7 days (7 by default, the longest S3 allows). It needs an R2 API token with read access on the bucket (Cloudflare › R2 › Manage API tokens): `RESSAC_R2_ACCOUNT_ID`, `RESSAC_R2_ACCESS_KEY_ID`, `RESSAC_R2_SECRET_ACCESS_KEY`.

The app ships Lima and the Podman remote client (`scripts/vm-tools.sh`, pinned and SHA-256 checked; `package` signs `limactl` with `scripts/limactl-entitlements.plist`) but downloads the machine image at first use, from the URL and SHA-256 pinned in `VM_IMAGE` (`host/machine.ts`). Only when the image changes (a new workshop Dockerfile, Alpine or Podman), before packaging: `scripts/vm/build-image.sh`, then `scripts/vm/publish-image.sh` (it uploads `vm/ressac-vm-<version>.raw.zst` with its `packages.txt` and `sources.tar`, mirrors them in a GitHub release `vm-<version>` tagged on the commit that built the image, and never rewrites a published image; build from a clean, pushed commit; once before: `gh auth login` and an R2 API token in `~/.config/ressac/r2.env`, see `scripts/vm/README.md`), then pin the version, URL, SHA-256 and byte size it prints in `VM_IMAGE`. `package` writes a notice pointing at that package list and those sources into `ressac-host/LICENSES`. See `scripts/vm/README.md`.

Rolling back is a new version: put the old code back, bump to a new, higher number (Ressac drops any update whose version is not above the running one, see `chrome/store/updates.ts`; Firefox itself only skips the same build ID, since every Ressac MAR carries the same Gecko version), add its notes entry (« Retour en arrière sur … »), package and publish as above.
