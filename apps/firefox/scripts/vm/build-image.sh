#!/bin/zsh
# Builds the Ressac machine image in apps/firefox/dist/vm/: ressac-vm-<VM_VERSION>.raw.zst (Alpine + rootful Podman with
# the workshop image preloaded), packages.txt (every apk package) and sources.tar (the GPL sources of those packages).
# Needs the Mac's docker (OrbStack or Docker Desktop) and zstd. Runs its own Lima in a temp LIMA_HOME: no other VM is touched.
set -euo pipefail
cd "$(dirname "$0")/../.."
app=$PWD
repo=${app:h:h}
docker_folder=$repo/packages/kernel/docker
source scripts/vm-tools.sh

alpine_version=3.24.4
alpine_image=alpine-$alpine_version-aarch64-cloudinit-r0.qcow2
# SHA-256 of the image, whose official SHA-512 (dl-cdn.alpinelinux.org, also pinned by Lima's alpine-3.24 template) matched.
alpine_sha256=19635be325f3544d3dee458f1db437ecdca2d07dde8a30dd2b7569dbadf14f9a
# Same name as Workshop's IMAGE once Podman resolves it, and distinct from Docker's own ressac-workshop:1.
tag=localhost/ressac-workshop:1
bake_user=ressacbake
out=$app/dist/vm

fail() { print -u2 -- "build-image: $*"; exit 1 }
command -v zstd >/dev/null || fail "zstd is missing (brew install zstd)"
docker info >/dev/null 2>&1 || fail "docker does not answer (start OrbStack or Docker Desktop)"
! docker image inspect $tag >/dev/null 2>&1 || fail "docker already has $tag: remove it first (docker rmi $tag)"
had_alpine=$(docker image inspect alpine:$alpine_version >/dev/null 2>&1 && print 1 || true)

fetch_vm_tools $app/dist/cache/vm-tools
limactl=$app/dist/cache/vm-tools/lima-$lima_version/bin/limactl
vm_tools_download $app/dist/cache/vm $alpine_image https://dl-cdn.alpinelinux.org/alpine/v${alpine_version%.*}/releases/cloud/$alpine_image $alpine_sha256
# The hash Workshop computes, from its own function: the machine then never rebuilds the image.
hash=$(cd $repo/packages/kernel && node_modules/.bin/tsx -e 'import("./src/container/workshop.ts").then((m) => console.log(m.dockerfileHash()))')
[[ $hash =~ '^[0-9a-f]{12}$' ]] || fail "unexpected dockerfile hash '$hash'"

# Short on purpose: Lima's sockets live under LIMA_HOME and a socket path must stay under 104 characters.
tmp=$(mktemp -d /tmp/ressac-vm.XXXXXX)
export LIMA_HOME=$tmp/lima
cleanup() {
  $limactl delete -f bake >/dev/null 2>&1 || true
  rm -rf $tmp
  docker rmi $tag >/dev/null 2>&1 || true
  [[ -n $had_alpine ]] || docker rmi alpine:$alpine_version >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --platform linux/arm64 -t $tag --label ressac.dockerfile=$hash -f $docker_folder/workshop.Dockerfile $docker_folder

# Baked on a 3 GiB disk: the raw image stays small once decompressed, Lima grows it on the user's Mac.
cat >$tmp/bake.yaml <<EOF
vmType: vz
cpus: 4
memory: 3GiB
disk: 3GiB
images:
- location: $app/dist/cache/vm/$alpine_image
  arch: aarch64
mounts:
- location: $tmp/share
  mountPoint: /mnt/bake
containerd: {system: false, user: false}
video: {display: none}
ssh: {loadDotSSHPubKeys: false}
user: {name: $bake_user}
portForwards:
- guestIP: 0.0.0.0
  guestPortRange: [1, 65535]
  proto: any
  ignore: true
EOF
mkdir -p $tmp/share
cp scripts/vm/guest-setup.sh $tmp/share/
docker save -o $tmp/share/workshop.tar $tag
$limactl start --tty=false --name bake $tmp/bake.yaml
$limactl shell --workdir / bake sudo sh /mnt/bake/guest-setup.sh setup $hash /mnt/bake/workshop.tar
version=$($limactl shell --workdir / bake cat /etc/ressac-vm-version)
[[ $version =~ '^[0-9.]+-[0-9.]+-[0-9a-f]{12}$' ]] || fail "unexpected machine version '$version'"
# name version origin aports-commit license (the license may hold spaces), from apk's database.
packages=$($limactl shell --workdir / bake cat /lib/apk/db/installed \
  | awk -F: '/^P:/{p=$2} /^V:/{v=$2} /^o:/{o=$2} /^L:/{l=$2} /^c:/{c=$2} /^$/{if (p) print p, v, o, c, l; p=""}' | sort)
$limactl shell --workdir / bake sudo sh /mnt/bake/guest-setup.sh seal $bake_user
$limactl stop bake

mkdir -p $out
image=$out/ressac-vm-$version.raw.zst
rm -f $image $out/packages.txt $out/sources.tar
zstd -19 -T0 -q $LIMA_HOME/bake/disk -o $image
print -r -- $packages >$out/packages.txt

# GPL sources: each GPL package's aports folder at the commit it was built from, and the upstream files it names
# (fetched by abuild, from Alpine's distfiles mirror first). In a throwaway Alpine container, as the APKBUILDs are scripts.
mkdir -p $tmp/sources
awk '{l = $0; sub(/^([^ ]+ ){4}/, "", l)} l ~ /GPL/ {print $3, $4}' $out/packages.txt | sort -u | docker run --rm -i -v $tmp/sources:/out alpine:$alpine_version sh -euc '
  apk add --no-cache -q abuild </dev/null
  export SRCDEST=/out/distfiles DISTFILES_MIRROR=https://distfiles.alpinelinux.org/distfiles/v'${alpine_version%.*}'
  while read origin commit; do
    found=
    for r in main community; do
      wget -qO /tmp/a.tgz "https://gitlab.alpinelinux.org/alpine/aports/-/archive/$commit/aports-$commit.tar.gz?path=$r/$origin" || continue
      if tar -tzf /tmp/a.tgz | grep -q "/$r/$origin/APKBUILD\$"; then
        tar -xzf /tmp/a.tgz -C /out --strip-components 1
        found=$r
        break
      fi
    done
    [ -n "$found" ] || { echo "no APKBUILD for $origin at $commit" >&2; exit 1; }
    (cd /out/$found/$origin && abuild -F fetch verify) </dev/null
  done'
tar -cf $out/sources.tar -C $tmp/sources .

print -r -- "VM_VERSION $version"
print -r -- "SHA-256    $(shasum -a 256 $image | cut -d' ' -f1)"
print -r -- "bytes      $(stat -f %z $image)"
print -r -- "$image"
