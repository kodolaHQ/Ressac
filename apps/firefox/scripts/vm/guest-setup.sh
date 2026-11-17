#!/bin/sh
# Runs as root in the throwaway bake machine of build-image.sh: turns a stock Alpine cloud image into the Ressac machine.
#   guest-setup.sh setup <dockerfile hash> <workshop image archive (docker save), on a mount from the Mac>
#   guest-setup.sh seal <bake user>   last step, removes what belongs to the bake machine; no SSH login works after it
set -eu

setup() {
  hash=$1 archive=$2
  apk upgrade --no-cache -q </dev/null
  # iptables: netavark sets up the containers' networks and published ports with it.
  apk add --no-cache -q podman iptables </dev/null

  # cgroups v2 only: the workshop's --memory and --pids-limit rely on it.
  sed -i 's/^#*rc_cgroup_mode=.*/rc_cgroup_mode="unified"/' /etc/rc.conf
  rc-update add cgroups boot
  # Rootful Podman; Lima forwards its socket to the Mac (portForwards in lima.yaml).
  cat >/etc/conf.d/podman <<'EOF'
podman_uri="unix:///run/podman/podman.sock"
podman_user="root"
EOF
  rc-update add podman default
  # Lima forwards a socket over SSH as its own user, whose name is only known on the Mac that runs the machine. The
  # guest has no other account but root, and that user has passwordless sudo, so opening the socket to all grants nothing more.
  cat >/etc/init.d/ressac-podman-socket <<'EOF'
#!/sbin/openrc-run
description="Lets the Lima user reach the rootful Podman socket"
depend() { need podman; }
start() {
  i=0
  while [ ! -S /run/podman/podman.sock ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  chmod 0666 /run/podman/podman.sock
}
EOF
  chmod 755 /etc/init.d/ressac-podman-socket
  rc-update add ressac-podman-socket default

  # The workshop image, preloaded so the machine never builds it: the label tells Workshop it is up to date.
  # From a file on the mount: from stdin Podman would first spool it on the small disk, which cannot hold both.
  podman load -i "$archive"
  label=$(podman image inspect -f '{{index .Config.Labels "ressac.dockerfile"}}' ressac-workshop:1)
  [ "$label" = "$hash" ] || { echo "the loaded workshop image is labelled '$label', expected '$hash'" >&2; exit 1; }

  # Boot speed: no bootloader menu (10 s), no ARP probe nor IPv6 router wait in dhcpcd (~6 s).
  sed -i 's/^timeout:.*/timeout: 0/' /boot/limine/limine.conf
  grep -q '^timeout: 0$' /boot/limine/limine.conf
  printf 'noarp\nipv4only\n' >>/etc/dhcpcd.conf

  # Lima's boot script removes the image's own user and reboots: done here, the user's first boot does not reboot.
  if id alpine >/dev/null 2>&1; then userdel -r alpine; fi

  echo "$(cat /etc/alpine-release)-$(podman version -f '{{.Client.Version}}')-$hash" >/etc/ressac-vm-version
}

seal() {
  user=$1
  # Each machine gets its own SSH host keys (sshd makes them at boot) and runs cloud-init as a new instance.
  rm -f /etc/ssh/ssh_host_*
  # The bake's mount, written by cloud-init; the user's mounts get their own lines at first boot.
  sed -i '/comment=cloudconfig/d' /etc/fstab
  cloud-init clean --logs
  # Lima gives its user the Mac's uid: the bake user would take it from the user's own.
  userdel -f -r "$user"
  rm -f /etc/sudoers.d/90-cloud-init-users
  rm -rf /var/cache/apk/*
  # Hands the freed blocks back to the raw disk, so it compresses and decompresses small.
  fstrim -v /
}

case ${1:-} in
setup | seal) "$@" ;;
*) echo "usage: guest-setup.sh setup <hash> <archive> | seal <user>" >&2; exit 2 ;;
esac
