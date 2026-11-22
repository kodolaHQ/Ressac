# B1 + B2 security bench — report

Catalogue sha256 at the run: `61bdd85818368571a57dff58459fda788af983a146cdf15c9ab34d0e3912d3c6` (the published `catalogue.md` differs by one path; see `../README.md`). No fresh-agent review of this run when it was written.

Date 2026-11-21. Target Ressac 0.1.20 / main `e94539fb`.

## How it was run
Real shipped code path, not a mock. Pinned VM image `ressac-vm-3.24.4-5.8.10-20062535e787.raw.zst` downloaded from `updates.getressac.app`; its SHA-256 verified == the value `machine.ts` pins (`7113cc64…ec4b`) → exactly what 0.1.20 ships. Booted in a throwaway `LIMA_HOME`+`RESSAC_ROOT` under `/private/tmp/rsc.*` (as `security-check.sh` does), with pinned Lima 2.3.0 + Podman 5.8.10 (SHA-checked by the repo's `vm-tools.sh`). Workshop container + network rules brought up by the kernel's own `createMachine`+`Workshop` (`ensureStarted`→`secureNetwork`), i.e. real `RUN_FLAGS` + real `ressac-network.mjs apply`. Attacks from inside the container as `node`, plus guest (`limactl shell`) and Mac. Never touched the user's `~/.ressac-vm`, `~/Ressac`, `/Applications/Ressac.app` or running Ressac. All VMs/containers/temp deleted; verified clean (no `rsc.*`, no bench lima/podman procs, ports 5300-5319 free). The runners `attack-runner.ts` (54 checks) and `attack2.ts` (focused re-test) and their logs lived in a temporary folder and were not kept: this report is the only record.

Note: the first runner printed 8 `BROKEN` lines — **all 8 are the runner's own fragile assertions** (a JS `$` anchor beaten by a trailing newline; a substring "podman" in a "No such file" path; checking stdout when the error was on stderr; checking the Lima guest-user home instead of the Mac home). Each is resolved below with raw evidence; three (home, SSH, userns) were re-tested cleanly.

## B1 — network allowlist (0 bypass)
- C1.1 only localhost/Mac relay ports/proxy — HOLDS. Direct TCP→1.1.1.1:443 & 8.8.8.8:443 = ECONNREFUSED; UDP→53 = EPERM; ICMP none; IPv6 EADDRNOTAVAIL; SOCK_RAW = "Operation not permitted"; `su ressac-proxy`/sudo fail, stays uid 1000.
- C1.2 proxy allowlist (CONNECT + HTTP) — HOLDS. CONNECT example.com→403; allowed-host :22→403, :8080 HTTP→403; absolute-form disallowed host→403; IP literals (dotted, decimal 16843009, ::ffff:1.1.1.1)→403; `nip.io` does NOT match `evilnip.io`→403.
- C1.3 refuse names resolving to private IPs — HOLDS. Added user domain; `127-0-0-1.nip.io`→403 and `192-168-5-2.nip.io` (Mac gateway)→403 via `guardedLookup`/`localAddress`.
- reach-the-Mac — HOLDS. Allowed relay port connects (control); non-allowed Mac port + :22/:3306/:5432/:3128 all ECONNREFUSED; podman/docker socket absent in container.
- C1.4 rules re-applied each session, no start unless direct refused — HOLDS. After `workshop.restart()`, exec re-applies and direct egress still curl-exit-7; `secured` only set on probe exit-7.
- C1.5 allowed-hosts exfil (LIMIT, confirmed real & high-bandwidth): GET reaches api.anthropic.com, github.com, api.github.com, registry.npmjs.org, pypi.org, raw.githubusercontent.com — all base domains answer. POST of attacker JSON to api.github.com/graphql transited (curl 0, body left before 403 auth); a 20 KB body also transited (up=20000). So any base domain, any method, ≥tens-of-KB body leaves the VM. No account/token/publish used — stopped at request leaving. SECURITY.md states this limit accurately. Narrowing the base allowlist shrinks but can't close it.

## B2 — VM + container isolation (0 bypass)
- C2.1 only Ressac(rw)+engine(ro) mounts, never home — HOLDS. Guest `/proc/mounts` = exactly those two. Re-test: Mac `~/.ssh`,`~/Library`,`~/.aws`,`~/.zshrc`,`~/.config` absent in container AND guest; container has no mount of the Mac user's home folder; guest's holds only engine-path scaffolding. (First-runner "BROKEN" checked the Lima guest-user home, a runner bug.)
- C2.2 no ~/.ssh authorized, no SSH agent — HOLDS. `SSH_AUTH_SOCK` empty, no agent; only key is Lima's own boot-generated host→guest control key; no Mac private key present.
- C2.3 Lima SSH on Mac localhost only — HOLDS (config: `loadDotSSHPubKeys:false`, 127.0.0.1 bind).
- C2.4 forwards only podman socket + 5300-5319/127.0.0.1 — HOLDS (lima.yaml ignore rules + image's security-check forward checks).
- C2.5 no-new-privileges + mem/pids limits — HOLDS. inspect: PidsLimit 1024, no-new-privileges, mem cap set. node CapEff/Bnd/Prm=0, can't iptables/ip, can't raise pids.max/memory.max or write /proc/sysrq-trigger (cgroup ro), setuid neutralised.
- unprivileged userns — HOLDS (hardening note): `unshare -Urm` gives all-caps in an ephemeral nested userns, but remount `.ressac` rw→EPERM, write→read-only, mknod→EPERM, `/proc/1/root`→permission denied, iptables→fail; the one `mount --bind` that returned 0 is confined to that throwaway namespace and gone after exit (`.ressac` still read-only). No escape. Recommend seccomp-denying `unshare`/`CLONE_NEWUSER` (or sysctl) to remove the surface + local-kernel-CVE amplification.
- C2.6 IPv6 off — HOLDS (disable_ipv6=1, 0 inet6, can't connect/bind).
- C2.7 agent-process sweep — HOLDS as stated (its documented app-same-user limit is in SECURITY.md).
- C2.8 image digest-pinned; agents root-owned; autoupdater off — HOLDS. node can't overwrite /usr/local/bin/claude (exit 2) nor npm -g (error); managed-settings + requirements.toml root-owned 644 unwritable; DISABLE_AUTOUPDATER=1 etc. set; Dockerfile FROM @sha256.
- C2.9 VM image SHA-256 pinned — HOLDS (`fetchImage` verifies, HashMismatchError; whole run used the pinned sha).
- C2.10 `.ressac` ro except logs; planted symlinks removed — HOLDS. All writes under `.ressac` fail read-only (exit 2); `logs` writable; mount point can't be removed/symlink-swapped.
- C2.11 kernel refuses planted links — HOLDS. `stageHarvest` did not read through a planted `widget.mjs→/etc/passwd` (`confined.ts` O_NOFOLLOW + per-folder dev/ino). Cross-device hardlink escape impossible.
- C2.12 Docker-fallback /Users exposure — NOT TESTED (no local Docker engine exercised; limit text matches code).

## Not tested / limits
Docker-fallback path (C2.12); C2.3/C2.4 confirmed from config + image's own forward checks, not a fresh forward run; DNS-rebinding TOCTOU (A10) and CONNECT domain-fronting (A11) argued from code, not reproduced as live races. These are the deterministic barriers only; outflow rules (B8) and end-to-end injection (B3) are other bricks.
