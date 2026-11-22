# Security bench B7 + B9: report

Run 2026-11-21 on main e94539fb (read-only worktree `Ressac-bench`). Catalogue and run by one agent that did not build these bricks.

**What this report is and is not.** The Firefox engine was busy, so nothing here ran in the real app, and nothing ran on a packaged DMG in a VM. What ran: pure functions and the kernel's own servers, in Node, against local servers, an in-process DNS stub and throwaway signing keys. The plan's rule 4 says barriers are judged on the real build: every "holds" below is therefore **"holds at unit or kernel level"**, not a bench verdict. The e2e files are written, type-checked against the repo's helpers, and **never run**.

- Catalogue: `catalogue.md`, **152 attacks**, frozen before any test. sha256 `842f837940b751a00c31b8e7dbae2153c75307d54c652a16a1bdb283676f90c2` (also in `catalogue.sha256`).
- Run now: about 69 of the 152 (some by reading only, marked). Evidence: `unit/results/*.json` (450 recorded rows) and `unit/results/publish.txt`.
- Pending the engine: 3 e2e files under `e2e/`, covering about 35 more. Pending a VM: 12. Not written at all: listed in « Not done ».
- Mutation check (rule 3): not done. None of these tests has been shown to go red when its guard is removed.

## Verdicts

| Claim | Verdict | Basis |
|---|---|---|
| C7.1 agent pages reach only their own ports, or GET 5 CDN hosts | **pending (engine)**; decision function holds, one widening found | 69 decision cases |
| C7.2 a top-level navigation needs your gesture | **pending (engine)**; two bypasses predicted from the code | reading + 7 decision cases |
| C7.3 DNS prefetch, preconnect, speculative connections off | **pending (engine)**; the three prefs are in `ressac.js` | reading |
| C7.4 agent apps stay on their local origin | **pending (engine)**, no bench test written | — |
| C7.5 site apps stay on their domains | **holds with limit** at the matching level; engine pending | 33 cases |
| C7.6 tweaks sandbox; memory needs main document, domains, grant | **holds** for the parent's decisions; the sandbox itself pending | 18 cases |
| C7.7 harvest: no network in the container | **pending (VM)** | — |
| C7.7 the kernel's fetch refuses local addresses | **BROKEN** for one class (below); holds on the rest | 123 rows |
| C7.8 widget CSP, frames out of the parent, sandboxed | **pending (engine)**; CSP text read | reading |
| C7.9 Ressac's interface loads nothing from the web | **pending (engine)**; text rule holds | 24 cases |
| C7.10 the design-mode server holds | **holds**, with unstated limits | 73 rows, real server |
| C9.1 updates are signed with Ressac's key | **holds** at signing-tool level; the updater itself pending (VM) | 26 verifications |
| C9.2 an update must be newer | **holds with limit** (corrected below); real updater pending (VM) | 16 cases + reading |
| C9.3 the feed | **pending (VM)**; reading only | — |
| C9.4 publishing refuses an update that does not verify | **holds**, one unchecked input | 23 scenarios |
| C9.4 DMG signed and notarized | **holds** for the one DMG checked (0.1.20) | `stapler`, `spctl` |
| C9.4 VM image and tools pinned by SHA-256 | not attacked here (B2's); the pins are in the code | reading |
| C9.5 telemetry: nothing before the notice; one switch | **holds** for the pure functions; real app pending | 6 cases |
| C9.5 errors: addresses and home path scrubbed | **BROKEN as worded** on crafted text; real exposure not measured | 67 cases |

## Bypasses, with reproductions

### 1. Kernel fetch: the Mac's own global address counts as public (C7.7) — reproduced

`localUrl()` knows private IPv4 ranges, loopback, link-local and ULA. On an IPv6 network every device, the Mac included, also has a global-scope address, which the check takes for the web. Harvest code that may read the open web can reach a service on the Mac that listens on all interfaces, and IPv6 neighbours on the LAN.

Reproduction (`unit/fetch.test.ts`, row G8 in `results/fetch.json`): a server bound to the Mac's global IPv6 address; `fetch("http://[<that address>]:<port>/own-global-address", "text", null, false)` returned the body (`ANSWER PUBLIC:/own-global-address`), while every loopback spelling was refused.

Conditions: the widget or action asked for open web reads (or declares the address); the code must learn the address (one read of any what-is-my-IP page gives it); 100 reads per run. `local-guard.ts` (invisible reads) uses the same `localUrl`, and the agent's proxy is described the same way: B1 and B4 should try it.

Also accepted by text and by the lookup check, **not connected to** (so: not shown reachable): `198.18.0.0/15` (OrbStack's machines and containers live at `198.19.249.x`; no such interface was up on this Mac), `fec0::/10`, `ff00::/8`, 6to4 `2002::/16`, Teredo. `[::127.0.0.1]` is accepted by text but does not reach loopback on macOS (connection timed out).

### 2. Telemetry scrub: what still leaves (C9.5) — reproduced on the pure function only

`scrub()` and the envelope builder, with home `/Users/marie` (`unit/pure.test.ts`, rows P2–P6). Scrubbed as claimed: `http`, `https`, `ws`, `wss`, `file`, `blob:`, `data:` addresses, and the exact home path. Left as is:

- Addresses: without a scheme (`bank.example/compte/12345?iban=FR76`), a bare host (`Domaine non déclaré : intranet.client-secret.example` is one of the kernel's own messages), an IP and port, an e-mail address, `ftp://`, `sftp://`, `moz-extension://`, `mailto:`, a percent-encoded one (`about:reader?url=https%3A%2F%2Fbank.example…`), one glued to a word (`url_https://…`), the tail after a space or `)` (`https://bank.example/mes comptes/12345` → `<url> comptes/12345`).
- Home path: another case (`/users/marie/x`), a decomposed accent (`/Users/andré` in NFD), JSON-escaped slashes. Folder and file names under the home always leave (`~/Ressac/Espace Banque/projet-divorce/app.js`); so do other volumes (`/Volumes/ClientSecret/…`).
- Quoted text is replaced by `"…"`, except: after an apostrophe (`Impossible d'ouvrir 'contrat-acme.pdf'` → `Impossible d"…"contrat-acme.pdf'`; same for `can't read '…'`), typographic quotes, a quote spanning a line break, parentheses. The error type field is not checked for quotes at all.
- Stack frames: file and function names leave unless they are a listed URL or the exact home.

Not measured: whether Ressac's real errors produce such text. `e2e/b9-telemetry-capture.e2e.ts` runs these cases in the real app.

### 3. Predicted, not run: a load Ressac or the user started, redirected by the agent's server (C7.2)

`page-guard.ts` `blocked()` returns false for any load whose triggering principal is the system's, and a redirect hop keeps that principal. The address bar loads with the system principal (`controller.ts` `navigate`). So the agent's server can answer a typed or reloaded local address with `302 → https://elsewhere/?d=<data>`, with no gesture on any page. A tab the agent opens itself is loaded with a content principal (`tabs.ts`, `navigateForAgent`) and should be stopped. Test: `e2e/b7-agent-page.e2e.ts`, B4 (predicted red) and B5 (expected green).

### 4. Predicted, not run: a CDN-hosted document inside an agent page (C7.1, C7.2)

A top-level navigation is judged by its triggering principal alone. A frame loaded from a CDN name has the CDN's principal, not an agent page's, so the decision function answers "allow" for its top-level navigation with no gesture (`results/pure.json`, row A28). unpkg serves the `.html` files of any npm package (from general knowledge, not checked in this run). Whether Firefox itself refuses a cross-origin frame's top navigation without a gesture decides it: test A28, 4 cases. The frame's own subresources are judged by the tab's top page too and should be stopped.

### 5. Widening of a stated limit: a CDN's name in clear text, on any port (C7.1) — decision function only

The rule compares the host name only: `GET http://unpkg.com/?d=…` and `http://unpkg.com:8080/…` are allowed (row A6). In clear text the address is readable on the network path, not only by the CDN. The HSTS preload list may upgrade some of these hosts before the guard is asked; test A6 turns it off to see the guard alone.

## Limits confirmed or corrected

- **« a click you make in it can navigate out »** — wider than it reads: with a click the decision allows a top-level **POST** (a body, not only an address), to the web **or to any local service** (Ollama's port included, which the guard's own header comment says it protects), row B1. How long one click lasts is Firefox's transient activation (5 s by default): measured by test B3.
- **CDN GET channel** — see « Capacity » below.
- **Site apps « stay on their domains »** — a domain covers its sub-domains, and public suffixes with a dot are accepted (`co.uk`, `github.io`: `https://attacker.github.io/` is "followed", row E4). Only names without a dot are refused. The grant card is what shows the list.
- **Updates « must be newer »** — the version signed inside the MAR is the engine's, not Ressac's: the published 0.1.20 archive carries `Product version: 0.1.18`. Firefox's updater therefore accepts any signed Ressac archive built on the same engine version; « newer » is enforced only by Ressac's own code, in the running app, from the staged copy's `Info.plist`. Two consequences: the stated one (not staged → the feed's unsigned number decides), and one not stated: an update downloaded but not yet checked when Ressac quits is applied at the next launch before any Ressac code runs (reading only; VM test L5 pending). Both need control of the feed and an older signed archive on the same engine.
- **Telemetry « nothing before its notice has shown »** — true as written, and no more: `noticeShown` is set when the bar is appended (`chrome/window/index.ts`), not when it is answered. An error raised while the notice sits unanswered is sent.
- **« one anonymous count per launch »** — the session carries `did`, a random install id kept until the switch is turned off: the same install is recognisable across launches. Error events carry no id. Fields sent, in full: `event_id, timestamp, release, environment, platform, sdk, user.ip_address="0.0.0.0", tags.source, exception(type, value ≤300 chars, ≤50 frames)`; session: `sid, did, init, started, timestamp, status, duration, errors, attrs(release, environment, ip_address)`.
- **Design-mode server** — not in SECURITY.md: between two plugged clients the last declaration wins. Client B declared client A's folder and took the project (same id, so its pending remarks) and A's port; A then got « not declared ». Any port from 1024 up outside the container's range can be declared (5279, 11434 accepted), and folders outside the home are accepted.
- **Publishing** — `update.xml`'s hash and size are not compared with the archive: a feed whose hash is another file's is published. Clients then refuse the download (fails closed): an availability gap, not a security one.
- **Test-only switches in shipped code** — `RESSAC_TEST_LOCAL_ADDRESSES=1` (host) turns the kernel fetch's local refusal off; `RESSAC_SENTRY_DSN` moves telemetry to any server, `http:` included. Both need control of the launch environment (out of scope), worth knowing.
- **Latent** — the kernel fetch reuses keep-alive sockets by host name: after an allowed-local read, a no-local read to the same name reached the local server without a new lookup (row G13). Unreachable today (the switch is process-wide); it would matter if "local allowed" ever became per widget.

## What held (unit or kernel level)

- **Kernel fetch** (`results/fetch.json`): 7 non-http schemes, credentials, 20 local names and addresses, 8 numeric spellings (decimal, hex, octal, short, trailing dot, percent-encoded, full-width), mapped and NAT64 IPv6, 8 names resolving to local addresses (one local answer among several is enough), DNS rebinding (second lookup local: refused, 2 lookups made), 16 redirect cases (301–308 to loopback, to a name resolving local, to `file:`, to credentials, to an undeclared domain, 6 hops, a loop, no `Location`), the 5 MB cap with and without `Content-Length`, the 20 s deadline (measured: 20 s), no cookie or credential sent (`user-agent: node`, `accept`, `host`, `connection` only).
- **Design server** (`results/design-server.json`): 127.0.0.1 only (`::1` refused, the Mac's other addresses gave no answer); every Origin form 403, valid token included; 11 wrong Host forms refused; 13 wrong token forms 401 (prefix, suffix, case, hash, query string, cookie, revoked); 401 comes before 404; cross-client reads refused, through a symlink and `..` too; token 256 bits, compared in constant time on its hash. Two requests no browser can send were accepted with a valid token (two Host headers, the good one first; an absolute request line with a good Host).
- **Page guard decision**: 69 cases; look-alike hosts, loopback look-alikes, non-GET to a CDN, non-http schemes, a public name on an agent port (treated as an agent page: fails closed).
- **Site apps**: 26 address forms (look-alikes, credentials, `http:`, `blob:`, `view-source:`, homograph); the parent ignores the id and address a frame claims in a memory request; another app's tweak source reaches no console.
- **Updates**: the build verifies signatures (`MOZ_VERIFY_MAR_SIGNATURE=1`), channel `ressac` uses `dep1.der` / `dep2.der`, both Ressac's (4096-bit, different from Mozilla's originals) and both present in the built updater binary. With throwaway keys, `signmar` refused 13 variants: unsigned, foreign key, one byte flipped in content, signature, header, size, signature count, last byte, version, channel, bytes appended, signature stripped, two signatures. None of the test archives verifies with Ressac's certificates; the published 0.1.20 archive does, and fails with one byte flipped (scratch copy).
- **Publish script** (byte-identical copy, dry-run, `results/publish.txt`): refuses unsigned, foreign, tampered and double-signed archives; a live feed that is newer (`0.1.10` live vs `0.1.9`); a version already up with another archive; an `update.xml` for another version or key; an unreachable or failing host. The test hooks are ignored outside dry-run.
- **Telemetry gating**: not consented → 0 posts for an error and for the session, install id cleared; switch off mid-session → next error not sent; 30 distinct errors per launch at most; no DSN → nothing.

## Capacity of the stated CDN-GET channel (on paper, nothing probed)

- To the CDN's operator (and, in clear text, to the network path): the guard sets no size or rate. Per request, the address: front ends usually cap it around 8–16 KB (not measured; Node's own limit, hit in row G17 of the kernel fetch, is 16 KB). Rate: the browser's connection pool, hundreds of requests a second. So megabytes a minute, on paper.
- To a third party who is not the CDN: no direct read. Two indirect routes, both **unverified assumptions about those CDNs**: file-choice coding read back through a CDN's public per-file statistics (about log2(files) bits per request, a day late), and cache probing (about 1 bit per request, same edge needed). At best bytes to kilobytes a day. No real CDN was touched.

## Pending: commands

When the engine is free, from `apps/firefox` (each file is copied in, run, removed; none is added to the repo):

```sh
B=../../bench/security/B7-B9/e2e
for f in b7-agent-page b7-frames-ui b9-telemetry-capture; do cp $B/$f.e2e.ts e2e/bench-$f.e2e.ts; done
corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/bench-b7-agent-page.e2e.ts e2e/bench-b7-frames-ui.e2e.ts e2e/bench-b9-telemetry-capture.e2e.ts
rm e2e/bench-b7-*.e2e.ts e2e/bench-b9-*.e2e.ts
```

Baseline first (the repo's own suites for these claims): `e2e/agent-page-guard.e2e.ts e2e/frames.e2e.ts e2e/ui-network.e2e.ts e2e/ui-network-fail.e2e.ts e2e/sites-navigation.e2e.ts e2e/sites-tweaks.e2e.ts e2e/apps-window.e2e.ts e2e/telemetry.e2e.ts e2e/update.e2e.ts`.

Reading the result: tests tagged `PREDICTED RED` are findings if red (B4, A6, A28 ×3, the scrub cases). A first run will also shake out mistakes in files never executed: a red elsewhere must be read before it is called a bypass. `b9-telemetry-capture` writes its payloads to `$TMPDIR/ressac-b9-telemetry-payloads.json`; they can hold this Mac's home path where a scrub fails.

To redo the unit run: `packages/kernel/node_modules/.bin/vitest run --root <B7-B9>/unit --globals fetch.test.ts design-server.test.ts`, then the same with `apps/firefox/node_modules/.bin/vitest` for `pure.test.ts ui-address.test.ts site-frames.test.ts`; `unit/publish-harness.sh <dir holding the test archives>` (the archives were made in the session scratchpad with the engine's `certutil`, `mar` and `signmar`; the steps are in this run's log, not in a script).

VM (packaged DMG, throwaway Tart VM), not automated: K4–K6 (tampered, foreign-signed, unsigned, Mozilla-signed, wrong-channel archive offered by a local feed), L3–L6 (older signed archive under a newer number: staged, staging off, quit before the check, older engine), M2/M4 (feed moved, hash mismatch), G1/G2 (the harvest container's network and limits), P17 (everything a first launch contacts, behind a recording proxy).

## Not done

- No real-app run, no VM run, no mutation check, no fresh-agent review.
- No bench e2e written for: agent apps (D1–D5), site apps in the engine (E5–E12), tweaks in the engine (F1–F4), frame actor messages and process kills (H7–H9), UI vectors I4–I8, gesture from another tab and history (B6–B8), WebRTC (A16) and custom schemes (A24) as stated limits, `file:`/`view-source:` targets from an agent page (A23). The repo's suites cover part of these; the bench adds nothing there yet.
- Read only, not attacked: J9 (capture file names), L7, M1, M3, N7 (VM pins).
- Build flags seen on the dev engine build, not on a DMG: Firefox's own telemetry upload is not compiled in (`MOZ_TELEMETRY_REPORTING` absent); Normandy and the health report are (`MOZ_NORMANDY=1`, `MOZ_SERVICES_HEALTHREPORT=1`). What they send at launch is P17.
- The unit run bound one test server to this Mac's global IPv6 address on a random port for about 25 seconds (it served fixed test strings). Nothing else touched the network, the real profile, `~/Ressac`, the installed app, the keychain, the real signing keys or Sentry. Both git checkouts are unchanged.

## Files

All under `bench-securite/B7-B9/`:
- `catalogue.md`, `catalogue.sha256`
- `unit/fetch.test.ts`, `unit/design-server.test.ts`, `unit/pure.test.ts`, `unit/ui-address.test.ts`, `unit/site-frames.test.ts`, `unit/publish-harness.sh`
- `unit/results/fetch.json`, `design-server.json`, `pure.json`, `ui-address.json`, `site-frames.json`, `publish.txt`
- `e2e/b7-agent-page.e2e.ts`, `e2e/b7-frames-ui.e2e.ts`, `e2e/b9-telemetry-capture.e2e.ts`
