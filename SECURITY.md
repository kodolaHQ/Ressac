# Security

Ressac is a browser that lets an AI agent read and act on web pages. Security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub: the repository's **Security** tab › **Report a vulnerability**.

Include what you can: the Ressac version (Réglages › À propos), steps to reproduce, and what an attacker gains. You will get an answer as fast as possible. Ressac is a small project in beta: there is no bug bounty.

Bugs in Firefox itself (Gecko, SpiderMonkey, the network stack) belong to [Mozilla's security program](https://www.mozilla.org/security/), unless one of Ressac's patches causes them.

## Supported versions

Only the latest released version gets fixes. Ressac updates itself.

## What Ressac protects

The design assumes **web pages are hostile, including the ones the agent reads**: a page can try to give the agent instructions (prompt injection). The protections, in short:

### Where the agent runs

- **In a container inside a small Linux VM**, not on your Mac (Lima, Apple Virtualization, rootful Podman; `apps/firefox/scripts/vm/lima.yaml`, `apps/firefox/host/machine.ts`). The VM sees only the Ressac folder (read-write) and the workflow engine's folder (read-only), never your home folder; it forwards to the Mac only the Podman socket and ports 5300-5319 on `127.0.0.1`. The VM image is pinned by SHA-256. A Docker engine you installed is still used as a fallback: the container and its mounts are the same, but that engine's own VM shares more of your Mac (Docker Desktop shares `/Users` with it by default), so an escape from the container would reach further. Lima's SSH port listens on the Mac's localhost only; your `~/.ssh` keys are not authorized and no SSH agent is forwarded into the VM. `apps/firefox/scripts/vm/security-check.sh` checks this on a throwaway VM.
- **The container is hardened** (`packages/kernel/src/container/workshop.ts`): no new privileges, memory and process limits, IPv6 off, every agent process killed when a conversation opens and no other one is running. The base image is pinned by digest; Claude Code and Codex are pinned by version and installed root-owned, so they cannot replace themselves (Claude's autoupdater is off too) (`packages/kernel/docker/workshop.Dockerfile`).
- **The agent's network is an allowlist** (`packages/kernel/docker/ressac-network.mjs`): the agent's user reaches only localhost, the Mac's MCP and relay ports, and an allowlist proxy (HTTPS CONNECT and plain HTTP) limited to base domains (code and package hosts, the model APIs) plus the ones you add. The proxy refuses names that resolve to private addresses. The rules are applied again before each session, which does not start unless a direct connection is refused.
- **API keys stay in the macOS keychain** (`apps/firefox/host/relay.ts`): the container gets a session token, and the relay on the Mac swaps it for the key, only for inference paths and only toward the engine chosen when the session opened.
- **Two modes.** « Navigateur », the default, has no shell: Claude runs without Bash, `launch_app`, other MCP servers or any user, project or local settings; Codex without its shell tool, `notify` or a provider the agent defines (`packages/kernel/src/kernel.ts`). In both modes the models' own web tools are off, so all browsing goes through Ressac's browser: Claude's WebSearch and WebFetch, and Codex's web search (which, with its sandbox off, would fetch live pages from OpenAI's side), refused by the root-owned `requirements.toml` too. « Atelier » adds the shell to build and run project apps.
- **The agent cannot change its own rules.** Claude's managed settings (`disableAllHooks`, managed hooks only) and Codex's `requirements.toml` are root-owned; Codex's is rewritten each session with that session's MCP address. The internal `.ressac` folder (launch profiles, MCP config, the research notebook) is mounted read-only, except its `logs` folder, and planted symlinks are removed before each mount. The kernel's own reads and writes in the workspace refuse links the agent planted (`packages/kernel/src/workspace/no-links.ts`, `confined.ts`). npm install scripts are off by default.

### What the agent can reach in the browser

- **Only through the kernel's MCP server**, on `127.0.0.1`, with a bearer token checked in constant time.
- **Reading a tab needs your consent** (`packages/kernel/src/access/policy.ts`): the agent may read a tab you gave it, the tab you spoke to it from, or a local demo it built. Any other site needs a request, and a permission holds for one origin only. Tabs in a private space are never readable (`apps/firefox/chrome/agent/bridge.ts`). History and bookmarks need a card, once per conversation.
- **The agent does not click or type in pages.** It reads, navigates and hands control back to you for logins and captchas (`hand_over`). Two things you grant can act in a page: `run_js` on a tab (a developer right; console, network, performance and acting are granted per tab and per origin, through an in-process DevTools client with no socket), and an extension the agent wrote once you turn it on (signed by Mozilla with your account; its own pages are limited to the network you granted, and a wider scope turns it off until you grant it again).
- **An address the agent opens must be one it read, exactly** (`packages/kernel/src/mcp/seen.ts`): a page, one of its links or a search result, so `?q=<data>` added to a read address is not free. Outside a search, the fragment counts too (`page#<data>` is not free), and a local address, a tab it may read or an address you approved earlier in the conversation is also free. During a search, only that search's reads are free and a fragment the agent added is dropped. Any other address shows you a card with the whole address and the agent's reason before it opens. A recap may only link to addresses read.
- **During a search, a judge watches the agent's gestures** against the search's stated goal, when the local AI is on (a small local model; it sees the tool and the address or query, never page content). A strange query pauses before it reaches the search engine; a strange `read_tab` or `capture_screen` of another tab, or a read of the history or the bookmarks, pauses too; on an address card it adds a warning but does not decide. It fails open: no model, an error or no answer in 3 s lets the gesture through. A search opened by `read_pages` without a reason has no goal until a `search_web` gives one. Outside a search there is no goal, so no judge: the exact-address rule and the cards remain.
- **Memories written from the web are data.** A site app's memory keeps each entry's page and date and reaches the agent only after your grant, marked as data. The agent's research notebook (`packages/kernel/src/search/notes.ts`) is read-only in the container: the kernel writes a lesson only through `note_lesson`, once right after a hand-over where the agent was lost (any other tool call closes that chance), stamped with the date and that hand-over's sites, and gives the latest ones back with the `search_web` that gives a search its goal, capped and marked as hints, never instructions.
- **Invisible reads** run in a private, throwaway container, and every request they make to a local address (or a name that resolves to one) is refused (`apps/firefox/chrome/agent/local-guard.ts`).

### Pages and apps the agent builds

- **Agent pages** (ports 5300-5319) may only reach the agent's own local ports, or GET from five known CDN hosts (Google Fonts, cdnjs, jsDelivr, unpkg); a top-level navigation needs your gesture; DNS prefetch, preconnect and speculative connections are off (`apps/firefox/chrome/agent/page-guard.ts`). Agent apps get their own container and stay on their local origin.
- **Site apps** stay on their domains: every top-level load of an app's container must be on the app's or its sign-in domains, and a closed app's container loads nothing (`apps/firefox/chrome/store/sites.ts`). Tweaks run in a sandbox the parent process decides on, never the frame; a memory write needs the app's main document, its domains and your grant (`apps/firefox/chrome/store/site-frames.ts`).
- **Widgets, actions and workflows**: the harvest runs in a container with no network, a read-only file system, all capabilities dropped and memory and process limits. The kernel fetches for it: http(s) only, no credentials, declared domains only unless the widget or action asks for open web reads (then capped at 100 per run), local addresses refused after DNS resolution, size and redirect caps (`packages/kernel/src/workflows/access.ts`). Reading with your accounts needs a grant per widget or action. A widget's display has a CSP with no network and Trusted Types (`apps/firefox/chrome/window/widget-frame.ts`).
- **Ressac's own interface** (sidebar, panels, widgets, site homes) loads nothing from the web and has WebRTC denied (`apps/firefox/chrome/store/ui-network.ts`).
- **The external design-mode server** listens on `127.0.0.1`, refuses any request with an Origin header, checks Host against DNS rebinding, then a per-client token (`packages/kernel/src/design/external-server.ts`).

### Updates and telemetry

- **Updates are signed** with Ressac's own key (its certificate is built into the app) and must be newer than the running version (an update that could not be staged is judged by the feed's unsigned version); the DMG is signed with a Developer ID and notarized, and publishing refuses an update that does not verify. The VM image and its tools are pinned by SHA-256.
- **Telemetry** sends nothing before its notice has shown and one switch turns it all off: Ressac's own errors (addresses and the home path scrubbed), Firefox's crash reports (minidumps, which can hold page data and are not scrubbed) and one anonymous count per launch (`apps/firefox/shared/telemetry.ts`, `apps/firefox/chrome/store/telemetry.ts`).

### Known limits

Known limits are marked with `shortcut:` comments in the code (for example custom-scheme navigations, preconnects and WebRTC in invisible reads). Others:

- The allowed domains include code hosts, package registries and the model APIs: the agent can send data there to an account an attacker controls. Subscription logins sit in the agent's home volume, so the agent can read them.
- A session token adds no rights over the main token, and the session config files are readable inside the container: it only ties a session to a window.
- Once you grant `run_js` on a tab, script there can navigate or send anywhere without a card; an extension the agent wrote can act on its granted sites, and a changed one reloads without asking again while its rights stay the same.
- An agent page can still put data in the address of a GET to a known CDN, use WebRTC, or leak a WebSocket host name to DNS; a click you make in it can navigate out. A site app's subresources are not limited to its domains.
- A page that steers the agent during a search where it gets lost can still leave one lesson in the notebook.
- The judge fails open, only advises on address cards, and does not watch the developer reads.
- AGENTS.md and CLAUDE.md in the workspace stay writable by the agent, so it can steer its next session; a project `.npmrc` can turn install scripts back on.
- Without the signing settings, a DMG built from source is only ad hoc signed.

A way around one of the protections above is a vulnerability, even when it needs a crafted page.

## Out of scope

- What the agent does with permissions you granted it.
- Attacks that need full control of the user's Mac, of Ressac's VM or of a Docker setup.
- Rate limiting and denial of service against your own machine.
