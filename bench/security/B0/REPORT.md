# B0. Do our security tests really test? Report

Date: 2026-11-21. Worktree `Ressac-mutation`, detached at `e94539fb`. Unit tests only (vitest); no e2e, no `build:ui`, no VM.
Catalogue frozen before any mutated run: `mutations.md` sha256 `0a1f565511c245d68dc46a0a54e8fb5312789654d2e690ff62cde68398ff3b25` (`SHA256-before-run.txt`). `muts.mjs` + `run.mjs` (this folder) replay it.

## Result in one paragraph

297 hand-written mutations over 31 files. **223 are caught** by the unit tests aimed at their guard. **74 are caught by no unit test**: 21 sit in code that only runs inside Firefox (20 have an e2e test named, **not run**; one, P4, has none), and **53 survive at unit level**. Of those 53, about 11 are equivalent or cannot be seen by a unit test (constant-time compares, race-only flags, a redundant layer); **about 42, plus P4, are holes: the guard can be removed or weakened and every test that was run stays green.** The worst are in the last barrier, the agent's network proxy.

## Counts

| | n |
|---|---|
| mutations | 297 |
| caught by the targeted unit tests | 223 (one, T8, as a hang killed after 60 s, not as a failed assertion) |
| not caught by targeted tests, then caught by a wider run | 0 (one apparent catch, L6, was a timing flake: green twice on rerun) |
| e2e-only wiring, no unit test catches it, e2e **not run** | 21 (19 marked in the catalogue + W1, W4, found during the run; one of them, P4, has no e2e test either) |
| survived at unit level | 53 |
| of which likely equivalent / not observable by a unit test | 11 (B23, M4, V4, J7, J9, K4, K6, J12, L17, F11, G14) |
| of which real holes in the tests | 42 (43 with P4) |

4 mutations marked e2e in the catalogue were in fact caught by unit tests (U6, U9, U14, U15: `ui-network.test.ts` drives the observers with fakes).

## Method and its limits (read before trusting the numbers)

- Each mutation: one exact text replacement in one file, the targeted test files run (picked by file name and import grep, tests not read before the freeze), `git checkout` after. Survivors were run again with `vitest related <file>` (every test that imports the file, in the file's own package).
- **First-order, hand-picked mutations.** 297 is not exhaustive: a guard with all its mutations caught is not proven fully tested, only tested against these.
- **Unit level only.** « Caught » means a unit test with fakes goes red; it says nothing about the real build (plan rule 4). « e2e not run » means exactly that: the named e2e test probably catches it, unverified.
- The wider run stayed in the mutated file's package: a kernel survivor was not run against the whole Firefox app suite (184 s per run). The shared `localUrl` mutations (L*) did get the app's `local-guard`, `page-guard` and `sites/navigation` tests.
- Baseline before mutating: kernel 2044 passed, 1 failed (`pages/plan.test.ts › 10,000 elements in under 50 ms`, a timing test under load: ignored by the runner); app 1781 passed. The machine was loaded (another session's e2e), so single-test catches were eyeballed: all name the guard's own behaviour except L6.
- **Not mutated at all** (no claim either way): Gecko's own MAR signature check (compiled engine; only a VM update trial can test it), `workshop.Dockerfile` pins, `lima.yaml` mounts, `security-check.sh`, Claude/Codex mode flags in `kernel.ts`, `widget-frame.ts` CSP, `frame-actor.ts`, `remote-frame.ts`, `core/sites/injection.ts` (tweak sandbox), `host/site-memory.ts`, `search/notes.ts`, the relay's target binding, the extension scope check, the devtools grants.

## Survivors, ranked by how serious the unguarded behaviour is

« Smallest test » describes the assertion that would go red; nothing was written into the repo.

### 1. The agent's network proxy (last barrier): `packages/kernel/docker/ressac-network.mjs`

| id | what can be removed with tests green | smallest test that would catch it |
|---|---|---|
| **K17** | the allowlist check on **plain HTTP**: `GET http://any-host/` is forwarded | in `network-module.test.ts`, plain-HTTP request through `createProxy` to a host not in the list → 403 (today only the port and relative-URI refusals are asserted) |
| **K3** | exact match → suffix match: `evilgithub.com` passes for `github.com` | `allowed("evilgithub.com", ["github.com"]) === false` and `allowed("xgithub.com", …)` |
| **K21** | the shipped proxy's default (`localOk = false`): the real proxy runs with no private-address check | call `createProxy(getDomains)` **with no options** and assert a name resolving to 127.0.0.1 is refused (today's test seems to pass the option itself) |
| **K5** | the final `-A OUTPUT -j REJECT`: ICMP and any non-TCP/UDP protocol leaves | `rules(…)` contains the three REJECT lines, the catch-all last (the test fails only when all three go: K8) |
| K12, K13 | 100.64.0.0/10 and `::ffff:a.b.c.d` no longer private for the proxy | add `100.64.0.1` and `::ffff:127.0.0.1` to the `localAddress` table test |
| K4, K6 | tcp / udp reject lines (the catch-all still rejects: near-equivalent, only the reject type changes) | same `rules` test as K5 |

### 2. Updates

| id | what can be removed | smallest test |
|---|---|---|
| **P4** | `stale(phase, staged)` in `chrome/store/updates.ts`: an old signed MAR offered under a new number is installed. **No unit test and no e2e**: `update.e2e.ts` sets the state through `RESSAC_TEST_UPDATE`, which returns before `decide`. The pure helper is tested (P5 caught), its use is not | extract `decide` (phase, version, staged → drop or show) as a pure function in `core/update.ts` and assert « ready, version 9.9.9, staged 0.1.0 → dropped » |
| P8 | `package.sh`: a MAR whose signature does not verify is kept (publish checks again: P6 is caught) | in `scripts.test.ts`, assert the `signmar -v` line ends in `fail`, or run the block with a fake failing `signmar` as `publish.test.ts` does |

### 3. Kernel fetch for widgets, actions, workflows; shared `localUrl` (also used by recaps, site apps, agent pages, invisible reads)

| id | what can be removed | smallest test |
|---|---|---|
| **L2, L3, L4, L6, L7, L8** | 10/8, 169.254/16 (cloud metadata), 172.16/12, 100.64/10, ≥224, 0/8 are « not local » | one table test of `localUrl`: each range's first and last address true, its neighbours false (only 127/8, 192.168/16, `::1`, `localhost.`, `.local` are pinned today) |
| **L9, L10, L11, L12** | `::ffff:`, `64:ff9b:`, `fc/fd`, `fe80` IPv6 forms | same table: `[::ffff:127.0.0.1]`, `[64:ff9b::7f00:1]`, `[fd00::1]`, `[fe80::1]` |
| L23 | « one local address among several refuses » → only the first address is looked at | `lookupWithoutLocal` with a fake `dns.lookup` returning `[public, 127.0.0.1]` → error |
| L18 | `checkUrl`'s http(s)-only line (the fetch itself fails on other schemes, but `checkPage` and callers rely on it) | `checkUrl("file:///etc/passwd", null, false)` throws |
| L26, L27, L28 | redirect cap 5 → 50; 5 MB cap on the stream and on content-length | a local server redirecting 6 times → « Trop de redirections »; one streaming 5 MB + 1 without content-length → refused |
| L17 | lowercase in `localUrl` (callers pass URL hostnames, already lowercase: likely equivalent) | `localUrl("LOCALHOST")` |

### 4. What the agent can reach in the browser

| id | what can be removed | smallest test |
|---|---|---|
| **G17** | opaque origins (`data:`, `about:blank`, `file:`) become the shared origin « null »: one grant covers every such tab | `policy.grant(tab data:…)` then `canRead` of that tab and of another `about:blank` tab are both false |
| **Q5** | agent pages: a user gesture frees **any** request, not only a top-level navigation (fetch / beacon to the web after one click) | `agentPageDecision({document: false, gesture: true, to: "https://evil.example", method: "POST"})` → cancel |
| **N9** | the four `guides/*.md` are not watched: the agent rewrites them with no card | `pending("claude")` after changing `guides/widgets.md` on the fake disk reports one change |
| G4 | `allow()` gives a site-app window an origin permission (`canRead` still refuses it: second layer) | after `userInteraction(siteAppTab)`, `state()[id]?.read` is not true |
| G18 | a site app served locally is marked « built » and gets the default dev rights in the policy (`devRights` still needs the grant) | `built(siteTab on localhost:5300)` then `isBuilt` false |
| G14 | dev rights tied to their origin in `rightsOf` (`leaveOrigin` already deletes them: likely equivalent) | grant on origin A, read `devRights` for the same id at origin B without calling `tabNavigated` |
| H3, H10 | sensitive sites: `mail.google.com.` (trailing dot) and `/Settings` (path case) are not sensitive | two more rows in `sensitive.test.ts` |
| D4 | a recap link may carry `user:password@` | publish with a seen `https://u:p@host/` then open it → refused |
| B24, M5 | MCP server and design server listen on `0.0.0.0` by default (the token still guards) | after start, `server.address().address === "127.0.0.1"` |
| M6 | design server: a capture name like `../../x.png` is read from disk | `renderBatches` with `capture: "../x.png"` never calls `readCapture` |
| Q10 | agent pages: an unparsable target address passes | `agentPageDecision({to: "::::"})` → cancel |

### 5. Workspace file work: `no-links.ts`, `confined.ts`

| id | what can be removed | smallest test |
|---|---|---|
| J3 | `enter`: a folder name `..` or `a/b` walks out (callers validate names today) | `inFolder(top, [".."], …)` → null |
| J10 | `moveEntry` through a symlinked parent | parent replaced by a link to another folder → « refused » |
| J13 | a file that grew past the cap between lstat and read is cut, not refused | hard without a hook; a fifo or a file appended by a second process during the read |
| I2 | `linkFree` on a missing folder answers true | `linkFree(root, root + "/absent") === false` |
| J7, J9 | `O_NOFOLLOW` on the read, `O_EXCL\|O_NOFOLLOW` on the temp write: race-only, the lstat before still guards | not testable deterministically; keep as defence in depth |
| J12 | lstat size check (the read loop caps again: equivalent) | none needed |

### 6. Telemetry

| id | what can be removed | smallest test |
|---|---|---|
| O11 | the error **type** is not scrubbed | `errorEnvelope({type: "https://a.example/x"})` has no address |
| R5 | `RESSAC_TEST_PUBLIC_ADDRESSES` honoured outside automation (needs the environment, so low) | with `Services` faked and `automated()` false, `localLiteral("127.0.0.1")` stays true |

### 7. Constant-time compares: B23, M4, V4

Replacing `timingSafeEqual` by `Buffer.equals` changes no answer: no unit test can see it. SECURITY.md's « checked in constant time » is true by reading the code only. A cheap guard: a test that greps the three files for `timingSafeEqual` (as `scripts.test.ts` does for shell lines), or accept it as review-only.

## e2e-only: no unit test catches it, e2e named, **not run (e2e)**

| ids | guard | e2e test that should catch it |
|---|---|---|
| Q11, Q12, Q13 | agent page guard wiring (every principal, sandboxed frame, the cancel) | `agent-page-guard.e2e.ts` › « an agent page's image, fetch and navigation never reach the web », « …service worker never reaches the web », « a beacon … never reaches the web ». **No test names a sandboxed iframe (Q12): likely uncovered** |
| Q14 | dead proxy before a WebSocket's DNS | `agent-page-guard.e2e.ts` › « an agent page's request or WebSocket to a public name is cancelled before its DNS lookup » |
| R6, R7, R8, R9, R10 | invisible reads' observer | `invisible.e2e.ts` › « reads a public page but its frame, image and fetch to localtest.me never reach the trap », « a redirect to localtest.me is refused », « a beacon sent on pagehide never reaches the trap » (R9), « a service worker fetch after the read never reaches the trap » (R8), « a redirect outside the allowed domains stops the read » (R10) |
| S7, S9, S10, S12 | site apps' request guard and view policy | `sites-navigation.e2e.ts` › « a link to pub.localhost is not followed… », « ten window.open to pub.localhost… », « window.open to the sign-in domain: … opening nothing », « loads in the app view that are not http(s) are refused… » |
| S8 | a closed app's container loads nothing | `sites-navigation.e2e.ts` › « reopened before the closed window unloads… » or `sites-window.e2e.ts` › « closing the app window closes its sign-in windows… »: **no test name states it; possibly uncovered** |
| S11 | the view under the card loads nothing | `sites-grant.e2e.ts` › « first open of an app with tweaks: … the site view is hidden and loads nothing » |
| O15, O16, O17 | nothing before the notice; crash reports' own switch; only our chrome's errors | `telemetry.e2e.ts` › « before the notice has shown, neither error reports nor crash reports go out… », « chrome error: our chrome's errors are sent scrubbed, a web page's are not » |
| W1, W4 | private tabs never read; private mirror | `agent.e2e.ts` › « private space: the tab disappears from list_tabs, read_tab / capture_screen / current_page answer PRIVATE_TEXT… » |

Also in chrome-only code, with **no e2e test found by name** (W2, W3 counted in the 53 survivors, P4 in the 21): **W2, W3** (`bridge.ts`: the origin is re-checked before and after a read; `test/agent/bridge.test.ts` does not import `chrome/agent/bridge.ts`), and P4 (above). Smallest test for W2/W3: an e2e where the tab is navigated to another origin between the kernel's check and the read (a slow page + `navigate`), expecting « site changed » and no text.

## What held (every mutation caught)

Exact-address memory `seen.ts` (5/5) · the address rule, cards, consent and outflow wiring in `mcp/server.ts` (23/25; the two left are the constant-time compare and the listen address) · search sessions' free-address and fragment rules (2/2) · secret detection `detect.ts` (18/18) · outflow rules `outflow.ts` (12/13, F11 likely equivalent) · instruction gate in `kernel.ts` (5/5) and `instructions.ts` (8/9) · telemetry scrubbing in `shared/telemetry.ts` (13/14) · publish checks (4/4) · site-app decisions `navigation.ts` + `hostInSite` (6/6) · site frames (9/9, one as a hang) · UI network (15/15) · relay token, paths, method, dropped headers (4/5, constant time left) · container flags and the direct-connection probe in `workshop.ts` (12/12) · design server Origin, Host, token (4/7).

## Full table

| id | guard | mutation lets through | result |
|---|---|---|---|
| A1 | seen.ts exact-address | has() says yes to any address | caught (17): mcp/seen.test.ts › a fragment is dropped when added, never when checked |
| A2 | seen.ts fragment rule | has() ignores a fragment the agent added (P#<data> free) | caught (1): mcp/seen.test.ts › a fragment is dropped when added, never when checked |
| A3 | seen.ts web-only | any scheme is remembered as read | caught (1): mcp/seen.test.ts › only http(s) addresses of at most 2000 characters |
| A4 | seen.ts length cap | addresses over 2000 chars are remembered | caught (1): mcp/seen.test.ts › only http(s) addresses of at most 2000 characters |
| A5 | seen.ts memory bound | the set grows without bound (memory, not a leak) | caught (1): mcp/seen.test.ts › beyond the limit the oldest goes, unless has touched it |
| B1 | server.ts composed address (outside search) | any composed address opens without a card | caught (10): mcp/server.test.ts › navigate to https://pub.example: navigationOutsideSite, no tab opened; to /film/2 of the site: done |
| B2 | server.ts address card denial | a refused address card still opens the address | caught (1): mcp/server.test.ts › outside a search, a composed address asks its card once per conversation; refused, nothing opens; read, local or a readable tab's address is free |
| B3 | server.ts links of agent-written pages | links of a local page / site app (agent-written) count as read | caught (2): mcp/server.test.ts › site app: a link read in its view counts as written (its tweaks put it there): navigate by link asks, nothing becomes free |
| B4 | server.ts navigate link from a local page | a numbered link of the agent's own local page navigates without a card | caught (1): mcp/server.test.ts › outside a search, a composed address asks its card once per conversation; refused, nothing opens; read, local or a readable tab's address is free |
| B5 | server.ts site-app navigate, composed address | a site app navigates to an agent-composed address on its domains without a card | caught (2): mcp/server.test.ts › navigate to https://pub.example: navigationOutsideSite, no tab opened; to /film/2 of the site: done |
| B6 | server.ts site-app navigate, domains | the kernel lets a site app be navigated off its domains (browser guard remains) | caught (2): mcp/server.test.ts › navigate to https://pub.example: navigationOutsideSite, no tab opened; to /film/2 of the site: done |
| B7 | server.ts search link rule, open_tab | during a search open_tab opens any address without a card | caught (1): mcp/server.test.ts › open_tab during a search asks the card for an address not read (with its reason); local and read addresses ask nothing |
| B8 | server.ts search link rule, navigate | the search tab navigates to any address without a card | caught (13): mcp/server.test.ts › navigate on the search tab to a link read is done; to another address it is refused |
| B9 | server.ts search link rule, read_pages | read_pages reads any address without a card | caught (10): mcp/server.test.ts › read_pages: a composed address among them asks its card; refused, the others are still read |
| B10 | server.ts search address card denial | a refused address card during a search still navigates | caught (4): mcp/server.test.ts › navigate on the search tab to a composed address, refused: DENIAL_TEXT and nothing loads |
| B11 | server.ts http(s) only | open_tab / navigate accept any scheme (file:, javascript:, about:) | caught (2): mcp/server.test.ts › open_tab and navigate refuse non-http(s) URLs |
| B12 | server.ts readable-tab address | the address of any open tab, even one the agent may not read, is free | caught (1): mcp/server.test.ts › outside a search, a composed address asks its card once per conversation; refused, nothing opens; read, local or a readable tab's address is free |
| B13 | server.ts outflow query pause | a search query is never checked for secrets / read data | caught (9): mcp/server.test.ts › a request dropped during an outflow pause puts the band back and the next search_web runs |
| B14 | server.ts outflow red line | an address card never shows its red line | caught (5): mcp/server.test.ts › a composed address carrying read data gets a danger line, outside and during a search; the card still decides |
| B15 | server.ts sensitive tab re-ask | a sensitive tab granted earlier is read during a search with no new card | caught (1): mcp/server.test.ts › a sensitive tab asks again once per search, and not outside one |
| B16 | server.ts history re-ask in a search | history/bookmarks granted earlier are read during a search with no new card | caught (1): mcp/server.test.ts › history asks again once per search |
| B17 | server.ts history card | history and bookmarks are read with no card at all | caught (1): mcp/history.test.ts › history is read only after the card: refused → nothing read; accepted → one card for the conversation, asked again in the next |
| B18 | server.ts tab read consent | read_tab / current_page read any tab with no consent | caught (21): mcp/server.test.ts › current_page without interaction → request, refusal → normal answer |
| B19 | server.ts grant bound to the site seen | a grant given while the tab changed site is used for the new site | caught (2): mcp/server.test.ts › private space during the question: « Autoriser » does not deliver the tab |
| B20 | server.ts outflow memory of tab reads | what the agent reads in a tab is never remembered (rule 2 blind for tabs) | caught (8): mcp/server.test.ts › search_web with data read in a granted tab pauses and names its source |
| B21 | server.ts shared-tab exemption vs sensitive | a sensitive tab the user spoke from is not remembered either | caught (1): mcp/server.test.ts › a shared tab that is not sensitive is not a source; a shared sensitive one is |
| B22 | MCP bearer token | any or no token is accepted | caught (4): mcp/server.test.ts › without a token or with a wrong token → 401 |
| B23 | MCP bearer token, constant time | comparison no longer constant-time (same answers, timing leak) | **SURVIVED** |
| B24 | MCP server listens on localhost | the MCP server listens on every interface by default | **SURVIVED** |
| B25 | server.ts search-tab sensitive page remembered | a signed-in sensitive page read on the search tab is not remembered | caught (1): mcp/server.test.ts › a sensitive page on the search tab (a sign-in the user did) is a source |
| C1 | sessions.ts free address | every address is free during a search | caught (23): mcp/server.test.ts › a second search_web reuses the tab (navigate, no new tab) and keeps the search |
| C2 | sessions.ts added fragment dropped | a fragment the agent added to a read address is kept (data to the page's script) | caught (3): mcp/server.test.ts › a fragment the agent adds to a link read is dropped: navigate and read_pages open the address read, and say so |
| D1 | recap links only to read addresses | a recap may link to any address | caught (4): mcp/server.test.ts › recaps show_recap publishes, opens in the session window and updates in place |
| D2 | recap open, allowed set | opening from a recap accepts any web address | caught (1): recaps/recaps.test.ts › publish without id creates the file; links never seen and local addresses are not allowed |
| D3 | recap open, local addresses | a recap link may point to a local address | caught (1): recaps/recaps.test.ts › publish without id creates the file; links never seen and local addresses are not allowed |
| D4 | recap open, credentials | a recap link may carry user:password@ | **SURVIVED** |
| E1 | detect.ts findSecrets | no secret is ever found | caught (22): mcp/server.test.ts › a request dropped during an outflow pause puts the band back and the next search_web runs |
| E2 | detect.ts decodings | a secret in base64, hex or URL-encoding is missed | caught (2): outflow/detect.test.ts › encoded secrets are found |
| E3 | detect.ts Luhn checksum | any issuer-shaped number counts as a card (false pauses; checksum claim) | caught (1): outflow/detect.test.ts › card: Luhn-valid only |
| E4 | detect.ts cards | card numbers are not detected | caught (4): outflow/detect.test.ts › card: Luhn-valid only |
| E5 | detect.ts IBAN | IBANs are not detected | caught (9): outflow/detect.test.ts › iban: valid check digits only |
| E6 | detect.ts NIR | social security numbers are not detected | caught (3): outflow/detect.test.ts › nir: valid key only |
| E7 | detect.ts JWT | login tokens (JWT) are not detected | caught (1): outflow/detect.test.ts › api keys, private keys and JWTs |
| E8 | detect.ts private key | private keys are not detected | caught (3): outflow/detect.test.ts › api keys, private keys and JWTs |
| E9 | detect.ts API keys | access keys are not detected | caught (7): mcp/server.test.ts › search_web with a secret pauses before the engine, first query and a later one; Continuer sends it unchanged |
| E10 | detect.ts random tokens | unknown high-entropy tokens are not detected | caught (3): outflow/detect.test.ts › random: long, mixed and high-entropy |
| E11 | detect.ts NFKC folding | full-width digits / compatibility forms hide a number | caught (1): outflow/detect.test.ts › numbers spaced as French pages print them are still found |
| E12 | detect.ts hex decoding | a hex-encoded secret is missed | caught (2): outflow/detect.test.ts › encoded secrets are found |
| E13 | detect.ts base64 decoding | a base64-encoded secret is missed | caught (3): outflow/detect.test.ts › encoded secrets are found |
| E14 | detect.ts URL decoding | a percent-encoded secret is missed | caught (3): outflow/detect.test.ts › encoded secrets are found |
| E15 | detect.ts double encoding | a secret encoded twice (base64 of base64, hex of base64) is missed | caught (1): outflow/detect.test.ts › nested encodings |
| E16 | detect.ts mask | the caught secret is shown whole in the pause / red line | caught (4): outflow/detect.test.ts › mask |
| E17 | detect.ts IBAN checksum | any IBAN-shaped string counts (false pauses; checksum claim) | caught (1): outflow/detect.test.ts › iban: valid check digits only |
| E18 | detect.ts NIR checksum | any NIR-shaped number counts (false pauses; checksum claim) | caught (1): outflow/detect.test.ts › nir: valid key only |
| F1 | outflow.ts check | nothing leaving is ever flagged | caught (47): mcp/server.test.ts › a request dropped during an outflow pause puts the band back and the next search_web runs |
| F2 | outflow.ts rule 2 (read data coming back) | read e-mails, phones, numbers, ids are never caught coming back | caught (40): mcp/server.test.ts › search_web with data read in a granted tab pauses and names its source |
| F3 | outflow.ts typed text forgotten per conversation | what the user typed in an earlier conversation stays free to send | caught (1): outflow/outflow.test.ts › forgetTyped clears what was typed, not what was read |
| F4 | outflow.ts followable links only from the user's sources | an address in a tool output the agent writes becomes a followed link (never flagged) | caught (2): mcp/server.test.ts › an address shown by a page the agent writes (local page) is not a followed link: its card keeps the red line |
| F5 | outflow.ts rule 2 through encodings | read data sent back in base64 / hex / URL-encoding is missed | caught (1): outflow/outflow.test.ts › read e-mail comes back encoded |
| F6 | outflow.ts rule 2 across path segments | read data split across URL path segments is missed | caught (3): outflow/outflow.test.ts › any separator between digits is ignored |
| F7 | outflow.ts e-mails remembered | read e-mail addresses are not remembered | caught (18): mcp/server.test.ts › search_web with data read in a granted tab pauses and names its source |
| F8 | outflow.ts phones remembered | read phone numbers are not remembered as phones | caught (4): outflow/outflow.test.ts › read phone numbers come back without separators |
| F9 | outflow.ts long numbers remembered | read long numbers are not remembered | caught (16): mcp/server.test.ts › what list_tabs returned is a source, named « tes onglets »; without an outflow nothing pauses |
| F10 | outflow.ts identifiers remembered | read identifiers are not remembered | caught (7): outflow/outflow.test.ts › a word glued to a number from a read token does not hit, a mixed chunk does |
| F11 | outflow.ts norm NFKC | full-width / compatibility forms dodge the comparison | **SURVIVED** |
| F12 | outflow.ts typed exemption scope | rule 1 exempts every secret once the window has any state | caught (4): outflow/outflow.test.ts › read item comes back |
| F13 | outflow.ts whole-address exemption only for addresses | rule 2 never applies to an address the agent opens | caught (8): mcp/server.test.ts › an address shown by a page the agent writes (local page) is not a followed link: its card keeps the red line |
| G1 | policy.ts canRead | every tab is readable | caught (25): access/policy.test.ts › no access by default |
| G2 | policy.ts one origin per permission | a permission holds for the tab whatever its origin | caught (2): access/policy.test.ts › the current URL counts even without a navigation event |
| G3 | policy.ts site app read by its grant only | a site app is readable through a tab permission on the same origin | caught (14): access/policy.test.ts › accorderLectureSite("vidola") : peutLire de site:vidola vrai, de site:youtube faux ; nouvelle conversation : faux |
| G4 | policy.ts allow() never for a site app | a site app window gets an origin permission | **SURVIVED** |
| G5 | policy.ts user navigation lapses the permission | the permission survives the user changing site | caught (1): access/policy.test.ts › The user changes site → authorization lapsed, even if they come back |
| G6 | policy.ts agent navigation keeps access on the same site only | the agent navigates a granted tab to another site and keeps read access | caught (2): access/policy.test.ts › the agent navigates its demo to an outside site → access lost |
| G7 | policy.ts tab opened by the agent | any tab the agent opens is readable at once (Gmail, bank) | caught (3): access/policy.test.ts › the agent opens Gmail itself → no access without a request |
| G8 | policy.ts demo port range | any local port counts as the agent's demo (the user's dev server, an admin page) | caught (3): access/policy.test.ts › built: app:<folder> and localhost:5285 opened by the agent have the four rights; localhost:3000 has none |
| G9 | policy.ts reset clears permissions | tab permissions survive a new conversation | caught (1): access/policy.test.ts › reinitialiser removes everything; tabClosed removes the tab |
| G10 | policy.ts reset clears data grants | history, address and widget grants survive a new conversation | caught (4): mcp/history.test.ts › history is read only after the card: refused → nothing read; accepted → one card for the conversation, asked again in the next |
| G11 | policy.ts reset clears site grants | site app grants survive a new conversation | caught (4): access/policy.test.ts › accorderLectureSite("vidola") : peutLire de site:vidola vrai, de site:youtube faux ; nouvelle conversation : faux |
| G12 | policy.ts site grant bound to the declaration hash | a site app whose declaration changed after the card stays granted | caught (7): access/policy.test.ts › reading of a site app tied to the hash of its declaration: another hash does not count |
| G13 | policy.ts dev rights lapse on origin change | run_js / console rights are kept in memory after the tab changes origin | caught (2): access/policy.test.ts › accorderDev: only the checked rights; they drop on site change, on close, on reinitialiser |
| G14 | policy.ts dev rights valid for one origin | run_js granted on one origin is valid on any origin of that tab | **SURVIVED** |
| G15 | policy.ts no dev rights on an ungranted site app | dev rights on a site app without its grant | caught (3): access/policy.test.ts › site app: its dev rights are only valid with its grant; a new conversation removes both |
| G16 | policy.ts cut removes read | the user's cut leaves read access | caught (1): access/policy.test.ts › couper(id, "agir") removes that right only; couper(id) removes everything, reading included; a built one that is cut stays so until reinitialiser |
| G17 | policy.ts opaque origins | data:, about:blank, file: tabs all share the origin 'null': one grant covers them all | **SURVIVED** |
| G18 | policy.ts site app never 'built' | a site app served locally gets the default dev rights of a built page | **SURVIVED** |
| G19 | policy.ts deleted site app loses its grant | an app recreated with the same id is read without a new card | caught (2): access/policy.test.ts › retirerLectureSite (app deleted): the grant drops, the badge follows; pending cards see it (siteReadWithdrawals) |
| G20 | policy.ts address approved | every address counts as approved earlier | caught (10): mcp/server.test.ts › navigate to https://pub.example: navigationOutsideSite, no tab opened; to /film/2 of the site: done |
| G21 | policy.ts built mark lapses on origin change | the 'built' mark stays in memory after the tab leaves its origin | caught (1): access/policy.test.ts › built: leaving the origin removes the rights; navigating back to it (agent) restores them |
| H1 | sensitive.ts host list | listed mail / bank / payment hosts are not sensitive | caught (14): access/sensitive.test.ts › sensitive: https://outlook.live.com/mail/ |
| H2 | sensitive.ts subdomains | a subdomain of a listed host (www.paypal.com) is not sensitive | caught (8): access/sensitive.test.ts › sensitive: https://www.labanquepostale.fr/particuliers |
| H3 | sensitive.ts trailing dot | 'mail.google.com.' is not sensitive | **SURVIVED** |
| H4 | sensitive.ts wrappers | view-source:, blob: and reader view of a sensitive page are not sensitive | caught (5): access/sensitive.test.ts › sensitive: view-source:https://mail.google.com/ |
| H5 | sensitive.ts nesting fails closed | deep wrapper nesting is judged not sensitive | caught (1): access/sensitive.test.ts › sensitive: view-source:view-source:view-source:view-source:https://www.marmiton.org/x |
| H6 | sensitive.ts account path segments | /settings, /account, /login pages are not sensitive | caught (1): access/sensitive.test.ts › sensitive: https://github.com/settings/tokens |
| H7 | sensitive.ts webmail on its own host | mail.* / webmail.* hosts are not sensitive | caught (4): access/sensitive.test.ts › sensitive: https://mail.ovh.net/owa/ |
| H8 | sensitive.ts about:logins | about:logins is not sensitive | caught (5): access/sensitive.test.ts › sensitive: about:logins |
| H9 | sensitive.ts Slack workspaces | Slack workspaces are not sensitive | caught (2): access/sensitive.test.ts › sensitive: https://app.slack.com/client/T04KQ2M7H/C05RT9XPL |
| H10 | sensitive.ts path case | /Settings or /LOGIN is not sensitive | **SURVIVED** |
| H11 | sensitive.ts unparsable address | (reverse) an unreadable address becomes sensitive: checks the fail-open default is pinned | caught (2): access/sensitive.test.ts › not sensitive: not a url |
| I1 | no-links.ts linkFree | a folder reached through a planted symlink is accepted | caught (1): profiles/config-mcp.test.ts › writeMcpConfig never follows a link planted by the agent: the target file stays as it was |
| I2 | no-links.ts missing folder | a missing or unreadable folder counts as link-free | **SURVIVED** |
| J1 | confined.ts enter: folder is not a link | enter() follows a symlinked folder | caught (11): container/workshop.test.ts › stageHarvest copies the code files into .ressac, and refuses a widget folder swapped for a link |
| J2 | confined.ts enter: same inode after chdir | a folder swapped for a link between lstat and chdir is entered (race) | caught (1): workspace/confined.test.ts › a folder swapped for a link between its lstat and the chdir is refused: by enter, by readFiles, before a write |
| J3 | confined.ts enter: names | '..' or 'a/b' as a folder name walks out | **SURVIVED** |
| J4 | confined.ts readFiles: path parts | '../x' as a file path reads outside the folder | caught (1): workspace/confined.test.ts › readFiles: reads by bare names; absent, link, .., over a file's or the total cap are reported |
| J5 | confined.ts readFiles: intermediate folder is not a link | a symlinked sub-folder is followed on the way to a file | caught (6): design/remarks.test.ts › Remarks remarques folder, of a project or of a batch set as a symbolic link (the container writes there): nothing is written at the end of the link |
| J6 | confined.ts readFiles: file is not a link (lstat) | lstat check on the file gone (O_NOFOLLOW still there) | caught (3): container/workshop.test.ts › stageHarvest copies the code files into .ressac, and refuses a widget folder swapped for a link |
| J7 | confined.ts readFiles: O_NOFOLLOW | a file swapped for a link after lstat is followed (race) | **SURVIVED** |
| J8 | confined.ts readFiles: link file (both checks) | a symlinked file is read (/etc/passwd, ~/.ssh) | caught (5): applications/manifest.test.ts › a linked manifest is never followed: no read, no write, no endless read of a device |
| J9 | confined.ts writeEntries: temp O_EXCL\|O_NOFOLLOW | a pre-planted link at the temp name is written through (needs guessing 4 random bytes) | **SURVIVED** |
| J10 | confined.ts moveEntry: parent is not a link | moveEntry works through a symlinked parent | **SURVIVED** |
| J11 | confined.ts moveEntry: entry is a real folder | moveEntry renames a link or a file | caught (1): design/remarks.test.ts › Remarks a project or batch folder that is a link: nothing read, deleted or purged at its end |
| J12 | confined.ts readFiles: size cap | (the read loop still caps at max+1) lstat size check gone | **SURVIVED** |
| J13 | confined.ts readFiles: grown file refused | a file that grew past max since lstat is cut, not refused | **SURVIVED** |
| K1 | network: allowlist match | the proxy lets every host through | caught (2): container/network-module.test.ts › allowed base, wildcard, refusal, trailing dot |
| K2 | network: wildcard needs the dot | '*.example.com' also matches evilexample.com | caught (1): container/network-module.test.ts › allowed base, wildcard, refusal, trailing dot |
| K3 | network: exact host match | 'github.com' also matches evilgithub.com | **SURVIVED** |
| K4 | network: iptables tcp reject | (final REJECT remains) tcp-reset line gone | **SURVIVED** |
| K5 | network: iptables final reject | ICMP and other protocols leave the container | **SURVIVED** |
| K6 | network: iptables udp reject | (final REJECT remains) udp line gone | **SURVIVED** |
| K7 | network: Mac reachable on given ports only | every port of the Mac is reachable from the container | caught (1): container/network-module.test.ts › rules |
| K8 | network: all three rejects | the container's outbound network is fully open | caught (1): container/network-module.test.ts › rules |
| K9 | network: proxy refuses private addresses | an allowed name resolving to the Mac / LAN / router is connected to | caught (1): container/network-module.test.ts › proxy an allowed name that resolves to a local address is refused, by CONNECT and by plain HTTP |
| K10 | network: 192.168/16 private | 192.168.x.x is not private for the proxy | caught (1): container/network-module.test.ts › proxy localAddress: private, loopback, link-local and mapped ones; public ones pass |
| K11 | network: 169.254/16 link-local | link-local (cloud metadata) is not private for the proxy | caught (1): container/network-module.test.ts › proxy localAddress: private, loopback, link-local and mapped ones; public ones pass |
| K12 | network: 100.64/10 CGNAT | 100.64.x.x (Tailscale, CGNAT) is not private for the proxy | **SURVIVED** |
| K13 | network: IPv4-mapped IPv6 | ::ffff:127.0.0.1 is not private for the proxy | **SURVIVED** |
| K14 | network: IPv6 unique-local | fc00::/7 is not private for the proxy | caught (1): container/network-module.test.ts › proxy localAddress: private, loopback, link-local and mapped ones; public ones pass |
| K15 | network: CONNECT ports | CONNECT to any port of an allowed host (ssh on github.com:22) | caught (1): container/network-module.test.ts › proxy refused host and refused port get 403; a reset client does not kill the proxy |
| K16 | network: CONNECT host check | CONNECT to any host on 443/80 | caught (1): container/network-module.test.ts › proxy refused host and refused port get 403; a reset client does not kill the proxy |
| K17 | network: plain HTTP host check | plain HTTP to any host | **SURVIVED** |
| K18 | network: plain HTTP port check | (the request still goes to httpPort) port check on the asked URL gone | caught (1): container/network-module.test.ts › proxy plain-HTTP forward: non-80 port and relative URI get 403 |
| K19 | network: domain syntax, IP literal | an IP address is accepted as an allowed 'domain' | caught (4): container/network-module.test.ts › validDomain refuses "1.2.3.4" |
| K20 | network: domain syntax, two labels | '*.com' or 'localhost' is accepted as an allowed domain | caught (5): container/network-module.test.ts › validDomain refuses "example" |
| K21 | network: guarded lookup is the default | the real proxy runs without the private-address check | **SURVIVED** |
| K22 | network: 127/8 and 10/8 | 10.x.x.x is not private for the proxy | caught (1): container/network-module.test.ts › proxy localAddress: private, loopback, link-local and mapped ones; public ones pass |
| K23 | network: trailing dot / case of the asked host | (reverse: stricter) 'GitHub.com.' no longer matches; checks normalisation is pinned | caught (1): container/network-module.test.ts › allowed base, wildcard, refusal, trailing dot |
| L1 | access.ts localUrl 127/8 | 127.x.x.x is not local | caught (6): recaps/recaps.test.ts › publish without id creates the file; links never seen and local addresses are not allowed |
| L2 | access.ts localUrl 10/8 | 10.x.x.x is not local | **SURVIVED** |
| L3 | access.ts localUrl 169.254/16 | 169.254.x.x (cloud metadata) is not local | **SURVIVED** |
| L4 | access.ts localUrl 172.16/12 | 172.16-31.x.x is not local | **SURVIVED** |
| L5 | access.ts localUrl 192.168/16 | 192.168.x.x is not local | caught (1): workflows/run.test.ts › executerWorkflow: web search and open reads chercherWeb drops results to a local address, then cuts to nombre |
| L6 | access.ts localUrl 100.64/10 | 100.64.x.x is not local | **SURVIVED** |
| L7 | access.ts localUrl multicast / reserved | 224.0.0.0 and above are not local | **SURVIVED** |
| L8 | access.ts localUrl 0/8 | 0.0.0.0 is not local | **SURVIVED** |
| L9 | access.ts localUrl IPv4-mapped IPv6 | [::ffff:127.0.0.1] is not local | **SURVIVED** |
| L10 | access.ts localUrl NAT64 | 64:ff9b:: (NAT64 of an IPv4) is not local | **SURVIVED** |
| L11 | access.ts localUrl IPv6 unique-local | fc00::/7 is not local | **SURVIVED** |
| L12 | access.ts localUrl IPv6 link-local | fe80::/10 is not local | **SURVIVED** |
| L13 | access.ts localUrl ::1 | [::1] is not local | caught (1): workflows/run.test.ts › executerWorkflow: web search and open reads chercherWeb drops results to a local address, then cuts to nombre |
| L14 | access.ts localUrl trailing dot | 'localhost.' is not local | caught (1): local-guard.test.ts › literal 127.0.0.1, [::1], localhost., box.local are local without resolving |
| L15 | access.ts localUrl local names | x.local, x.internal, x.home.arpa are not local | caught (1): workflows/run.test.ts › executerWorkflow: web search and open reads chercherWeb drops results to a local address, then cuts to nombre |
| L16 | access.ts localUrl localhost | localhost is not local | caught (2): widgets/harvest.test.ts › runHarvest recuperer: « localhost. » (trailing dot) is a local address, refused |
| L17 | access.ts localUrl case | 'LOCALHOST' is not local (when the caller did not lowercase) | **SURVIVED** |
| L18 | access.ts checkUrl http(s) only | file:, ftp:, data: accepted by the URL check | **SURVIVED** |
| L19 | access.ts checkUrl no credentials | user:password@ addresses accepted | caught (1): widgets/harvest.test.ts › runHarvest recuperer: http(s) only, without credentials in the URL |
| L20 | access.ts checkUrl declared domains | a widget fetches any domain, declared or not | caught (11): widgets/harvest.test.ts › runHarvest widget without an account: lirePage with an account is refused |
| L21 | access.ts checkUrl local refused | a widget fetches local addresses by literal | caught (2): widgets/harvest.test.ts › runHarvest recuperer: a local address is refused by default |
| L22 | access.ts lookup refuses a local resolution | a public name resolving to 127.0.0.1 (rebinding) is fetched | caught (1): workflows/run.test.ts › executerWorkflow: web search and open reads recuperer: a name that resolves to the machine is refused at connection, without a request |
| L23 | access.ts lookup: any local address refuses | a name with one public and one local address passes | **SURVIVED** |
| L24 | access.ts fetch uses the guarded lookup | the fetch connects without the resolution check | caught (1): workflows/run.test.ts › executerWorkflow: web search and open reads recuperer: a name that resolves to the machine is refused at connection, without a request |
| L25 | access.ts redirects re-checked | a redirect leads to an undeclared domain or a local literal | caught (1): widgets/harvest.test.ts › runHarvest, widget with an account widget with an account: a redirect to an undeclared domain is refused |
| L26 | access.ts redirect cap | 50 redirects followed instead of 5 | **SURVIVED** |
| L27 | access.ts size cap (stream) | a response of any size is buffered (when no content-length) | **SURVIVED** |
| L28 | access.ts size cap (content-length) | (stream cap remains) content-length early refusal gone | **SURVIVED** |
| L29 | access.ts page final address re-checked | a page read that ended off the declared domains gives its text | caught (2): widgets/harvest.test.ts › runHarvest, widget with an account lirePage compte redirected outside the account domains: refused, the text does not leave |
| L30 | run.ts open reads cap (100) | no cap on open web reads per run | caught (3): workflows/run.test.ts › executerWorkflow: web search and open reads widget without web: the 101st fetch throws TOO_MANY_READS too |
| M1 | external-server: Origin refused | a web page (with its Origin) may call the server | caught (1): design/external-server.test.ts › serveur MCP externe Origin: http://evil.example → 403; Host: host.docker.internal:<port> → 403; Host: localhost:<port> accepted; /mcp → 404 |
| M2 | external-server: Host check | DNS rebinding: any Host header accepted | caught (1): design/external-server.test.ts › serveur MCP externe Origin: http://evil.example → 403; Host: host.docker.internal:<port> → 403; Host: localhost:<port> accepted; /mcp → 404 |
| M3 | external-server: per-client token | any token names a client | caught (3): design/external-server.test.ts › serveur MCP externe no token, wrong token, revoked token → 401; the main token of a startMcpServer server → 401 here, and an external token → 401 on startMcpServer |
| M4 | external-server: token constant time | comparison no longer constant-time (same answers) | **SURVIVED** |
| M5 | external-server: listens on localhost | the server listens on every interface | **SURVIVED** |
| M6 | external-server: capture file name | a capture name like ../../x.png is read from disk | **SURVIVED** |
| M7 | external-server: a token is required | a request with no or a wrong token is served as a made-up client | caught (1): design/external-server.test.ts › serveur MCP externe no token, wrong token, revoked token → 401; the main token of a startMcpServer server → 401 here, and an external token → 401 on startMcpServer |
| N1 | instructions: changes are reported | no change to AGENTS.md / guides / Codex files is ever reported | caught (22): kernel.test.ts › the instruction review before a Navigateur session a changed AGENTS.md is reviewed before the CLI starts |
| N2 | instructions: Codex's own config lines | any config.toml change (model_instructions_file, mcp_servers, notify) is taken in silently | caught (2): workspace/instructions.test.ts › Codex's own config.toml is watched for codex, not for claude |
| N3 | instructions: own-line pattern excludes model_instructions_file | config.toml naming an instruction file is taken in silently | caught (1): workspace/instructions.test.ts › Codex's own config.toml is watched for codex, not for claude |
| N4 | instructions: config.toml watched | Codex's config.toml is not watched | caught (2): workspace/instructions.test.ts › Codex's own config.toml is watched for codex, not for claude |
| N5 | instructions: AGENTS.override.md watched | the workspace AGENTS.override.md is not watched | caught (1): workspace/instructions.test.ts › a change names its marker kind: link target, binary, unreadable |
| N6 | instructions: skill folders watched | skill folders and the project .codex are not watched | caught (10): workspace/instructions.test.ts › a file added under a watched tree shows as created; one removed shows as deleted |
| N7 | instructions: system skills accepted once only | anything planted under ~/.codex/skills/.system is accepted silently at every session | caught (2): workspace/instructions.test.ts › Codex's own .system skills are accepted silently while the reference has none, then changes there show |
| N8 | instructions: accepted AGENTS.md never a marker | a marker (link target, too-long…) is written as Claude's AGENTS.md | caught (1): workspace/instructions.test.ts › acceptedAgents writes nothing for a marker: no unread text reaches Claude |
| N9 | instructions: guides watched | the four guides are not watched | **SURVIVED** |
| N10 | kernel.ts gate: a change stops the start | the session starts whatever changed, no card | caught (8): kernel.test.ts › the instruction review before a Navigateur session a changed AGENTS.md is reviewed before the CLI starts |
| N11 | kernel.ts gate: no reviewer / 3 rounds refuses | with no card available, or after 3 rounds, the session starts on unaccepted files | caught (2): kernel.test.ts › the instruction review before a Navigateur session no review callback and a change: the open fails |
| N12 | kernel.ts gate: Claude reads the accepted copy | the accepted AGENTS.md copy is not refreshed before a Claude session | caught (1): kernel.test.ts › the instruction review before a Navigateur session a changed AGENTS.md is reviewed before the CLI starts |
| N13 | kernel.ts gate: Navigateur for both CLIs | Codex sessions in Navigateur skip the gate | caught (1): kernel.test.ts › the instruction review before a Navigateur session revert writes the reference back, then the session starts |
| N14 | kernel.ts gate: revert on refusal | « Revenir » keeps the agent's change | caught (2): kernel.test.ts › the instruction review before a Navigateur session revert writes the reference back, then the session starts |
| O1 | telemetry: addresses scrubbed | web addresses leave in error reports | caught (4): telemetry.test.ts › scrub replaces home and web urls |
| O2 | telemetry: home path scrubbed | the home path (user name) leaves in error reports | caught (4): telemetry.test.ts › scrub replaces home and web urls |
| O3 | telemetry: quoted spans dropped | quoted text in an error message leaves | caught (1): telemetry.test.ts › errorEnvelope hides quoted content replaces every quoted span |
| O4 | telemetry: stack frames scrubbed | paths and addresses in stack frames leave unscrubbed | caught (2): telemetry.test.ts › errorEnvelope has three JSON lines and the expected fields |
| O5 | telemetry: reports off means nothing sent | error reports are sent with the switch off | caught (1): telemetry.test.ts › createReporter sends nothing when disabled or without dsn |
| O6 | telemetry: launch count off means nothing sent | the launch count is sent with the switch off | caught (2): telemetry.test.ts › session counting keeps the same did across launches, a new one after off then on |
| O7 | telemetry: file:// scrubbed | file:// paths leave in error reports | caught (2): telemetry.test.ts › scrub hides every private scheme but keeps chrome and resource |
| O8 | telemetry: blob:/data: scrubbed | blob: and data: addresses leave in error reports | caught (1): telemetry.test.ts › scrub hides every private scheme but keeps chrome and resource |
| O9 | telemetry: no IP inference | (explicit 0.0.0.0 remains) infer_ip never gone | caught (1): telemetry.test.ts › errorEnvelope has three JSON lines and the expected fields |
| O10 | telemetry: unlocatable IP | (infer_ip never remains) explicit IP gone from error events | caught (1): telemetry.test.ts › errorEnvelope has three JSON lines and the expected fields |
| O11 | telemetry: error type scrubbed | an address or path in the error type leaves | **SURVIVED** |
| O12 | telemetry: message capped at 300 | a long error message leaves whole | caught (2): telemetry.test.ts › errorEnvelope caps caps the value to 300 chars and the stack to the 50 most recent frames |
| O13 | telemetry: home path boundary | /Users/marieX is rewritten as ~X (over-scrub, not a leak) | caught (1): telemetry.test.ts › scrub hardening replaces home only at a path boundary, trailing slash ignored |
| O14 | telemetry: session IP | the launch count lets Sentry derive a city from the IP | caught (1): telemetry.test.ts › session counting builds an anonymous session envelope |
| O15 | telemetry: nothing before the notice | reports and the launch count leave before the notice has shown | no unit test catches it; e2e not run: e2e/telemetry.e2e.ts |
| O16 | telemetry: crash reports need their own switch | minidumps (page data) are sent without their own yes | no unit test catches it; e2e not run: e2e/telemetry.e2e.ts |
| O17 | telemetry: only our chrome's errors | web pages' own console errors (with their addresses) are reported | no unit test catches it; e2e not run: e2e/telemetry.e2e.ts |
| P1 | update: must be newer | an update of the same version is installed again (replay) | caught (2): update.test.ts › isStaleUpdate an offered update no newer than the running Ressac, while downloading or ready |
| P2 | update: stale update refused | an older update is installed (downgrade) | caught (3): update.test.ts › isStaleUpdate an offered update no newer than the running Ressac, while downloading or ready |
| P3 | update: ready phase judged | a ready (staged) older update is not dropped | caught (3): update.test.ts › isStaleUpdate an offered update no newer than the running Ressac, while downloading or ready |
| P4 | update: staged app's own version judged | an old signed MAR offered under a new number rolls Ressac back | no unit test catches it; e2e not run: e2e/update.e2e.ts |
| P5 | update: staged version read | the staged app's version is never read (same downgrade) | caught (1): update.test.ts › isStaleUpdate the staged app's own version unmasks an old signed build offered as 9.9.9 |
| P6 | publish: MAR signed by our key | publishing accepts a MAR that does not verify | caught (1): publish.test.ts › publish.sh refuses when the MAR's signature does not verify |
| P7 | publish: never backwards | publishing an older version over a newer live one | caught (1): publish.test.ts › publish.sh refuses a version older than the live feed's; the same or a newer one goes on |
| P8 | package: MAR signature verifies | packaging keeps a MAR whose signature does not verify | **SURVIVED** |
| P9 | publish: DMG notarized and accepted | publishing a DMG that is not notarized | caught (1): publish.test.ts › publish.sh ignores the test variables outside a dry run: the Apple checks still run, nothing is uploaded |
| P10 | publish: a published version is never rewritten | a published version's MAR is replaced by another | caught (1): publish.test.ts › publish.sh refuses when the version is already published with another MAR |
| Q1 | page-guard: decision | an agent page reaches anything | caught (6): page-guard.test.ts › an agent page's image to the web is cancelled |
| Q2 | page-guard: target must be loopback | an agent page reaches evil.com:5300 | caught (2): page-guard.test.ts › other local services are not: Ollama, a dev server, the LAN |
| Q3 | page-guard: target must be on the agent's ports | an agent page reaches other local services (Ollama 11434, the MCP port) | caught (1): page-guard.test.ts › other local services are not: Ollama, a dev server, the LAN |
| Q4 | page-guard: navigation needs a gesture | an agent page navigates the tab anywhere by script (data in the address) | caught (1): page-guard.test.ts › a top-level navigation leaves only on a user gesture |
| Q5 | page-guard: gesture only frees a top-level navigation | after any click, fetch / beacon to anywhere pass | **SURVIVED** |
| Q6 | page-guard: CDN GET only | POST to a CDN host passes | caught (1): page-guard.test.ts › known CDNs are reachable with GET only |
| Q7 | page-guard: CDN hosts only | GET to any host passes | caught (4): page-guard.test.ts › an agent page's image to the web is cancelled |
| Q8 | page-guard: agent page whatever its host (fails closed) | an agent page loaded by a public name resolving to 127.0.0.1 is not guarded | caught (1): page-guard.test.ts › an agent port under a public name is an agent page too |
| Q9 | page-guard: loopback is the machine only | a LAN address on an agent port (192.168.1.1:5300) is reachable | caught (2): page-guard.test.ts › other local services are not: Ollama, a dev server, the LAN |
| Q10 | page-guard: unparsable target cancelled | an unparsable target passes | **SURVIVED** |
| Q11 | page-guard: every principal judged | a request passes as soon as one of its principals is not an agent page (worker, about:blank window) | no unit test catches it; e2e not run: e2e/agent-page-guard.e2e.ts |
| Q12 | page-guard: sandboxed document judged by its creator | a sandboxed iframe of an agent page is not guarded | no unit test catches it; e2e not run: e2e/agent-page-guard.e2e.ts |
| Q13 | page-guard: the request is cancelled | blocked requests are only logged (dead proxy remains for those with a proxy step) | no unit test catches it; e2e not run: e2e/agent-page-guard.e2e.ts |
| Q14 | page-guard: dead proxy for a blocked channel (WebSocket DNS) | a blocked WebSocket resolves its host name first (DNS leak) | no unit test catches it; e2e not run: e2e/agent-page-guard.e2e.ts |
| Q15 | page-guard: CDN list | (reverse) one more host in the CDN list: checks the list is pinned | caught (1): page-guard.test.ts › a top-level navigation leaves only on a user gesture |
| R1 | local-guard: resolution checked | a public name resolving to 127.0.0.1 is read | caught (3): local-guard.test.ts › public name resolving to ::1 is local |
| R2 | local-guard: fails closed | a failed resolution lets the request through | caught (1): local-guard.test.ts › a failed or empty resolution is refused (fail closed) |
| R3 | local-guard: any local address refuses | a name with one public and one local address passes | caught (1): local-guard.test.ts › public name resolving to ::1 is local |
| R4 | local-guard: local literal | a local IP literal passes (an address is its own resolution) | caught (1): local-guard.test.ts › literal 127.0.0.1, [::1], localhost., box.local are local without resolving |
| R5 | local-guard: test addresses only under automation | RESSAC_TEST_PUBLIC_ADDRESSES is honoured in a normal launch | **SURVIVED** |
| R6 | local-guard: observer honours allowLocal only when set | a running read's requests to local addresses pass | no unit test catches it; e2e not run: e2e/invisible.e2e.ts |
| R7 | local-guard: local request cancelled | a local request is not cancelled | no unit test catches it; e2e not run: e2e/invisible.e2e.ts |
| R8 | local-guard: reading container guarded for good | a service worker outliving its read is not guarded | no unit test catches it; e2e not run: e2e/invisible.e2e.ts |
| R9 | local-guard: finished read still guarded | a pagehide beacon after the read closed is not guarded | no unit test catches it; e2e not run: e2e/invisible.e2e.ts |
| R10 | local-guard: top-level allowTop | a read's top-level document goes to an address the read refuses | no unit test catches it; e2e not run: e2e/invisible.e2e.ts |
| S1 | site apps: navigation decision | a site app's view follows a navigation to any https site | caught (2): sites/navigation.test.ts › main frame: the site and its subdomains are followed, the rest blocked |
| S2 | site apps: open decision | window.open to any site opens a small window in the app's container | caught (2): sites/navigation.test.ts › openings: the site in the app, sign-in in a small window, the rest blocked |
| S3 | site apps: no credentials in addresses | https://user:pw@app-domain/ is followed | caught (2): sites/navigation.test.ts › credentials in the address: always blocked, even toward the site |
| S4 | site apps: https only | plain http to the app's domains is followed | caught (2): sites/navigation.test.ts › http: never outside test mode, even toward the site |
| S5 | site apps: never local | a local https address listed in the domains is followed | caught (1): sites/navigation.test.ts › local addresses: refused outside test mode, even if a list contains them |
| S6 | site apps: subdomain needs the dot | evilexample.com counts as on example.com's app | caught (1): sites/urls.test.ts › hostInSite exact, subdomain, case-insensitive, trailing dot |
| S7 | site apps: observer follows only allowed pages | the app view loads any page (the observer never cancels) | no unit test catches it; e2e not run: e2e/sites-navigation.e2e.ts |
| S8 | site apps: a closed app's container loads nothing | a window that outlived its app keeps loading pages with the app's cookies | no unit test catches it; e2e not run: e2e/sites-window.e2e.ts |
| S9 | site apps: a sign-in window opens nothing | a sign-in window opens further windows in the app's container | no unit test catches it; e2e not run: e2e/sites-navigation.e2e.ts |
| S10 | site apps: view shows only the web | file:, data:, blob:, mailto: load at the top of an app view | no unit test catches it; e2e not run: e2e/sites-navigation.e2e.ts |
| S11 | site apps: view under the home / card loads only what Ressac starts | the view loads a page before « Entrer » / the grant | no unit test catches it; e2e not run: e2e/sites-grant.e2e.ts |
| S12 | site apps: a new window's first page decides | a window.open to a blocked site loads in the app's container | no unit test catches it; e2e not run: e2e/sites-navigation.e2e.ts |
| T1 | site-frames: memory needs the grant | a memory write passes without the user's grant | caught (1): site-frames.test.ts › frameMemory refused to a sub-frame, the sign-in window, a page off the site, without the grant, and a non-object request |
| T2 | site-frames: memory from the main document only | a sub-frame on the app's domains writes the memory | caught (1): site-frames.test.ts › frameMemory refused to a sub-frame, the sign-in window, a page off the site, without the grant, and a non-object request |
| T3 | site-frames: memory on the app's domains only | a sign-in page (off the app's domains) writes the memory | caught (2): site-frames.test.ts › frameMemory the view's main page: relayed with the app's id and the page's relative address |
| T4 | site-frames: injection needs the grant | tweaks are injected before the grant | caught (1): site-frames.test.ts › frameInjection without the grant: null; about:blank and about:srcdoc get nothing; a page off the site gives its frames nothing |
| T5 | site-frames: frame belongs to an open app's view | any frame (a tab, a sign-in window) is treated as the first open app's | caught (3): site-frames.test.ts › frameInjection the sign-in window (same container, another <browser>) and an ordinary tab get nothing |
| T6 | site-frames: console source named as the app's tweak | any page error lands in the tweaks' console the agent reads | caught (1): site-frames.test.ts › the tweaks' console keeps the app's tweak errors relayed from its view, never another app's nor the sign-in window's |
| T7 | site-frames: app container only for the app's pages | a link leaving the app opens with the app's cookies | caught (1): site-frames.test.ts › inheritedProfile an app essential's container only for the app's own pages; other profiles and about:blank are kept |
| T8 | site-frames: opener loop bound | an opener cycle hangs the browser (the 0.1.15 freeze) | caught (1): F:(hang: killed after 60 s) |
| T9 | site-frames: resume needs the grant | video positions are recorded before the grant | caught (1): site-frames.test.ts › framePosition and frameResume refused without grant, for a frame the resume does not go into, outside the view, off the site, or a malformed message |
| U1 | ui-network: WebSocket schemes | the UI opens a WebSocket to the web | caught (1): ui-network.test.ts › ui-network the UI's loads: http, https, ws and wss are refused whatever the host, 127.0.0.1 and localhost included; nothing escapes the net |
| U2 | ui-network: view-source prefix | view-source:https://… loads in the UI | caught (1): ui-network.test.ts › ui-network chrome:, resource:, moz-extension:, data:, blob:, page-icon:, moz-remote-image: pass; a nested view-source: is judged by its inner URI |
| U3 | ui-network: scheme case | HTTPS://… passes (if a spec is ever not normalised) | caught (1): ui-network.test.ts › ui-network the UI's loads: http, https, ws and wss are refused whatever the host, 127.0.0.1 and localhost included; nothing escapes the net |
| U4 | ui-network: deep chain fails closed | a document past 32 ancestors is not the UI's | caught (1): ui-network.test.ts › ui-network a chain of UI-less chrome documents deeper than the walk's bound counts as the UI's (fails closed) |
| U5 | ui-network: policy rejects | the content policy accepts the UI's web loads (the observer remains) | caught (1): ui-network.test.ts › ui-network the policy rejects a UI load to the web and accepts the rest |
| U6 | ui-network: observer cancels | system documents' web loads are not cancelled (their only layer) | caught (1): ui-network.test.ts › ui-network the opening-request observer cancels a UI channel to the web, never another; the WebRTC refusal answers only the UI |
| U7 | ui-network: agent-written remote frames | widget displays, site homes and action components load from the web | caught (1): ui-network.test.ts › ui-network a remote frame's load (content context) is the UI's by its top embedder's group or by a frames principal; a tab's is not |
| U8 | ui-network: loads without a context | a UI worker's fetch / WebTransport passes | caught (2): ui-network.test.ts › ui-network UI_PREFIXES holds the frames origin and none of the old per-frame prefixes |
| U9 | ui-network: UI WebRTC denied | a UI document opens a WebRTC connection | caught (1): ui-network.test.ts › ui-network the opening-request observer cancels a UI channel to the web, never another; the WebRTC refusal answers only the UI |
| U10 | ui-network: frames' WebRTC denied | an agent-written frame opens a WebRTC connection | caught (1): ui-network.test.ts › ui-network a remote frame's WebRTC is denied through Firefox's peer connection blockers; a tab's is left alone |
| U11 | ui-network: frames origin with its slash | (over-block) another host sharing the prefix counts as UI | caught (1): ui-network.test.ts › ui-network UI_PREFIXES holds the frames origin and none of the old per-frame prefixes |
| U12 | ui-network: cut frames | a cut frame's own navigation is not judged by its mark | caught (2): ui-network.test.ts › ui-network a frame's navigation, with neither loading document nor node, is the UI's by its target context's embedder, not its parent's |
| U13 | ui-network: UI document walk | no document is recognised as the UI's by its address | caught (5): ui-network.test.ts › ui-network a document is the UI's by its own address or an in-process ancestor's; browser.xhtml, a tab (even on a frames address) and a document-less chrome channel are not |
| U14 | ui-network: opening observer judges | the opening observer does nothing | caught (1): ui-network.test.ts › ui-network the opening-request observer cancels a UI channel to the web, never another; the WebRTC refusal answers only the UI |
| U15 | ui-network: install steps | the observer is reported installed but never registered | caught (2): ui-network.test.ts › ui-network the net failing to install: the policy refused, frames still load; the observer refused, no UI frame gets its src |
| V1 | relay: session token | any bearer gets the real API key used for it | caught (5): relay.test.ts › relay only POST, and a non-ASCII bearer is a 401 |
| V2 | relay: inference paths only | any API path is relayed with the key (files, batches, admin; Ollama /api/pull) | caught (3): relay.test.ts › relay paths |
| V3 | relay: POST only | GET / DELETE relayed with the key | caught (1): relay.test.ts › relay only POST, and a non-ASCII bearer is a 401 |
| V4 | relay: token constant time | comparison no longer constant-time (same answers) | **SURVIVED** |
| V5 | relay: client credentials dropped | the container's own x-api-key / cookie headers go upstream | caught (1): relay.test.ts › relay ollama: no key, no auth headers, inference paths only |
| W1 | bridge: private tabs never read | a tab of a private space is read | no unit test catches it; e2e not run: e2e/agent.e2e.ts |
| W2 | bridge: origin re-checked after the read | a tab that changed site during the read gives its new page | **SURVIVED** |
| W3 | bridge: read only the origin the kernel checked | a tab already on another origin than the one granted is read | **SURVIVED** |
| W4 | bridge: private mirror | the kernel is never told which tabs are private (current_page, activity) | no unit test catches it; e2e not run: e2e/agent.e2e.ts |
| X1 | workshop: session only if a direct connection is refused | a session starts although the web is directly reachable | caught (1): container/workshop.test.ts › agent network secureNetwork fails closed: apply error, or a reachable probe |
| X2 | workshop: rules must apply | (the probe remains) a failed rules install is ignored | caught (3): container/workshop.test.ts › agent network secureNetwork fails closed: apply error, or a reachable probe |
| X3 | workshop: no-new-privileges | setuid binaries can raise privileges in the container | caught (2): container/workshop.test.ts › agent network docker run carries the network, memory and proxy flags once each |
| X4 | workshop: cap-drop ALL | the container keeps default capabilities (NET_ADMIN under Podman: flush the rules) | caught (2): container/workshop.test.ts › agent network docker run carries the network, memory and proxy flags once each |
| X5 | workshop: IPv6 off | IPv6 is on (the iptables rules are IPv4 only) | caught (2): container/workshop.test.ts › agent network docker run carries the network, memory and proxy flags once each |
| X6 | workshop: .ressac read-only | the agent rewrites its launch profiles, MCP config, accepted instructions | caught (1): container/workshop.test.ts › ensureStarted on absent: build if the image is missing then run with the right arguments |
| X7 | workshop: ports on 127.0.0.1 | the agent's ports are published on every interface of the Mac | caught (3): container/workshop.test.ts › ensureStarted on absent: build if the image is missing then run with the right arguments |
| X8 | workshop: autoupdater off | Claude Code's autoupdater is on | caught (2): container/workshop.test.ts › agent network docker run carries the network, memory and proxy flags once each |
| X9 | workshop: pids limit | no process limit (fork bomb) | caught (2): container/workshop.test.ts › agent network docker run carries the network, memory and proxy flags once each |
| X10 | workshop: memory limit | no memory limit on the agent's container | caught (2): container/workshop.test.ts › agent network docker run carries the network, memory and proxy flags once each |
| X11 | workshop: only valid domains reach the rules | (the module filters again) kernel-side domain filter gone | caught (1): container/workshop.test.ts › agent network secureNetwork applies the rules with valid domains only, then probes |
| X12 | workshop: proxy env | (not a barrier) Node ignores the proxy: checks flags are pinned | caught (2): container/workshop.test.ts › agent network docker run carries the network, memory and proxy flags once each |
