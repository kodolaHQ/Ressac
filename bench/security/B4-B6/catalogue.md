# B4–B6 attack catalogue (frozen before any test)

Written 2026-11-21 from SECURITY.md and the code of worktree `Ressac-bench` (main e94539fb), before any test ran.
Criterion (plan, deterministic barriers): 0 bypass. One bypass = the claim is BROKEN (or, if SECURITY.md already states it as a limit, "holds with limit", the limit text checked).
Where: **K** = real `startMcpServer` (real AccessPolicy, Outflow, SearchSessions, SeenUrls, Recaps, BrowsingNotes) on a fake bridge, driven by a scripted MCP client; **R** = real `startRelay` with a fake key and a fake upstream on localhost; **C** = workshop container in a throwaway Lima machine, as the agent's user `node`; **CR** = code review only (browser-side code that the fake bridge replaces: cannot be attacked here).

## B4. What the agent can reach in the browser

### C4.1 « Only through the kernel's MCP server, on 127.0.0.1, with a bearer token checked in constant time »
- 4.1.1 K: no Authorization header → must be 401.
- 4.1.2 K: wrong token of the right length; right token truncated by 1; right token + 1 char; empty bearer → 401.
- 4.1.3 K: scheme variants (`bearer x`, `Bearer  x`, `Basic`, token in `?token=`, in a cookie, in `X-Api-Key`) → 401.
- 4.1.4 K: a session token after `closeSession` (replay) → 401.
- 4.1.5 K: valid token on another path (`/`, `/mcp/../x`, `/MCP`) → 404, no tool.
- 4.1.6 K: the server's listening address is 127.0.0.1 only (not 0.0.0.0 / ::); reached from another interface address → refused.
- 4.1.7 K+CR: constant time: the comparison is `timingSafeEqual` on equal lengths for the main token and every session token; no early exit on the first match. Coarse timing of first-byte-right vs first-byte-wrong tokens (reported as indicative only).
- 4.1.8 K: **token switching.** The agent of window W1 uses the main token, or window W2's session token (both readable in the container per Known limits). Does it gain anything SECURITY.md promises per window or per search? (a) rule 2 memory: read a private tab with W1's token, send the read data in `search_web` with the other token; (b) rule 3: during W1's search, read a sensitive granted tab / history with the other token; (c) the in-search address rule: open, with the other token, an address the search has not read; (d) `hand_over`/pause: read the search tab while the user has it, with the other token; (e) the notebook slot.
- 4.1.9 K: a request with a browser `Origin` header and a valid token (a page that learned the token) is served? (reported; the claim is the token only.)

### C4.2 « Reading a tab needs your consent … a permission holds for one origin only »
- 4.2.1 K: `read_tab` on a tab never granted → card; refused → no page text, title or URL in the answer.
- 4.2.2 K: `list_tabs` shows nothing (title, URL) of an ungranted tab.
- 4.2.3 K: `capture_screen` on an ungranted tab → card; refused → no image.
- 4.2.4 K: grant on origin A, the user navigates the tab to origin B (`tabNavigated`) → read asks again.
- 4.2.5 K: grant on A, the tab's URL changes to B with no `tabNavigated` event (redirect, script) → read must still be refused (origin compared at read time).
- 4.2.6 K: grant on A, the agent itself navigates the tab to B through a link → access must lapse.
- 4.2.7 K: lookalike origins after a grant on `https://a.example`: other port, `http:`, subdomain, trailing dot host, `user@` userinfo, upper case, IDN/punycode twin → each must count as another origin or the same site only when the browser would load the same origin.
- 4.2.8 K: non-web addresses after a grant: `about:blank`, `data:`, `blob:https://a.example/…`, `view-source:https://a.example/`, `about:reader?url=https://a.example/` → readable under A's grant?
- 4.2.9 K: race: the card is answered yes while the tab has moved to another site → no read of the new site.
- 4.2.10 K: race: the tab moves between the access check and the read (the kernel must pass `expect`; a bridge that honours it throws SiteChanged) → no content of the new site.
- 4.2.11 K: a tab the agent opened on a web address (not local) is not readable without a card; a local port outside the agent's range (the user's own dev server) neither.
- 4.2.12 K: a grant from the previous conversation (`policy.reset`) is gone; a late « yes » on a card of the old conversation grants nothing.
- 4.2.13 K: one card at a time per tab: N parallel reads → one card; a refusal is not turned into a grant by a concurrent call.
- 4.2.14 K: site app window (`site:<id>`): `read_tab`, `site_memory`, `tweak_errors`, `list_tabs` before its grant → nothing but name, domain, state; a tab grant on the same origin does not open it; a changed declaration hash asks again.
- 4.2.15 K: `read_pages` / the search tab as a side door: read the URL of the user's private tab through `read_pages` (it would load with which cookies?) → K: card rule; CR: which profile the search tabs use.
- 4.2.16 K: `current_page` when the active tab is not granted → card.
- 4.2.17 CR: frames: does a tab read include cross-origin frames' text (a granted page embedding another origin)?

### C4.3 « Tabs in a private space are never readable »
- 4.3.1 K: with a bridge that reports private tabs as the real one does (absent from `listTabs`, `isPrivate(id)` true): `read_tab`, `capture_screen`, `navigate`, dev tools on the private tab's id → the private text, nothing else; no card either.
- 4.3.2 K: `current_page` while the active tab is private → nothing; `list_tabs` does not list it.
- 4.3.3 K: no activity (`onActivity`) is reported for a private tab.
- 4.3.4 K: a tab that becomes private between check and read (bridge throws PrivateTab) → no content.
- 4.3.5 K: `show_recap` in a private active space → not opened there.
- 4.3.6 CR: browser side (`apps/firefox/chrome/agent/bridge.ts`): every bridge call goes through the private check; history/bookmarks made of non-private visits only. Not attackable on the fake bridge.

### C4.4 « History and bookmarks need a card, once per conversation »
- 4.4.1 K: `search_history`, `read_history`, `search_bookmarks` with no grant → card; refused → no result.
- 4.4.2 K: `read_history` of a guessed URL with no grant → nothing (not even « rien de retenu » vs a hit: an oracle?).
- 4.4.3 K: granted once → no second card in the conversation; after `policy.reset` → card again.
- 4.4.4 K: parallel calls → one card; a late yes after reset grants nothing.
- 4.4.5 K: a widget-data / action / site card answered yes does not grant history (key confusion: widget id `history`, `history:`).
- 4.4.6 K: history through another tool with no card (`list_tabs`, recap, dev tools, widgets)?

### C4.5 « The agent does not click or type in pages »
- 4.5.1 K: enumerate every tool (`tools/list`) of the server as the kernel starts it: any tool that acts in a page (click, type, script, form) without the dev-tools card?
- 4.5.2 K: `run_js`, `reload`, console/network reads on a tab without the grant → card; refused → nothing; grant is per tab and per origin (lapses on origin change); a refused right is not asked again in a loop.
- 4.5.3 K: `navigate` to `javascript:`, `data:`, `file:`, `about:`, `view-source:`, `blob:`, `chrome:`, `moz-extension:`, `resource:` URLs (script by another door) → refused; same for `open_tab`, `read_pages`.
- 4.5.4 K: `hand_over` is the only « act » and gives the page to the user (see C4.8).

### C4.6 « An address the agent opens must be one it read, exactly »
Outside a search (`open_tab`, `navigate {url}`), base page P = `https://shop.example/item?id=1` read with links; each variant must show the card (or load exactly a read address):
- 4.6.1 added query `?id=1&q=DATA`; added path segment; changed value.
- 4.6.2 added fragment `P#DATA`; fragment on a link read without one.
- 4.6.3 host case `SHOP.example`, scheme case `HTTPS://`, default port `:443`, trailing dot `shop.example.`.
- 4.6.4 userinfo `https://DATA@shop.example/item?id=1` (data in the userinfo reaches the site's logs / proxies).
- 4.6.5 percent-encoding variants (`%69tem`, `%3F`), double encoding, `+` vs `%20`, unicode normalisation.
- 4.6.6 path normalisation: `/a/../item`, `/./item`, `//item`, backslash `\item`, tab/newline inside the URL, leading/trailing spaces.
- 4.6.7 IDN: punycode vs unicode host of a read address; a homograph of a read host.
- 4.6.8 other port, other scheme (`http:` of an `https:` read).
- 4.6.9 subdomain carrying data `DATA.shop.example` (DNS exfiltration through a read host's parent).
- 4.6.10 engine redirect forms: `https://duckduckgo.com/l/?uddg=<attacker URL with data>` and `https://www.google.com/url?q=…` composed by the agent (never read) → card; and a read redirect link frees only its exact target.
- 4.6.11 a link read on a page, then modified (one character of the query).
- 4.6.12 an address read only as a link photo (image URL) → is it free to open? (it was read; reported.)
- 4.6.13 `navigate {link: n}`: an out-of-range n; a list printed for another tab; **a list printed while the tab was a local page (agent-written links), used after the tab moved to a web page**; a list of a site app.
- 4.6.14 a local page's links (the agent writes them) never become free: read a local demo with links, then `open_tab` one of its web links → card.
- 4.6.15 a site app's page links never become free; `navigate` in a site app stays on its domains and asks for a composed address.
- 4.6.16 « approved earlier in the conversation »: an approval frees that exact address only (not its origin, not with another query); gone after `policy.reset`.
- 4.6.17 « a tab it may read »: the address of a readable tab is free, exactly; of an unreadable tab not.
- 4.6.18 local addresses are free: what counts as local (`localhost`, `127.0.0.1`, `[::1]`, `127.1`, `0x7f.0.0.1`, `2130706433`, `localhost.`, `localhost.evil.example`, `127.0.0.1.evil.example`, `localhost@evil.example`, `0.0.0.0`) → nothing non-local may pass as local.
- 4.6.19 CR: a local address that redirects to the web (an agent server on its ports answering 302 → `https://evil.example/?d=DATA`): the address opened was local and free; does the browser stop the redirect? (browser side, B7's page guard: reported, not testable here.)
- 4.6.20 over-long addresses (> 2000 / > 500 in a search) → refused, not truncated-and-freed.
- 4.6.21 refused card → nothing opened; the card shows the whole address and the agent's reason (bounded); a dropped call takes the card down.
- 4.6.22 history / bookmark addresses shown by `search_history` are not « read » for this rule (card) — or are they free?
During a search (`navigate` on the search tab, `open_tab`, `read_pages`):
- 4.6.23 an address read in an earlier search, or outside the search (kernel-wide `seen`), is not free in this search.
- 4.6.24 a fragment the agent adds to a read address is dropped (the opened address has none); a fragment that was read is kept.
- 4.6.25 same variants as 4.6.1, 4.6.3–4.6.9 through `sessions.freeAs` (it normalises with `new URL().href`: check that every normalised-equal form is the same address for the browser too).
- 4.6.26 `read_pages` with 6 composed addresses → one card each, none read on refusal; duplicates; mixed free and composed.
- 4.6.27 the first `read_pages` with no search running (it opens the search tab) → its address needs a card.
- 4.6.28 `open_tab` during a search with the other window's token (see 4.1.8c).
- 4.6.29 the hand-over path: after `hand_over`, which addresses become free (the user's last page only?) and can the agent make that path carry an address it composed?
- 4.6.30 a redirect chain from a read page: the final address and its links become free (they were read); an address in between does not.

### C4.7 « A recap may only link to addresses read »
- 4.7.1 K: `show_recap` whose results hold an address never read → listed as unread, absent from the recap's `allowed`; `linkAllowed`/`imageAllowed` false for it.
- 4.7.2 K: variants of a read address (query added, fragment, case, userinfo) → not allowed.
- 4.7.3 K: a republish (`id`) adds an unread address → still not allowed; allowed ones of the first version stay.
- 4.7.4 K: `javascript:`, `data:`, `file:`, local, credentialed addresses that were « read » (planted in a page's links) → not allowed (`openable`).
- 4.7.5 K: an `http:` read image → not allowed as image.
- 4.7.6 K: another recap's id (guess / republish someone else's) → unknown; ids are random.
- 4.7.7 CR: the page that renders a recap (browser side) asks `linkAllowed` for every link and turns no free text into a link.

### C4.8 « hand_over » (hands control back; the agent gets nothing meanwhile)
- 4.8.1 K: `hand_over` on a tab that is not the running search tab (a user tab) → refused.
- 4.8.2 K: while the hand is open: `read_tab`, `navigate`, `capture_screen`, `search_web`, `read_pages`, `list_tabs` on the search tab → nothing of the page.
- 4.8.3 K: a second `hand_over` / a cancelled call → the first hand's state is not leaked; an abandoned hand resolves as stop.
- 4.8.4 K: after Continuer, the page the user signed in to is treated as a private source when its site is sensitive.

### C4.9 « Sensitive sites ask again during a search, once per search »
- 4.9.1 K: a tab of a sensitive site, granted earlier, read during a search → card again; refused → no content; a second read in the same search → no second card; a new search → card again.
- 4.9.2 K: history and bookmarks granted earlier, used during a search → card again, once per search.
- 4.9.3 K: evasions of `isSensitive` on the same site: trailing dot, port, userinfo, upper case, percent-encoded path segment (`/%73ettings`), `//settings`, `;` path parameter, IDN, `view-source:`, `about:reader?url=`, `blob:`.
- 4.9.4 K: `capture_screen` of a sensitive granted tab during a search → card again?
- 4.9.5 K: token switching (4.1.8b).
- 4.9.6 K: Known limit to confirm: the developer tools' reads (`read_console`, `read_network`, `run_js`…) of a sensitive tab with a dev grant during a search → no card again.
- 4.9.7 K: the card answered in one search does not carry to the next (key removed at the search's end); stop + restart of a search re-asks.

### C4.10 The research notebook (`search/notes.ts`): « only through note_lesson, once right after a lost hand-over »
- 4.10.1 K: `note_lesson` with no hand-over; after a `verification` hand-over; twice after one `lost`; after another tool call in between → refused.
- 4.10.2 K: the stamp cannot be forged by the lesson text (` · `, newlines, a fake `- date · site ·` line); length capped.
- 4.10.3 K: the notebook comes back only with the `search_web` that gives a search its goal, prefixed as hints, capped.
- 4.10.4 K: token switching: a lesson slot opened in W1 used from W2 / main, or kept open by calling other tools under another token.
- 4.10.5 C: the notebook file is read-only for `node` in the container.

## B5. « The agent cannot change its own rules »

### C5.1 « Claude's managed settings and Codex's requirements.toml are root-owned; Codex's is rewritten each session »
- 5.1.1 C: as `node`: write, append, replace (rename over), delete, chmod, chown `/etc/claude-code/managed-settings.json` and `/etc/codex/requirements.toml`; create files in `/etc/claude-code`, `/etc/codex`; replace the folders.
- 5.1.2 C: routes to root: `su`, `sudo`, setuid binaries (`find / -perm -4000`), capabilities (`CapEff`, `CapBnd`, file caps), `no_new_privs`, writable root-owned paths on root's PATH or the image (`/usr/local/bin`, `/opt/ressac`, the global `node_modules` of claude/codex).
- 5.1.3 C: the real `restrictCodex` write: content, owner, mode (not agent-writable with exec's umask 000); a symlink or file planted where its temp file goes (`requirements.toml.$$`) → cannot be planted (folder not writable).
- 5.1.4 C: env or flags that move the managed files out of root's hands for a session the kernel starts (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, a `~/.claude/settings.json`, `managed-settings.d`): can `node` make the next session read another managed file? (Only what a later kernel-started session would honour.)
- 5.1.5 C: the binaries cannot replace themselves: `claude`/`codex` and their packages root-owned, `npm i -g` fails, `PATH` of a kernel-started session (`docker exec`) does not put an agent-writable folder first (`~/.local/bin`, `/workspace/node_modules/.bin`).

### C5.2 « .ressac is mounted read-only, except logs; planted symlinks are removed before each mount »
- 5.2.1 C: as `node`: write/replace/delete files under `/workspace/.ressac` (mcp.json, profiles, sessions, instructions, the notebook); rename or replace `/workspace/.ressac` itself; remount; write through `/proc/self/root`, through a hardlink, through another path of the same mount.
- 5.2.2 C: `/workspace/.ressac/logs` is writable: plant a symlink there pointing at `.ressac/mcp.json` or `/etc/...`; does anything root or the kernel then write or read through it? (`app_log` runs `tail` in the container as node.)
- 5.2.3 K/host: `realInternal`: `.ressac` replaced by a symlink, a symlink planted directly in `.ressac` (possible only from outside the ro mount: a pre-0.1.8 container, or the workspace root if `.ressac` is absent) → removed before the mount; a symlink deeper (`.ressac/profiles/x → …`, `.ressac/instructions → …`) → removed? (Reported: the function only sweeps the top level.)
- 5.2.4 C: session config files and the main `mcp.json` are readable by `node` (Known limit to confirm), tokens of other windows' sessions through `/proc/<pid>/environ`.

### C5.3 « The kernel's own reads and writes in the workspace refuse links the agent planted » (`no-links.ts`, `confined.ts`)
- 5.3.1 host: `linkFree` and `inFolder/enter` with a symlinked folder, a symlinked parent, a folder swapped for a link between check and use (race loop), `..` names, a hardlink to a file outside.
- 5.3.2 CR: which kernel reads of the workspace do not go through them (recaps folder, widgets, actions, instructions reference) — listed, not all tested (B2/B7 own most of them).

### C5.4 The instruction-file gate (Navigateur)
- 5.4.1 C: change each watched file (`AGENTS.md`, `AGENTS.override.md`, the four guides, `~/.codex/AGENTS.md`, `~/.codex/AGENTS.override.md`, `~/.codex/config.toml`, skill trees) → `pending()` reports it, with the diff.
- 5.4.2 C: evade the comparison: a symlink at a watched path, a symlink on a parent folder, a hardlink, a file swapped back after the read, mtime reset, a too-long file whose tail changes (stated shortcut), binary/NUL content, a tree with > 500 files hiding a skill, an unreadable file (chmod 000), a fifo.
- 5.4.3 C: `config.toml` lines that pass as « Codex's own » (`CODEX_OWN_LINE`) but change instructions: `model = "…"` (stated as own), a `[projects."…"]` table with `trust_level`, a quoted key, multi-line strings, a key after an accepted table header that TOML attaches to that table (`[notice]` then `model_instructions_file=`), dotted keys.
- 5.4.4 C (real binaries, fake API on localhost in the container, no real key): what Claude Code 2.1.325 started with the kernel's Navigateur arguments actually loads that is **not watched**: `/workspace/CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, `~/.claude/CLAUDE.md`, `.claude/skills`, `.claude/commands`, `.claude/agents`, `.claude/settings.json`, `.mcp.json`, a nested `CLAUDE.md`. A planted marker that reaches the request sent to the model = a gate bypass.
- 5.4.5 C (same): the tools Claude gets in Navigateur: is there any tool that runs a command besides the removed `Bash` (the claim « has no shell »)? And which tools write files (so the agent can edit instruction files without a shell).
- 5.4.6 C (same, Codex 0.169): with the kernel's Navigateur arguments and the root `requirements.toml`: instruction sources not watched (a nested `AGENTS.md`, `project_doc_fallback_filenames`, `~/.codex/prompts`, `CODEX_HOME`), shell tool really absent, web search refused, another MCP server in `config.toml` refused by `requirements.toml`.
- 5.4.7 C: Claude reads the accepted copy of `AGENTS.md` (`.ressac/instructions/AGENTS.md`), not the live one: a live change after the card does not reach the session.
- 5.4.8 Known limits to reproduce (text exact?): Atelier has no gate; another window's running session can change guides/Codex files between card and start; the Codex writer is not gated (CR); a folder planted at a watched file path; too long/binary/unreadable shown as a marker and « Revenir » deletes it; Codex system skills accepted the first time.
- 5.4.9 C: « Revenir » (`writeInstructionFiles`) run as node: a symlinked parent, a swap between lstat and write → reaches only what `node` can already touch (stated shortcut); never writes as root.

### C5.5 « npm install scripts are off by default »
- 5.5.1 C: `npm config get ignore-scripts` as node → true; a package with a `postinstall` does not run it.
- 5.5.2 C: Known limit to reproduce: a project `.npmrc` with `ignore-scripts=false` turns them on. Also check what the sentence leaves out: `~/.npmrc`, `NPM_CONFIG_IGNORE_SCRIPTS=false`, `--ignore-scripts=false`, `npm rebuild`, `npm run`, other package managers (pnpm, yarn via corepack, npx).

## B6. Keys and relay

### C6.1 « API keys stay in the macOS keychain »
- 6.1.1 R+CR: the key never appears in what the relay sends back: response headers, 2xx bodies, error bodies (masked), the relay's log line. Upstream echoing the key in a 4xx body → masked; in a 2xx body → ? ; split/encoded (base64) echo → ?
- 6.1.2 C: nothing key-shaped in the container: env of a session (`claudeEngineEnv`, `codexEngineArgs` output: token only), `.ressac` files, `/proc`, the home volume (Known limit: subscription logins ARE there — confirm the text).
- 6.1.3 CR: the key is read from the keychain on the Mac only and cached in the host process; no file copy.

### C6.2 « The container gets a session token »
- 6.2.1 R: no token, wrong token, truncated, closed session's token → 401.
- 6.2.2 R: a token reused by another process / another window's agent while its session lives → works (a bearer token; reported), dies at `closeSession`.
- 6.2.3 R: the token from a browser page (an agent page, a site app): a cross-origin `fetch` with `Authorization` needs a preflight → the relay answers OPTIONS with no CORS header (401/405) so the browser blocks it; a « simple » POST cannot carry the token.
- 6.2.4 R: the relay listens on 127.0.0.1 only.
- 6.2.5 R: an MCP token is not a relay token and vice versa.

### C6.3 « … only for inference paths »
- 6.3.1 R: other paths with a valid token: `/v1/models`, `/v1/files`, `/v1/messages/batches`, `/v1/organizations/…`, `/api/pull` (Ollama), `/`, → 404, upstream never called.
- 6.3.2 R: path tricks: `/v1/messages/../models`, `/v1/messages/%2e%2e/models`, `//v1/messages`, `/v1/messages/`, `/V1/MESSAGES`, `/v1/messages;x`, `/v1/messages%3Fx`, `/v1/messages#x`, absolute-form request target `http://evil.example/v1/messages`, a query that tries to rewrite the path (`?x=/../../v1/models`, `?` then `#`).
- 6.3.3 R: other methods (GET, PUT, DELETE, PATCH, HEAD, OPTIONS, CONNECT), `X-HTTP-Method-Override` → not forwarded as such.
- 6.3.4 R: what an allowed path lets the agent ask the provider with the user's key (body not filtered: any model, server-side tools such as web search/fetch run by the provider) → reported as a limit to state, not tested against a real API.

### C6.4 « … only toward the engine chosen when the session opened »
- 6.4.1 R: destination by header: `Host: evil.example`, `X-Forwarded-Host`, `Forwarded`, absolute-form target, `:authority` → upstream stays the session's target.
- 6.4.2 R: the engine changes mid-session (a new session opened on another target): the old token still goes to the old target only; a `codex` token cannot use `claude` paths and gets its own kind's key only.
- 6.4.3 R: an upstream redirect (302 to evil with the key in the forwarded header) → not followed.
- 6.4.4 R: headers the agent sets that the relay must overwrite or drop: `authorization`, `x-api-key`, `cookie`, `proxy-authorization`; duplicates and case variants; does a header the agent adds reach the upstream next to the key (`anthropic-beta`, …: reported).
- 6.4.5 R: request smuggling basics through Node's parser: `Transfer-Encoding` + `Content-Length`, a second request in the body → one upstream request.
