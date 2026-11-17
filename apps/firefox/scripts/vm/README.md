# The Ressac machine image

Ressac runs the workshop in a small Linux machine it ships: Lima (`vz`) + Alpine 3.24 + rootful Podman, with the
workshop image (`packages/kernel/docker/workshop.Dockerfile`) already loaded, so the machine never builds it.

| File | What |
| --- | --- |
| `lima.yaml` | The machine's Lima template. `host/machine.ts` fills `{{IMAGE}}`, `{{RESSAC_ROOT}}`, `{{ENGINE}}`, `{{CPUS}}`. |
| `build-image.sh` | Builds `dist/vm/ressac-vm-<VM_VERSION>.raw.zst`, `packages.txt`, `sources.tar`. |
| `guest-setup.sh` | Runs as root in the throwaway bake machine (`setup`, then `seal`). |
| `publish-image.sh` | Uploads the three files to R2 under `vm/`. |
| `security-check.sh` | Proves the workshop's protections on a throwaway machine (see below). |
| `../vm-tools.sh` | Pinned Lima and Podman remote client for the Mac (SHA-256 checked, cached in `dist/cache/vm-tools/`). |

## Build

```sh
apps/firefox/scripts/vm/build-image.sh       # ~3 min on an M5 Pro, needs docker (OrbStack/Docker Desktop) and zstd
```

It builds the workshop image under the Docker tag `localhost/ressac-workshop:1` (Podman's name for `ressac-workshop:1`,
distinct from Docker's own), labelled `ressac.dockerfile=<dockerfileHash()>` computed by the kernel's own function.
Then it starts a throwaway Lima instance in a temp `LIMA_HOME` from the stock Alpine cloud image on a 3 GiB disk, runs
`guest-setup.sh`, stops it, compresses the disk (`zstd -19`), writes `packages.txt` (name, version, origin, aports
commit, license of every apk package) and `sources.tar` (for every GPL package: its aports folder at that commit and
the upstream files abuild fetches). The temp dir, the instance and the Docker tag are removed at the end, even on failure.

`VM_VERSION` = `<alpine>-<podman>-<dockerfile hash>`, also in `/etc/ressac-vm-version` in the guest. A new
Dockerfile hash means a new image to build, publish and pin.

Then, when the app should use it: `publish-image.sh` (after `npx wrangler login` once), and pin the version, SHA-256
and byte size in `host/machine.ts`.

## What the bake changes in the guest

- `apk upgrade`, `podman` + `iptables` (netavark needs it for networks and published ports).
- cgroups v2 (`rc_cgroup_mode="unified"`); `podman` OpenRC service on `/run/podman/podman.sock`; `ressac-podman-socket`
  opens that socket to the Lima user (its name is only known on the user's Mac; the guest has no other account but root).
- Boot speed: `timeout: 0` in `/boot/limine/limine.conf`, `noarp` + `ipv4only` in `/etc/dhcpcd.conf`.
- The image's `alpine` user is removed (else Lima removes it and reboots on the first start), and at `seal` the bake
  user, its sudoers file, the SSH host keys, cloud-init's state and the bake mount's fstab line; then `fstrim`.

## Measured (2026-11-17, M5 Pro, macOS 27, Lima 2.3.0)

Image `3.24.4-5.8.10-20062535e787`:

| | |
| --- | --- |
| `.raw.zst` | 526,076,788 bytes (502 MiB), SHA-256 `1be8f8cfe85ead60fdd61ad4bc376e2965d4c103f3652e2e12a2678fd391ce19` |
| raw, apparent | 3 GiB (3,221,225,472 bytes) |
| raw, real (`du -h` after `zstd -d --sparse`) | 1.7 G |
| decompress | 1.8 s |
| instance disk after the first start | 100 GiB apparent (Lima's default), 1.8 G real; guest `/` 93.7 G, 1.5 G used |

Start → `podman --url unix://<instance>/sock/podman.sock info` answers (rendered `lima.yaml`, 9 CPUs, 3 GiB):

| | |
| --- | --- |
| first start (create, cloud-init makes the user, no reboot) | 8.2 s |
| cold boot 1 | 6.0 s |
| cold boot 2 | 5.5 s |
| cold boot 3 | 6.0 s |

Checked on that machine: the workshop image label matches, the Podman client and server are both 5.8.10, cgroup2,
the two virtiofs mounts (`RESSAC_ROOT` rw, `ENGINE` ro). Lima's forward decisions (hostagent log): `127.0.0.1:5300`
forwarded (the Mac port was held by OrbStack, so no curl); not forwarded: container ports on `0.0.0.0:5400` and
`127.0.0.1:5401`, a guest process on TCP `127.0.0.1:5402` and UDP `127.0.0.1:5403`, SSH, DHCP (curl on 5400-5402: none).
The Podman service runs `system service --time 0` (Alpine's default `podman_opts`) and still answers after 15 s idle.

The image is not reproducible byte for byte (`apk upgrade`, apt in the Dockerfile, file times): each build gives a new
SHA-256, pin the one actually published.

## Security check

```sh
apps/firefox/scripts/vm/security-check.sh    # ~3 min; the Mac's 127.0.0.1:5300-5319 must be free (stop a Docker workshop first)
```

It starts the machine from `dist/vm/ressac-vm-*.raw.zst` (or `RESSAC_VM_IMAGE_URL` + `RESSAC_VM_IMAGE_SHA256`) through
`createMachine` in a throwaway `LIMA_HOME` and `RESSAC_ROOT` under `/private/tmp/rsc.*`, deleted at the end even on
failure; it never touches `~/.ressac-vm`, `~/.lima`, `~/Ressac` or Docker. `security-check.ts` then runs the kernel's
`workshop` and `session` integration tests on the machine (`RESSAC_REAL_ENGINE=machine`), starts the kernel's `Workshop`
on it with the allowlist rules, and prints one PASS/FAIL line per check: mounts (Ressac root and engine folder only, no
`/Users` in the workshop), `.ressac` read-only, web only through the proxy (example.com refused, api.anthropic.com
reached), the Mac's localhost only on the relay port, harvests with no network and a read-only root, the 2.5g and 1024
pids caps (3 GB allocation killed, a 1500-process fork bomb stopped), a real `npm install`, the forward of
127.0.0.1:5300 and none outside the range, and the idle stop. Exits 1 on any FAIL.

Measured 2026-11-17 (M5 Pro, macOS 27, Lima 2.3.0, image `3.24.4-5.8.10-20062535e787`, 3 GiB, 9 CPUs). Memory: the
process holding the instance's disk (the vz machine), RSS as `usage()` reports it, and `footprint`:

| | RSS | footprint |
| --- | --- | --- |
| after boot, nothing running | 807 MB | 589 MB |
| workshop started, rules applied | 1,336 MB | 872 MB |
| after `npm install` (react, react-dom, vite, @vitejs/plugin-react, typescript, eslint, typescript-eslint, vitest: 201 packages, 9 s) | 2,608 MB | 1,845 MB |
| after the idle stop | 0 (no process) | 0 |

The machine never gives memory back while it runs (no balloon): what a build touched stays held until the idle stop.

Cold start (machine stopped) → `Workshop.ensureStarted()` + `exec true` answers (rules applied again): 6.1 s, 6.3 s,
6.1 s. First start from the image (create + boot + Podman answers): 10.9 s.
