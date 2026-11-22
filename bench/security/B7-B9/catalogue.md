# B7 + B9 attack catalogue

Written 2026-11-21 from SECURITY.md and the code of main e94539fb only, before reading or running any test.
Frozen once its sha256 is recorded in REPORT.md. Attacks found later go in an addendum, never here.

How each attack runs:
- **(a)** now, at unit or kernel level (Node, a local server, a DNS stub in the process, test keys).
- **(b)** needs the real app (Firefox engine): a ready e2e file under `e2e/`, to run when the engine is free.
- **(c)** needs a packaged DMG in a throwaway VM (plan rule 4): described, not automated here.

Criterion (deterministic barriers): 0 bypass outside the limits SECURITY.md states.

---

## B7

### C7.1 Agent pages (ports 5300-5319) reach only the agent's own local ports, or GET from five CDN hosts

Guard: `chrome/agent/page-guard.ts` (`agentPageDecision`, `blocked`, `installAgentPageGuard`).

Decision function, (a):
- A1 fetch to a public host, GET and POST.
- A2 local port outside the range: `127.0.0.1:11434` (Ollama), `:5279` (design server), `:80`, the kernel's MCP port.
- A3 loopback look-alikes on an agent port: `127.0.0.1.nip.io:5300`, `0.0.0.0:5300`, `[::ffff:127.0.0.1]:5300`, `2130706433:5300`, `0x7f.1:5300`, `localhost.:5300`, `127.0.0.1:5300@evil.example`, a LAN address `192.168.1.10:5300`.
- A4 CDN look-alikes: `cdn.jsdelivr.net.evil.example`, `evil.example/cdn.jsdelivr.net`, `cdn.jsdelivr.net@evil.example`, `unpkg.com.`, uppercase, a sub-domain `x.unpkg.com`.
- A5 CDN with a non-GET method: POST, PUT, HEAD, OPTIONS (preflight), lowercase `get`.
- A6 CDN over clear text and on another port: `http://unpkg.com/?d=…`, `http://unpkg.com:8080/…` (data readable on the path, not only by the CDN).
- A7 non-http(s) target: `ws://`, `wss://`, `ftp://`, `file:///etc/passwd`, `data:`, `blob:`, `mailto:`, a custom scheme.
- A8 the page itself reached by a public name on an agent port (`https://evil.example:5300`): is it still treated as an agent page.
- A9 a sandboxed frame or `about:blank`/`data:` document made by an agent page (null principal with precursor): judged as the agent page.

Real engine, (b) — the standard web-bypass list, each to a local "public" server that records hits and to a DNS-visible name:
- A10 `fetch`, XHR, `<img>`, `<script>`, `<link rel=stylesheet>`, CSS `@import`, CSS `url()` background, `@font-face`, `<video>/<audio>`, `<object>/<embed>`, `<iframe>`.
- A11 `navigator.sendBeacon`, `fetch(keepalive)` on `pagehide`.
- A12 `<a ping>` (with `browser.send_pings` as shipped).
- A13 `EventSource`.
- A14 `WebSocket` (`ws:`/`wss:`), including the host name's DNS lookup.
- A15 WebTransport.
- A16 WebRTC: a data channel or a STUN/TURN request to an outside server (stated limit: confirm it is exactly as stated).
- A17 `<link rel=dns-prefetch>`, `rel=preconnect`, `rel=prefetch`, `rel=preload`, `rel=modulepreload`, `rel=prerender`; the anchor-hover speculative connection.
- A18 service worker: registered by the agent page, fetching out from `fetch`/`install`/`activate` events and after the tab is closed; a shared worker; a dedicated worker.
- A19 forms: GET and POST, `target=_blank`, `target` an iframe, submitted by script.
- A20 `<meta http-equiv=refresh>` to the web; a `Refresh` response header from the agent's server.
- A21 the agent's own server answering 301/302/307/308 to the web: for a subresource, for an iframe, for a top-level load the page started.
- A22 DNS rebinding and names: a public name resolving to 127.0.0.1 on an agent port as target; a redirect chain CDN-look-alike → web.
- A23 `file:` targets, `view-source:`, `jar:`, `resource:`, `chrome:`, `about:`, `moz-extension:`.
- A24 custom schemes and external apps: `mailto:?body=<data>`, `tel:`, `x-apple…:`, an unknown scheme in an iframe and at top level (stated limit: confirm).
- A25 favicon, `<link rel=manifest>`, OpenSearch `<link rel=search>`, media-session artwork, `Notification` icon: loads the browser makes on the page's behalf.
- A26 downloads: `<a download href=web>`, a `Content-Disposition` response.
- A27 a top-level document the agent page opened and writes into (`window.open('about:blank')`, `blob:` top-level, `document.write`), then requests from it.
- A28 a CDN-hosted HTML document (unpkg serves `.html`) in an iframe: its own requests, and its attempt to navigate the top (`top.location`, `<a target=_top>`, form `target=_top`) or `window.open`, with no gesture. Its principal is the CDN's, not an agent page's.
- A29 CSP/Reporting endpoints: `report-uri`/`report-to`, NEL, `Link:` response headers from the agent's server (preload, preconnect), 103 Early Hints.
- A30 request to a CDN host that redirects (CDN → elsewhere): the hop must be judged.
- A31 DNS as a channel: a blocked request to `<data>.evil.example` must resolve no name (prefetch off, WebSocket admission lookup).

### C7.2 An agent page's top-level navigation needs the user's gesture

- B1 (a) decision: document load, no gesture, to the web → cancel; with gesture → allow.
- B2 (b) `location = web`, `location.replace`, `history`, `<a>.click()` by script, form submit by script, `meta refresh`, `window.open` with and without features, `target=_blank`: none leaves without a gesture.
- B3 (b) transient activation reuse: one real click in the page, then a navigation by script N seconds later (how long one click lasts; POST form included).
- B4 (b) a load **Ressac or the user started** (system principal: address bar, reload, restore, an essential) to the agent's server, which answers 302 to `https://evil.example/?d=<data>`: the code skips system-principal loads, hop included.
- B5 (b) the agent's `open_tab` / `navigate` to its own server answering 302 to the web (content principal: should be cancelled).
- B6 (b) the gesture made in another tab or in Ressac's UI, not in the page.
- B7 (b) a navigation started by a non-agent principal inside the page (A28).
- B8 (b) back/forward to a web entry, `history.pushState` then reload.

### C7.3 DNS prefetch, preconnect and speculative connections are off

- C1 (a) the shipped prefs (`network.dns.disablePrefetch`, `network.preconnect`, `network.http.speculative-parallel-limit`) are in `ressac.js` and not overridden later in the file.
- C2 (b) = A17 + A31 measured on a DNS-visible name and a TCP listener.
- C3 (b) `<link rel=dns-prefetch>` inside an https agent page (the pref for https pages, `network.dns.disablePrefetchFromHTTPS`).

### C7.4 Agent apps get their own container and stay on their local origin

Guard: `chrome/store/apps.ts` `request`.
- D1 (b) top-level navigation of the app view to the web by script, 302, meta refresh: cancelled; with a click: opens in a tab, not in the view.
- D2 (b) a window the app opens (`window.open` with features) to the web.
- D3 (b) subresources of the app to the web (does the page guard cover an app's view: same port range).
- D4 (b) the app's container after its window closed: loads nothing.
- D5 (b) non-http top-level loads in the view (`file:`, `data:`, `blob:`, `mailto:`).

### C7.5 Site apps stay on their domains

Guards: `chrome/store/sites.ts` observer + `viewPolicy`, `packages/kernel/src/sites/urls.ts`.

Domain matching, (a):
- E1 look-alikes: `app.example.evil.test`, `evilapp.example`, `app.example@evil.test`, `evil.test/app.example`, `evil.test#app.example`, `evil.test\@app.example`, trailing dot, uppercase, IDN homograph, punycode, port variants.
- E2 scheme: `http://app.example` (downgrade), `ftp:`, `javascript:`, `data:`, `blob:https://app.example/…`, `view-source:`.
- E3 credentials in the address.
- E4 a declared domain that is a public suffix or shared host (`github.io`, `co.uk`): every sub-domain matches.

Real engine, (b):
- E5 top-level navigation of the view off the domains: link, script, form, 302 from the site, meta refresh, `window.open`.
- E6 a sign-in window: opened to a sign-in domain, then navigated elsewhere; opening another window.
- E7 a closed app's container: a window it opened that outlived it.
- E8 non-http top-level loads in the view (`file:`, `mailto:`, `data:`, `blob:`).
- E9 an app essential's tab and its popups (the code exempts them from the window's rule): what limits them.
- E10 subresources and iframes off the domains (stated limit: confirm it is exactly as stated).
- E11 service worker of the app's site fetching off-domain (subresource: stated limit).
- E12 preconnect/speculative to a blocked host (stated `shortcut:`).

### C7.6 Tweaks run in a sandbox the parent decides on; a memory write needs the main document, the domains and the grant

- F1 (b) a tweak's script reads the page's cookies / storage / makes requests: what the sandbox allows.
- F2 (b) a frame claims to be the main document, or claims another app's id, in its actor message.
- F3 (b) memory write from an iframe of the app page; from a page off the domains (sign-in page); from the sign-in window; without the grant.
- F4 (b) a tweak console message naming another app's tweak source.
- F5 (a) `frameMemory`/`frameInjection` pure decisions with fake WindowGlobalParents: iframe, off-domain, grantRequired.

### C7.7 Widgets, actions, workflows: the harvest has no network; the kernel fetches for it

Harvest container, (c): 
- G1 from harvest code: TCP out, DNS, ICMP, the host gateway, the metadata address, IPv6, a UNIX socket in the mount.
- G2 write outside tmp (read-only file system), capabilities (`capsh`), fork bomb and memory limits.

Kernel fetch `packages/kernel/src/workflows/access.ts`, (a), against a local server and a DNS stub:
- G3 schemes: `file:`, `ftp:`, `data:`, `gopher:`, `javascript:`, `blob:`.
- G4 credentials: `http://u:p@host/`.
- G5 local by text: `localhost`, `localhost.`, `LOCALHOST`, `x.localhost`, `x.local`, `x.internal`, `x.home.arpa`, `127.0.0.1`, `127.1`, `0`, `0.0.0.0`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.169.254`, `100.64.x`, `224+`.
- G6 IPv4 spellings: decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, mixed `0x7f.1`, short `127.1`, trailing dot `127.0.0.1.`, percent-encoded host.
- G7 IPv6: `[::1]`, `[::]`, `[0:0:0:0:0:0:0:1]`, `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, IPv4-compatible `[::127.0.0.1]`, `[fe80::1]`, `[fc00::1]`, `[fd00::1]`, site-local `[fec0::1]`, NAT64 `[64:ff9b::7f00:1]`, 6to4 `[2002:7f00:1::]`, Teredo, multicast `[ff02::1]`, a zone id.
- G8 special IPv4 ranges not in the private list: `198.18.0.0/15` (used by OrbStack and fake-IP proxies), `192.0.0.0/24`, `192.0.2.x`, `198.51.100.x`, `203.0.113.x`.
- G9 a public name that resolves to a local address (DNS stub): A → 127.0.0.1, A → 10.0.0.1, AAAA → ::1, AAAA → ::ffff:127.0.0.1, AAAA → ::127.0.0.1, several answers of which one is local, CNAME to `.local`.
- G10 DNS rebinding: first answer public, second local (check and connection must use the same answer).
- G11 redirects: public → `http://127.0.0.1:port`, → a name resolving local, → decimal IP, → `[::1]`, → `file:`, → with credentials, → an undeclared domain, a relative redirect, 6 hops, a loop, 3xx with no `Location`.
- G12 declared-domain matching: sub-domain, suffix look-alike, trailing dot, uppercase, port, userinfo trick, backslash trick, IDN.
- G13 connection reuse: a keep-alive socket opened by an allowed-local read reused by a no-local read to the same name.
- G14 caps: body over 5 MB with and without `Content-Length`, a lying `Content-Length`, a slow body past 20 s, 101 open reads in a run (the counter is in `run.ts`).
- G15 what goes out with the request: cookies, `Authorization`, the user agent, a `Referer`.
- G16 `checkPage`: a browser-read page whose final address is local or undeclared.
- G17 data out through the fetch: the URL of an open read as an exfiltration channel (capacity; SECURITY lists workflows/widgets/actions as unchecked by the outflow rules).

### C7.8 A widget's display has a CSP with no network and Trusted Types; agent-written frames run in a web content process, sandboxed, behind a per-launch random address; no external app, no fullscreen; no data to an unsandboxed frame

- H1 (a) the CSP string: every fetch directive closed, `form-action`, `frame-src`, no `navigate-to`; what `script-src 'unsafe-inline'` + Trusted Types leave.
- H2 (b) from a widget display: the A10–A31 list (fetch, img, css, font, beacon, WebSocket, WebRTC, EventSource, prefetch, dns-prefetch, form, meta refresh, self-navigation to the web, `window.open`, service worker, WebTransport).
- H3 (b) the frame's process: `remoteType` is `webIsolated=<frames origin>`, not the parent, not a `file`/`privilegedabout` process; the document's principal is null.
- H4 (b) the frame navigates itself to another `resource://` or `chrome://` address, to another widget's file, to `about:` pages: sandbox lost? data received?
- H5 (b) the random address: guessable from a web page (timing, `resource://` probing from web content), stable across launches.
- H6 (b) `mailto:`, a custom scheme, `requestFullscreen`, pointer lock, `alert`/`print`, downloads from the frame.
- H7 (b) actor messages: `open` with a non-http address / an address off the app's domains / without a press; `home`/`component` oversized or non-string; a flood.
- H8 (b) killing the frames' process repeatedly: the reload cap (3 a minute) and the state after.
- H9 (b) Trusted Types: `innerHTML`, `eval`, `setTimeout(string)`, `<script>` text from fetched data.

### C7.9 Ressac's own interface loads nothing from the web and has WebRTC denied

Guard: `chrome/store/ui-network.ts`.
- I1 (a) `isBlockedAddress`: `http`, `https`, `ws`, `wss`, uppercase, `view-source:` nesting, and schemes that pass by design.
- I2 (b) from a UI document and from a frame: the A10–A18 list.
- I3 (b) schemes that wrap a web fetch and are not `http(s)/ws(s)`: `jar:https://…!/`, `moz-remote-image:`, `view-source:https:`, `page-icon:`/`moz-page-thumb:`, `about:reader?url=`, `blob:`/`data:` documents that then fetch.
- I4 (b) agent-supplied content rendered in the UI (a message's markdown image or link, a tab title, a favicon, a recap's links): does any load.
- I5 (b) DNS: a refused UI load resolves no name (the direct-proxy fast path).
- I6 (b) WebRTC from the UI and from a frame; from a frame whose `<browser>` was just removed.
- I7 (b) with one install step failing (`RESSAC_TEST_UI_NETWORK_FAIL`): what still holds.
- I8 (b) WebTransport, a worker's fetch, a `sendBeacon` at unload from a frame.

### C7.10 The external design-mode server holds

`packages/kernel/src/design/external-server.ts`, all (a), against the real server on a free port:
- J1 listens on 127.0.0.1 only (not `0.0.0.0`, not `::1`, not the LAN address).
- J2 any `Origin` header: a site's, `null`, empty, `http://127.0.0.1:port` itself → 403, with a valid token too.
- J3 Host: `evil.example:port` (DNS rebinding), no Host, another port, `127.0.0.1` without port, `LOCALHOST:port`, `127.0.0.1:port.`, `[::1]:port`, an absolute-URI request line with a foreign authority, two Host headers.
- J4 token: none, wrong, another scheme (`Basic`), lowercase `bearer`, a token with spaces, the token in the query string, a prefix of the token, the sha256 hash itself as token.
- J5 order: a foreign Origin with a valid token and valid Host is refused before anything is read; a wrong token gets no path oracle (401 before 404).
- J6 a browser-shaped CSRF: a simple `GET`/`POST` with `text/plain` and no token.
- J7 one client reading another client's project (folder of the other client), a folder that is a symlink, `../` in the folder.
- J8 `declare_project`: ports inside the agent's range, below 1024, more than 10, a folder outside home.
- J9 capture names: a remark whose capture is `../../x.png`.
- J10 token entropy and timing: length, generator, constant-time compare.

---

## B9

### C9.1 Updates are signed with Ressac's own key, whose certificate is built into the app

- K1 (a) the build verifies MAR signatures at all (`MOZ_VERIFY_MAR_SIGNATURE`), which certificates the `ressac` channel uses, and that they are Ressac's (not Mozilla's test certificates).
- K2 (a) `signmar -v` with test keys: an unsigned MAR, a MAR signed by another key, a signed MAR with one byte flipped in the content, in the signature, in the product block; a signature stripped (`-r`); a second signature appended.
- K3 (a) the same MARs against Ressac's public certificates (`dep1.der`, `dep2.der`): none verifies.
- K4 (c) the packaged app's updater: a tampered MAR, a foreign-signed MAR and an unsigned MAR offered by a local feed → refused, the app unchanged, `UpdateVerificationFailed` reported.
- K5 (c) a Mozilla-signed Firefox MAR of the same version (wrong key, wrong channel).
- K6 (c) a correctly signed MAR whose channel is not `ressac`.

### C9.2 An update must be newer than the running version (an update that could not be staged is judged by the feed's unsigned version)

- L1 (a) `isStaleUpdate` / `plistVersion`: equal version, older, newer, `0.1.9` vs `0.1.10`, empty, garbage, a version with a suffix; a plist with two version keys.
- L2 (b) a feed offering the running version / an older one: dropped, no card.
- L3 (c) replay: an older **signed** Ressac MAR (same Gecko version) under a newer `displayVersion`: dropped once staged.
- L4 (c) the same with staging off or failing (the stated limit): is it applied.
- L5 (c) the same, quitting Ressac between the end of the download and the check (the check runs in the running app only): applied at the next launch?
- L6 (c) an older signed MAR of an **older Gecko** version: the updater's own downgrade refusal.
- L7 (a) reading: where the check runs, and what applies a pending update at startup before any Ressac code.

### C9.3 The feed

- M1 (a) where the feed address comes from (policy in the app bundle, compiled-in host), whether a pref or an environment variable can move it.
- M2 (c) a feed pointing elsewhere (hosts-level redirect in the VM, a 302 from the feed, a `URL=` on another host, `http:`): only a signed, newer update is taken.
- M3 (a) `update.xml` generation: hash and size bound to the MAR; injection through the version or key arguments.
- M4 (c) a feed whose patch hash or size does not match the MAR.

### C9.4 Publishing refuses an update that does not verify; the DMG is signed and notarized; the VM image and tools are pinned by SHA-256

`scripts/publish.sh` in dry-run on a scratch copy of its inputs, (a):
- N1 an unsigned MAR, a foreign-signed MAR, a tampered signed MAR → refused.
- N2 the live feed newer than the version being published → refused; equal; `0.1.9` live vs `0.1.10`.
- N3 the version already published with another MAR → refused; the same MAR → resumed.
- N4 `update.xml` for another version or another key → refused; an `update.xml` whose hash is not the MAR's (not checked?).
- N5 the test hooks (`RESSAC_PUBLISH_SKIP_APPLE`, `RESSAC_PUBLISH_HOST`) left exported in a real publish → ignored.
- N6 a network failure on the "already published" or "live feed" checks → stops.
- N7 (a) the VM image and tool pins: where the hash is checked, and what happens on a mismatch (reading; run if a pure function exists).
- N8 (a, read-only) a published DMG, if one is in `dist/`: `stapler validate`, `spctl`.

### C9.5 Telemetry: nothing before the notice; one switch turns it all off; errors have addresses and the home path scrubbed; crash reports off by default; one anonymous count per launch

Pure functions `shared/telemetry.ts`, (a), with a mock transport, a fake home `/Users/marie` and fake addresses:
- P1 payload contents: every field of an error envelope and of a session envelope, listed.
- P2 URL scrub: `http`, `https`, `ws`, `wss`, `file`, `blob:`, `data:`; uppercase; `view-source:`; `ftp:`, `moz-extension:`, `about:reader?url=<encoded>`, a percent-encoded URL, a scheme-less `host/path?query`, a bare host name, an IP address, an e-mail address, a URL glued to a word (`_https://`), a URL holding a space or `)`, a URL in JSON with escaped slashes.
- P3 home scrub: `/Users/marie/x`, a trailing slash home, `/Users/marieX`, `/Users/marie.bak`, lowercase `/users/marie`, a decomposed (NFD) accent in the user name, a percent-encoded home, a JSON-escaped home, `/Volumes/…/Users/marie`, the user name alone, another volume's private folder names, the workspace's space and project names.
- P4 quoted spans: `"x"`, `'x'`, backticks, « x »; a French apostrophe before a quoted secret; typographic quotes; a quote spanning a line break; an unbalanced quote.
- P5 the stack: file names, function names, a frame that is a web address, an eval frame, 300-char and 50-frame caps.
- P6 the type field carrying private text.
- P7 before the notice: `enabled() === false` → no post for an error, none for the session, the install id cleared.
- P8 the switch: turned off mid-session → the next error is not sent; the cap of 30 distinct errors per launch.
- P9 the session: what identifies the install (`did`), its life, "anonymous".
- P10 a DSN from the environment replacing the build's.

Real app, (b)/(c), with a local Sentry stand-in as DSN:
- P11 first launch, notice not yet shown: an early chrome error and a host error → 0 requests; no session.
- P12 when exactly `noticeShown` is set (shown vs. acknowledged) and what leaves from then.
- P13 second launch: exactly one session; an error → one event; payloads captured and compared with P1.
- P14 the switch off: no event, no session at the next launch, install id gone, `submitReports` false, the crashed-tab box unchecked.
- P15 crash reports: default off; with the main switch on and theirs off, a crash submits nothing; the `URL` annotation never leaves.
- P16 errors from content (`-actor.sys.mjs`, a web page's console error) are not reported.
- P17 (c) everything else the first launch sends (Firefox's own telemetry, Normandy, remote settings, captive portal, safe browsing, add-on and GMP updates): captured through a recording proxy; SECURITY.md claims nothing here, the capture says what a reader should know.
- P18 (a) build flags: `MOZ_TELEMETRY_REPORTING`, `MOZILLA_OFFICIAL`, the crash-report URL, `datareporting.policy.dataSubmissionEnabled`.

---

## Channel to measure

- Q1 the stated CDN-GET channel of agent pages: bytes per request the CDN's operator sees, the request rate, and what a third party (not the CDN) can read back. On paper unless runnable without touching a real CDN.
