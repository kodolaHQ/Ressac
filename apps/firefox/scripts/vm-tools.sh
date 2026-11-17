# Sourced (zsh) by scripts/vm/build-image.sh (and later by scripts/package.sh): the tools that run the machine on the Mac.
# Lima starts the VM (limactl + its Linux guest agent), the Podman remote client talks to the rootful Podman inside it.
lima_version=2.3.0
lima_tar=lima-$lima_version-Darwin-arm64.tar.gz
# SHA-256 of the release assets (SHA256SUMS on github.com/lima-vm/lima, shasums on github.com/containers/podman).
lima_sha256=b7af444bd8f91d3c307477e562f2cf3bd7595d62b9429185e4fa841563578cfc
podman_version=5.8.10
podman_zip=podman-remote-release-darwin_arm64.zip
podman_sha256=3f8aa144b49c9e8eaa8c8a0321e09d786660e0fdc3d42ea2913b548ba64b205e

# vm_tools_download <cache> <file> <url> <sha256>: downloads <file> into <cache> once, then checks it.
vm_tools_download() {
  local cache=$1 file=$2 url=$3 sum=$4
  mkdir -p $cache
  if [[ ! -f $cache/$file ]]; then
    curl -fL --retry 3 -o $cache/$file.part $url || { print -u2 -- "could not download $file"; return 1 }
    mv $cache/$file.part $cache/$file
  fi
  print -r -- "$sum  $cache/$file" | shasum -a 256 -c - >/dev/null || { print -u2 -- "$file does not match its SHA-256, delete it from $cache and retry"; return 1 }
}

# fetch_vm_tools <cache>: makes <cache>/lima-<version>/ hold Lima's bin/ and share/ (limactl, the aarch64 guest agent)
# and <cache>/podman-<version>/podman the remote client. A no-op when already there.
fetch_vm_tools() {
  local cache=$1
  local lima=$cache/lima-$lima_version podman=$cache/podman-$podman_version
  if [[ ! -x $lima/bin/limactl ]]; then
    vm_tools_download $cache $lima_tar https://github.com/lima-vm/lima/releases/download/v$lima_version/$lima_tar $lima_sha256 || return 1
    rm -rf $lima.part
    mkdir -p $lima.part
    tar -xzf $cache/$lima_tar -C $lima.part
    mv $lima.part $lima
  fi
  if [[ ! -x $podman/podman ]]; then
    vm_tools_download $cache $podman_zip https://github.com/containers/podman/releases/download/v$podman_version/$podman_zip $podman_sha256 || return 1
    local x
    x=$(mktemp -d)
    unzip -q $cache/$podman_zip -d $x
    rm -rf $podman.part
    mkdir -p $podman.part
    cp $x/podman-$podman_version/usr/bin/podman $podman.part/podman
    rm -rf $x
    mv $podman.part $podman
  fi
}
