#!/bin/zsh
# Proves the workshop's protections on the real machine: starts it from the built image (dist/vm, or RESSAC_VM_IMAGE_URL
# + RESSAC_VM_IMAGE_SHA256) in a throwaway LIMA_HOME and RESSAC_ROOT, runs security-check.ts (the kernel's integration
# tests on the machine engine, then one PASS/FAIL line per check, then measurements), and deletes everything at the end.
# Never touches ~/.ressac-vm, ~/.lima, ~/Ressac or Docker. Exits 1 on any FAIL, 2 when the forward checks were skipped.
# Needs: the Mac's 127.0.0.1:5300-5319 free (a running Docker workshop holds them), internet (npm, api.anthropic.com).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app=$(cd "$here/../.." && pwd)
repo=$(cd "$app/../.." && pwd)
source "$app/scripts/vm-tools.sh"
fetch_vm_tools "$app/dist/cache/vm-tools"

if [ -z "${RESSAC_VM_IMAGE_URL:-}" ]; then
  zst=$(ls "$app"/dist/vm/ressac-vm-*.raw.zst(om[1]))
  RESSAC_VM_IMAGE_URL=file://$zst
  RESSAC_VM_IMAGE_SHA256=$(shasum -a 256 "$zst" | cut -d' ' -f1)
fi

# A short path: the instance's sockets must stay under macOS's 104 bytes.
tmp=$(mktemp -d /private/tmp/rsc.XXXXXX)
export LIMA_HOME=$tmp/l RESSAC_ROOT=$tmp/r
cleanup() {
  "$app/dist/cache/vm-tools/lima-$lima_version/bin/limactl" delete --force ressac >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
mkdir -p "$LIMA_HOME" "$RESSAC_ROOT"

export RESSAC_VM_IMAGE_URL RESSAC_VM_IMAGE_SHA256 RESSAC_CONTAINER_PORTS=5300-5319
export RESSAC_LIMACTL=$app/dist/cache/vm-tools/lima-$lima_version/bin/limactl
export RESSAC_PODMAN=$app/dist/cache/vm-tools/podman-$podman_version/podman
export RESSAC_VM_TEMPLATE=$here/lima.yaml
unset RESSAC_CONTAINER
"$repo/packages/kernel/node_modules/.bin/tsx" "$here/security-check.ts"
