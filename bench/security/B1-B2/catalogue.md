# B1 + B2 attack catalogue (frozen)

Written before any test ran, from SECURITY.md (« Where the agent runs ») and the code in the read-only bench
worktree `Ressac-bench` (main `e94539fb`) only:
`apps/firefox/scripts/vm/{lima.yaml,README.md,security-check.sh,security-check.ts}`,
`apps/firefox/host/machine.ts`, `apps/firefox/host/relay.ts`,
`packages/kernel/src/container/workshop.ts`, `packages/kernel/docker/{workshop.Dockerfile,ressac-network.mjs}`.

Target: Ressac 0.1.20 / main. The real shipped machine image
(`3.24.4-5.8.10-20062535e787`, sha256 `7113cc64e8631d4ae7f4f99dca9d60feb180e01d6ef791d15d14d85ab037ec4b`,
pinned in `machine.ts`) and the workshop container it loads, driven through the kernel's own `createMachine` +
`Workshop` code paths in a throwaway `LIMA_HOME`/`RESSAC_ROOT`, the way `security-check.sh` does. Attacks run from
inside the workshop container as the agent's user `node`, except where a claim is about the Mac or the VM guest.

Criterion for every claim below: **0 bypass**. One working bypass = BROKEN until fixed and retested.
The « allowed hosts as exfiltration » item is a stated limit, not a bypass: it is measured (which hosts, what can be
sent), proven only against endpoints needing no account, stopping at the request leaving.

Additions after freeze are marked `[ADDED <date>]`.

---

## B1 — The agent's network is an allowlist

SECURITY.md claims (`ressac-network.mjs`, RUN_FLAGS in `workshop.ts`):
- C1.1 The agent's user reaches **only** localhost, the Mac's MCP/relay ports, and the allowlist proxy.
- C1.2 The proxy allows only base domains (code/package hosts, model APIs) plus user-added ones; HTTPS CONNECT and plain HTTP.
- C1.3 The proxy **refuses names that resolve to private addresses**.
- C1.4 The rules are **applied again before each session**, which **does not start unless a direct connection is refused**.
- C1.5 (limit) Allowed domains can be used to send data to an attacker-controlled account; that is stated, measured, not a bypass.

Attacks (from the plan's B1 list + code reading):

Direct egress, bypassing the proxy (falsifies C1.1):
- A1 Direct TCP connect() from `node` to a public IP (e.g. 1.1.1.1:443, 8.8.8.8:53) — must be refused (iptables REJECT tcp-reset). The apply-probe uses exactly 1.1.1.1; try others.
- A2 Direct UDP from `node` to a public resolver (53) and arbitrary port — must be refused (iptables REJECT icmp-port-unreachable).
- A3 DNS: does the container run its own resolver, or must names go through the proxy? Try `getent hosts`, `nslookup @8.8.8.8`, `node dns.resolve`. A working outbound DNS query to any server = egress channel; DNS tunnelling of data in QNAME.
- A4 IPv6: `net.ipv6.conf.all.disable_ipv6=1` set — confirm no AF_INET6 socket can be created/connected; try connect to a public IPv6, and `::ffff:1.1.1.1`.
- A5 ICMP: `ping` a public IP from `node` — REJECT rules cover tcp/udp/all; raw ICMP may or may not be blocked (the final `-j REJECT` catches all protocols). Confirm.
- A6 Raw sockets: can `node` open SOCK_RAW (needs CAP_NET_RAW)? cap-drop ALL + no-new-privileges should forbid. Confirm no raw socket.
- A7 Reach the proxy's own uid: can `node` run code as uid `ressac-proxy` (which iptables lets out)? setuid/su/sudo — no-new-privileges + no caps should forbid.
- A8 Reach via root's uid (root is allowed out by the owner rule): can `node` exec as root inside the container? (no-new-privileges, cap-drop ALL).

Proxy bypass / SSRF (falsifies C1.2, C1.3):
- A9 Allowed domain whose DNS resolves to a private/Mac address: add a `*.` user domain (or use a base domain) that CNAMEs/resolves to 127.0.0.1 / 192.168.5.2 / 169.254.169.254 / 10.x — the proxy's `guardedLookup` must refuse (ERESSACLOCAL 403). Test the CONNECT path and the plain-HTTP path. Use a name under my control that resolves to a private IP (e.g. a public A record pointing at 127.0.0.1, or add the name to a user `*.` domain and resolve via a controlled server).
- A10 DNS rebinding TOCTOU: the proxy resolves once in `net.connect`/`http.request` with `guardedLookup`. Is there any window where the check address differs from the connect address? (Node resolves then connects to the returned address in the same lookup; argue/confirm no split.)
- A11 SNI / Host mismatch through CONNECT: CONNECT to an allowed host:443, then send TLS SNI / HTTP Host for a different (disallowed) host. The proxy only gates the CONNECT target and opens a raw tunnel — so the *upstream* is whatever the CONNECT host resolves to; the real test is whether the CONNECT host can be an allowed name that fronts (via shared IP / domain fronting) a disallowed origin. Document the tunnel-is-opaque property.
- A12 HTTP request smuggling: send `Transfer-Encoding`/`Content-Length` tricks or a second request line to the plain-HTTP proxy to get it to forward to a disallowed host. The proxy rebuilds the request from a parsed URL; try embedding CRLF, absolute-form with a different authority than Host.
- A13 Absolute-form URL on the plain-HTTP path: `GET http://evil.com/ HTTP/1.1` where the proxy parses `req.url` as a full URL — confirm `allowed(url.hostname)` gates it (evil.com refused), and that `Host:` header disagreement cannot override.
- A14 Ports other than 443/80: CONNECT to `allowed-host:22` or `:3128` or `:5300` — `ports.includes(port)` must refuse (only [443,80]). Plain HTTP to a non-80 port — `Number(url.port||80)!==httpPort` refuses.
- A15 IP literals in CONNECT/HTTP: `CONNECT 1.1.1.1:443`, decimal `CONNECT 16843009:443`, octal `0x01010101`, IPv4-mapped IPv6 `[::ffff:1.1.1.1]:443` — `allowed()` compares against domain strings (never IP literals) and `validDomain` rejects all-numeric, so an IP literal is never in the list → refused. Confirm each encoding is refused (not silently accepted).
- A16 Host with trailing dot / case / mixed: `API.ANTHROPIC.COM`, `api.anthropic.com.` — `allowed()` lowercases and strips one trailing dot. Confirm an allowed host still works (not a bypass, a correctness check) and that `evil.com.anthropic.com.attacker.com` is NOT matched by a `*.` suffix mistake.
- A17 `*.`-suffix matching bug: with a user domain `*.example.com`, does `allowed()` match `evilexample.com` or `example.com.evil.com`? (code: `h.endsWith(".example.com") && longer`). Confirm no over-match.
- A18 Domains file poisoning: `/etc/ressac/domains.json` is written 0644 by root and read per request. Can `node` (the agent) write it to add a domain? (It is outside the volume, owned root.) Confirm not writable by node.
- A19 Proxy env not honoured: the egress rules do not depend on the app honouring `HTTPS_PROXY`. Try a raw `node net.connect` that ignores env proxy to a public IP (covered by A1) and a tool that ignores env proxy.

Reaching the Mac (falsifies C1.1 — only MCP/relay ports allowed):
- A20 Podman socket: can `node` reach the Mac's forwarded podman socket, or the guest's `/run/podman/podman.sock`, to control Podman (container escape to host engine)? Check the socket is not reachable/мounted in the container.
- A21 Ports 5300-5319 on `host.docker.internal` (192.168.5.2): the rules only `ACCEPT -d mac -p tcp --dport <relay ports>`; the relay port is in `network.ports`. Try TCP from `node` to 192.168.5.2 on the *allowed* relay port (should work) and on a non-allowed port in 5300-5319 and outside (should fail). This maps C1.1's « the Mac's MCP and relay ports ».
- A22 Relay with a forged/guessed token: hit the relay (via the allowed port) with a bogus Bearer — must 401. Then a wrong path/method — 404/405. (This is relay = B6 but the reachability is B1.)
- A23 Other host ports through the VM gateway: from the *guest* (not container), is any Mac port reachable besides what Lima forwards? And from the container, any Mac IP/port besides 192.168.5.2 relay ports. The `other` port test in security-check covers one; extend to common ports (22, 5432, 3306, the host's own 3128?).
- A24 Link-local / cloud-metadata: 169.254.169.254 — direct (A1 covers) and via a resolved allowed name (A9 covers).

Rule re-application / persistence (falsifies C1.4):
- A25 After `restart()` (container stop+start) the rules are gone until `secureNetwork` reruns; confirm `exec` refuses to run agent commands until rules re-applied (the `secured` flag), i.e. there is no window where the container is up with no rules and the agent can run.
- A26 Proxy crash: kill the proxy process (if node can) — does egress fail closed (iptables still blocks direct, and proxy down = no web) rather than open? Can node restart a rogue listener on 3128 (comment claims safe because uid-gated)? Confirm a node-owned 3128 listener still cannot reach the network (iptables owner rule).
- A27 VM sleep/wake: after the Mac sleeps, `ensureUp` force-stops+reboots a stale machine; a reboot loses iptables (not persisted) and `start`→`secureNetwork` reapplies. Confirm no post-wake window with container up and rules absent. (May be unable to simulate sleep; reason from code + a container restart.)
- A28 The apply-probe itself: `applyNetwork` only trusts curl exit 7 (refused) on `https://1.1.1.1` with `--noproxy`. If a direct connection somehow succeeds or times out (not 7), the session must NOT be marked secured. Confirm the probe’s logic can’t be fooled into a false « closed ».

Allowed-host exfiltration channel (C1.5, measured — a limit, not a bypass):
- A29 POST a body to an allowed code/package host API that needs no account, observe the request leaving via the proxy log / a returned status: e.g. `POST https://api.github.com/...` (anonymous → 401/403 but the request + body left), or npm/pypi public endpoints. Measure: which base domains are reachable, what request methods/sizes/bodies go through. Never publish, never auth, never use user tokens. Report capacity (hosts, methods, approximate body size).

---

## B2 — VM and container isolation

SECURITY.md claims:
- C2.1 The VM sees **only** the Ressac folder (rw) and the engine folder (ro), **never** the home folder.
- C2.2 **No `~/.ssh`** authorized and **no SSH agent** forwarded into the VM.
- C2.3 Lima's SSH port listens on the **Mac's localhost only**.
- C2.4 The VM forwards to the Mac **only** the Podman socket and ports 5300-5319 on 127.0.0.1 (every other port/UDP stays inside).
- C2.5 The container has **no new privileges** and its limits (memory, pids).
- C2.6 **IPv6 off** in the container.
- C2.7 Every agent process killed when a conversation opens and no other runs.
- C2.8 Base image pinned by digest; Claude Code & Codex pinned by version, installed **root-owned** (cannot replace themselves); Claude autoupdater off.
- C2.9 The VM image is pinned by SHA-256.
- C2.10 `.ressac` mounted **read-only** (except `logs`); planted symlinks removed before each mount.
- C2.11 Kernel reads/writes in the workspace refuse links the agent planted (`no-links.ts`, `confined.ts`).
- C2.12 (limit, Docker fallback) Under a user's Docker engine the container/mounts are the same, but Docker Desktop shares `/Users`, so an escape reaches further. Confirm the limit text.

Attacks (from the plan's B2 list + code):

Mounts / home-folder exposure (falsifies C2.1):
- B1 From the VM guest: `ls /Users`, read `$HOME/.ssh`, `~/Library`, `~/.zshrc`, `~/.aws`, `~/.config` — must be absent (only the two virtiofs mounts exist). (security-check covers a few; extend.)
- B2 From the container (`node`): `ls /Users`, `cat` any Mac path — must be absent.
- B3 Enumerate guest `/proc/mounts` and `virtiofs` mounts — confirm exactly `RESSAC_ROOT` (rw) and `ENGINE` (ro), nothing else.
- B4 Does the engine mount being `ro` hold from the container? Try writing into `/opt/ressac/engine` (harvest mount) — ro.

Symlink / hardlink escape through the shared Ressac folder (falsifies C2.1, C2.10, C2.11):
- B5 From the container, create a symlink in `/workspace` pointing to `/` or to a guest path or to `../../..`; the kernel's confined reads (`readFiles`, `listFolder`, `stageHarvest`) must refuse to follow it. Plant `/workspace/evil -> /etc`, then invoke a staged harvest / instruction read and confirm it does not read through.
- B6 Hardlink: hardlink a guest file into `/workspace` and see if the kernel reads it (hardlinks defeat realpath symlink checks). Confirm `confined.ts` behaviour.
- B7 `.ressac` symlink: plant `/workspace/.ressac` as a symlink or plant a symlink *inside* a watched instruction path; the mount/`realInternal` must remove planted symlinks before mount (C2.10). Container→VM→Mac chain: can a symlink in `/workspace` (rw, virtiofs to the Mac's ~/Ressac) be made to point at a Mac path that `docker run -v` then resolves on the Mac? (The staging code comment acknowledges this race — test stageHarvest.)
- B8 Write outside the workspace from the container: `/`, `/etc`, `/home/node` (the home volume is writable — expected), `/opt/ressac` — confirm only intended writable paths.

`.ressac` read-only (falsifies C2.10):
- B9 `echo x > /workspace/.ressac/x` — must fail (ro). (security-check covers.) Also try renaming the mount point, replacing MCP config, launch profiles.
- B10 `/workspace/.ressac/logs` is writable (the one exception) — confirm it is writable and nothing else under `.ressac` is.
- B11 Can `node` write the instruction files (`AGENTS.md`, guides) — these are intentionally writable (stated); confirm, and that the gate/compare is a separate layer (B5 of the plan, out of scope here but note).

Privilege escalation in the container (falsifies C2.5):
- B12 setuid binaries: find any setuid-root binary in the image (`find / -perm -4000`); with no-new-privileges, a setuid exec gains nothing — confirm `su`/`sudo`/`mount`/`ping` cannot escalate.
- B13 Capabilities: `/proc/self/status` CapEff/CapBnd must be 0 for node; node cannot run `iptables`, `mount`, `ip`, create netns. (security-check covers caps.)
- B14 `/proc` and `/sys` writes: `/proc/sysrq-trigger`, `/proc/sys/*`, `/sys/fs/cgroup/*` — can node write cgroup files (raise its own memory.max/pids.max)? The cgroup is delegated? Confirm node cannot raise its own limits.
- B15 cgroups: can node create a child cgroup or move itself to escape pids/memory limits?
- B16 Mounting: `mount`, `unshare -Urm`, `nsenter` — user namespaces? With no-new-privileges + cap-drop ALL, `unshare -Ur` may still create a userns (not gated by caps on some kernels) — test whether a new userns yields CAP_* in it and any escape (e.g. remount `.ressac` rw). This is a real candidate.
- B17 `/dev` contents: is `/dev/mem`, `/dev/kmsg`, host block devices exposed? `ls -l /dev`.
- B18 PID namespace: can node see/kill guest or other-container processes? `ps aux` across the pid ns; `/proc/1`.

Replacing the agent binaries (falsifies C2.8):
- B19 `which claude codex`; they are in `/usr/local` root-owned. Try `npm install -g` (ignore-scripts + not writable as node) and overwriting `/usr/local/bin/claude`, `/usr/local/lib/node_modules/...` as node — must fail (root-owned).
- B20 Autoupdater: `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, managed-settings `disableAllHooks`. Confirm `/etc/claude-code/managed-settings.json` and `/etc/codex/requirements.toml` exist root-owned 644 and node cannot rewrite them.
- B21 Image digest pin: Dockerfile `FROM ...@sha256:e9f565...`; confirm (static check against the Dockerfile; the running image carries the dockerfileHash label).

Resource exhaustion against the limits (falsifies C2.5):
- B22 Fork bomb → stops at pids.max 1024 (security-check covers; re-run to confirm the container stays responsive).
- B23 Memory → OOM-killed at the cap, machine survives (security-check covers; the cap under the VM engine is `(memoryGiB-0.5)` GiB, not 2.5 — note the VM vs Docker cap difference).
- B24 Disk fill in `/workspace` or `/tmp` — no explicit quota; note whether a node can fill the VM disk (DoS, out of scope per SECURITY « DoS against your own machine », but record).

SSH / forwards (falsifies C2.2, C2.3, C2.4):
- B25 Guest: is an SSH agent socket present (`$SSH_AUTH_SOCK`, `/tmp/ssh-*`)? `ssh-add -l`? Must be none (`loadDotSSHPubKeys:false`, no agent fwd).
- B26 Guest `~/.ssh` / authorized_keys from the Mac — absent (C2.1/C2.2).
- B27 Mac side: `lsof` Lima's ssh listener — bound to 127.0.0.1 only (C2.3).
- B28 Forwards: a container port in 5300-5319 reaches the Mac's 127.0.0.1; a guest/container port outside the range, and any UDP, is NOT forwarded (C2.4). (security-check covers; confirm the 0.0.0.0 ignore rule actually blocks a 0.0.0.0-bound guest port.)
- B29 Reverse: from the container, can the Mac's *other* localhost services be reached via 192.168.5.2 (the gateway)? (overlaps A21/A23) — only allowed relay ports.

IPv6 off (C2.6):
- B30 In the container, attempt to create/bind/connect an IPv6 socket — must fail (sysctl disable_ipv6=1). Also confirms A4.

Agent-process sweep (C2.7):
- B31 `stopAgentProcesses` does `kill -KILL -1` as node; a process with a new session/empty env (`setsid env -i sleep`) — the shortcut comment admits apps launched after run as the same user. Confirm the documented behaviour and the stated limit (not a bypass, a limit).

Docker fallback (C2.12):
- B32 If a local Docker/OrbStack is available: run the same container via the Docker engine path and confirm the mounts/flags are identical and that `/Users` sharing is the stated wider exposure. If no Docker engine is available in the bench, report as not tested and why.

VM image pin (C2.9):
- B33 Confirm `machine.ts` pins version+sha256+bytes and `fetchImage` verifies sha256 before use (download or `file://`), refusing a mismatch (`HashMismatchError`). Static + the throwaway boot used the pinned sha (the run itself is the positive proof).
