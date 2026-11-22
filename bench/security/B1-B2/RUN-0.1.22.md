# B1 + B2 rerun on 0.1.22

- **Date:** 2026-11-22 (run started 10:50 UTC, about 2 min; this replaces a first run of 10:42 UTC with the same counts, made before the review fixes below).
- **Code:** branch `bench-security` at `7690de0e` plus the runner fixes committed with these results; its product code is byte-identical to `main` `dd43cd2e` (`git diff dd43cd2e 7690de0e -- . ':!bench' ':!docs'` is empty), which contains tag `v0.1.22` (`585d8034`).
- **Catalogue:** `catalogue.md`, unchanged (published sha256 `145b2d10…4d92`, see `../README.md`).
- **VM image:** `ressac-vm-3.24.4-5.8.10-20062535e787.raw.zst`, sha256 `7113cc64e8631d4ae7f4f99dca9d60feb180e01d6ef791d15d14d85ab037ec4b`. This is `VM_IMAGE` in `machine.ts` with no override, downloaded from `updates.getressac.app` and checked by the kernel's own `install` (`downloadVerified`). The run saw the `downloading` state. The workshop image's `ressac.dockerfile` label (`130e39ada27e`) equals the repo's `dockerfileHash()`, so the shipped workshop image ran, with no rebuild.
- **Tools:** Lima 2.3.0 and Podman 5.8.10, SHA-checked by `apps/firefox/scripts/vm-tools.sh`.
- **Output:** `results/b1b2-0.1.22.jsonl`, one line per case: `{id, claim, attack, expected, observed, verdict}`.

## How it runs

`run/run.sh` makes a throwaway Ressac root and a throwaway short `LIMA_HOME` (`/private/tmp/rsc.*`, because Lima resolves links and its sockets must stay under 104 bytes). It renders the shipped `lima.yaml` and runs `run/cases.mts`, then deletes the instance and both folders. `cases.mts` imports `createMachine`/`vmImage`/`VM_IMAGE` from `apps/firefox/host/machine.ts` and `Workshop` from the kernel by relative path. It boots through `machine.install()` and starts the container through `workshop.ensureStarted()`, so the real `RUN_FLAGS` and `ressac-network.mjs apply` run. Attacks run as `node` in the workshop container, except where a claim is about the guest (`limactl shell`) or the Mac (`lsof`, `curl`). A Mac-side TCP server plays the relay (its port is the only allowed one), and a second one plays "another Mac port". The user domain `*.nip.io` plays the attacker's DNS for C1.3.

**One deviation from the shipped path:** the template's app-port forward moves from 5300-5319 to 5340-5359 (`RESSAC_CONTAINER_PORTS=5340-5359`). This lets a Ressac running on the same Mac keep its range. Every other line of `lima.yaml` is the shipped one, and `run.sh` refuses to run if the substitution does not apply exactly once.

The checks are built to avoid the 8 false `BROKEN` lines of the first 0.1.20 runner:
- Each check reads a value the probe prints on its own line: a JSON line, a `key=value` line with an exit code, a Node errno, or a parsed HTTP status line. No check matches a substring across mixed stdout and stderr.
- No check relies on an end-of-line anchor.
- Process checks match the exact program name, and the probe's own process is left out.
- The home checks use the Mac user's home, not the Lima guest user's.
- The network refusals have a control that shows the path works when it should:
  - root's direct connect (A1), root's DNS query to 8.8.8.8 getting its reply (A2), root resolving through 8.8.8.8 (A3);
  - root fetching example.com directly and seeing the « Example Domain » text A12 looks for;
  - the relay port, `1-1-1-1.nip.io`, the in-range forward, curl restored for A28, and the regular file in C2.11.

  When the control fails, the verdict is `NOT_TESTED`, never `HOLDS`. The file, capability and mount refusals (C2.5, C2.8, C2.10…) have no control: they check an errno or exit code of the refused call itself.
- A2 holds only on the `send-error EPERM` the rules produce, not on a silent missing reply. A probe that crashes (`probeError`) makes its case `NOT_TESTED`; it never counts as « nothing got through ».

Rerun from the repo root (Apple Silicon; the Mac's 127.0.0.1:5340-5359 and 5400-5401 TCP and 5402 UDP must be free):

```sh
corepack pnpm install --frozen-lockfile
bench/security/B1-B2/run/run.sh > /tmp/b1b2.jsonl   # progress and a tally on stderr; exit 1 on any BYPASS
```

## Verdicts

| Claim | Cases | Verdict |
|---|---|---|
| C1.1 only localhost, relay ports, proxy | A1 TCP, A2 UDP, A3 DNS, A4 IPv6, A5-A6 ICMP/raw, A7-A8 uid escalation and proxy kill, A20-A21-A23 the Mac and engine sockets | 7 HOLDS |
| C1.2 proxy allowlist | A12 smuggling, A13 absolute-form/Host, A14 ports, A15 IP literals, A16 case/trailing dot, A17 suffix match, A18 domains file | 7 HOLDS; A10 (DNS rebinding) and A11 (fronting) NOT_TESTED, argued from code |
| C1.3 private resolutions refused | A9 (`*.nip.io` to 127/8, the Mac, 169.254/16, 10/8, CONNECT and HTTP) | HOLDS |
| C1.4 rules re-applied, no start unless refused | A25 restart, A28 probe broken (curl removed: `secureNetwork` and `exec` refuse) | 2 HOLDS |
| C1.5 allowed hosts as a channel | A29: 6 base domains answer; a harmless POST of 49 B and one of 20 008 B to `api.github.com/graphql` left (403, no token) | LIMIT (stated) |
| C2.1 only two mounts, no home | B3 guest mounts, B1 guest home, B2-B4 container, B8 writes | 4 HOLDS |
| C2.2 no keys, no agent | B25-B26 | HOLDS |
| C2.3 SSH on localhost | B27 (live) | HOLDS |
| C2.4 forwards | B28 (live) | HOLDS |
| C2.5 no new privileges, limits | B12-B15, B16 userns, B17-B18 devices/PID ns | 3 HOLDS |
| C2.6 IPv6 off | B30 | HOLDS |
| C2.7 agent-process sweep | B31 | HOLDS |
| C2.8 pinned image, root-owned agents | B19-B21 | HOLDS |
| C2.9 VM image pinned | B33 (the pinned download plus a mismatched file refused) | HOLDS |
| C2.10 `.ressac` read-only, links removed | B9-B10 container, B7 Mac-side plants | 2 HOLDS |
| C2.11 kernel refuses planted links | B5-B6 (`stageHarvest`) | HOLDS |
| C2.12 Docker fallback | B32 | NOT_TESTED (no Docker engine running) |

Total: 34 HOLDS, 1 LIMIT, 3 NOT_TESTED, **0 BYPASS**, as on 0.1.20.

## Differences from the 0.1.20 report

- **Same result:** 0 bypass, and the same C1.5 limit. The upload measure is now exact (20 008 B).
- **Now live, argued from config or code at 0.1.20:**
  - C2.3: Lima's SSH listener and every TCP/UDP listener of the host agent are on 127.0.0.1.
  - C2.4: a 0.0.0.0 container port and a guest port outside the range are not forwarded, and neither is guest UDP 5402.
  - C1.4-A28: a probe that cannot return 7 leaves the session refused.
  - C2.10-B7: `.ressac/x` → link, and `.ressac` → link, both planted on the Mac, are removed by `realInternal` at the next container start.
  - C2.9: a file that does not match the pinned SHA-256 is refused before any instance exists.
- **Observed, not a bypass:** a guest UDP listener inside the range (5341) is forwarded to the Mac's 127.0.0.1, like TCP. `lima.yaml`'s in-range rule has no `proto`. This fits SECURITY.md ("ports 5300-5319 on 127.0.0.1") and `lima.yaml`'s comment ("every other port, TCP or UDP, stays inside"). It is wider than the catalogue's B28 wording "any UDP is not forwarded". Recorded in C2.4's `observed.macUdpInRange`.
- **Also seen:** the container's resolver is 192.168.5.2, Lima's address for the Mac, and node's queries to it are refused. Lima's host agent also runs a DNS server for the guest on the Mac's 127.0.0.1, and relays the guest's own outbound UDP (NTP). Neither is reachable from the container.
- **User namespaces:** `unshare -Urm` still gives uid 0 in a throwaway namespace. Remount, write, mknod, `/proc/1/root` and iptables all fail in it, and `.ressac` stays read-only. The 0.1.20 hardening note (deny `CLONE_NEWUSER`) still applies.
- **Not run, at 0.1.20 or now:**
  - B22-B24: fork bomb, memory cap, disk fill. `security-check.sh` covers the first two.
  - A22: relay tokens, which belong to B6 (`B4-B6/results/b6-container-0.1.22.jsonl`).
  - A27: sleep and wake.
