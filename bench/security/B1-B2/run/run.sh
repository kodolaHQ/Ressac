#!/bin/zsh
# B1-B2 runner: boots the VM image machine.ts pins (downloaded and SHA-checked by the kernel's own code) in a throwaway
# LIMA_HOME and RESSAC_ROOT, starts the workshop through the kernel's Workshop, runs cases.mts (one JSON line per case on
# stdout, progress on stderr), then deletes the instance and the folder. Never touches ~/.ressac-vm, ~/.lima or ~/Ressac.
#
#   bench/security/B1-B2/run/run.sh > b1b2.jsonl
#
# B1B2_DIR: the Ressac root and the rendered template (default: a new /private/tmp/rsc.* folder). Lima's own home is
# always a new short /private/tmp/rsc.* folder (B1B2_LIMA_HOME to reuse one): its sockets must stay under macOS's 104
# bytes, and Lima resolves links. B1B2_KEEP=1 keeps both and the stopped instance (a second run with the same two
# folders boots it again instead of downloading the image).
# Needs: Apple Silicon, the Mac's 127.0.0.1:5340-5359, 5400-5401 (TCP) and 5402 (UDP) free, internet (the image, the probed hosts).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
app=$repo/apps/firefox
source "$app/scripts/vm-tools.sh"
fetch_vm_tools "$app/dist/cache/vm-tools" >&2
limactl=$app/dist/cache/vm-tools/lima-$lima_version/bin/limactl

dir=${B1B2_DIR:-$(mktemp -d /private/tmp/rsc.XXXXXX)}
export LIMA_HOME=${B1B2_LIMA_HOME:-$(mktemp -d /private/tmp/rsc.XXXXXX)} RESSAC_ROOT=$dir/r
cleanup() {
  if [ "${B1B2_KEEP:-}" = 1 ]; then
    "$limactl" stop ressac >/dev/null 2>&1 || true
  else
    "$limactl" delete --force ressac >/dev/null 2>&1 || true
    rm -rf "$dir" "$LIMA_HOME"
  fi
}
trap cleanup EXIT INT TERM
mkdir -p "$LIMA_HOME" "$RESSAC_ROOT"

# The shipped template with one change: the app-port forward moves from 5300-5319 to 5340-5359, so a Ressac running on
# this Mac keeps its own range. Every other line (mounts, SSH, the ignore rules) is the shipped one.
sed 's/guestPortRange: \[5300, 5319\]/guestPortRange: [5340, 5359]/' "$app/scripts/vm/lima.yaml" > "$dir/lima.yaml"
[ "$(grep -c 'guestPortRange: \[5340, 5359\]' "$dir/lima.yaml")" = 1 ] || { print -u2 "the shipped lima.yaml no longer has the 5300-5319 forward"; exit 1 }

export RESSAC_CONTAINER_PORTS=5340-5359
export RESSAC_LIMACTL=$limactl
export RESSAC_PODMAN=$app/dist/cache/vm-tools/podman-$podman_version/podman
export RESSAC_VM_TEMPLATE=$dir/lima.yaml
# The pinned image only: no override of machine.ts's VM_IMAGE.
unset RESSAC_VM_IMAGE_URL RESSAC_VM_IMAGE_SHA256 RESSAC_CONTAINER RESSAC_KERNEL_RESOURCES
"$repo/packages/kernel/node_modules/.bin/tsx" "$here/cases.mts"
