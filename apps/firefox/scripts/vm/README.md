# The Ressac machine image

Ressac runs the workshop in a small Linux machine it ships: Lima (`vz`) + Alpine 3.24 + rootful Podman, with the
workshop image (`packages/kernel/docker/workshop.Dockerfile`) already loaded, so the machine never builds it.

| File | What |
| --- | --- |
| `lima.yaml` | The machine's Lima template. `host/machine.ts` fills `{{IMAGE}}`, `{{RESSAC_ROOT}}`, `{{ENGINE}}`, `{{CPUS}}`. |
| `build-image.sh` | Builds `dist/vm/ressac-vm-<VM_VERSION>.raw.zst`, `packages.txt`, `sources.tar`. |
| `guest-setup.sh` | Runs as root in the throwaway bake machine (`setup`, then `seal`). |
| `publish-image.sh` | Uploads the three files to R2 under `vm/`. |
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
the two virtiofs mounts (`RESSAC_ROOT` rw, `ENGINE` ro), Lima forwards a container port on `127.0.0.1:5300` (its log; the Mac port was held by OrbStack, so no curl) while one
on `0.0.0.0:5400` is not, SSH and DHCP ports are not forwarded.

The image is not reproducible byte for byte (`apk upgrade`, apt in the Dockerfile, file times): each build gives a new
SHA-256, pin the one actually published.
