#!/bin/zsh
# Creates the backup MAR signing key, kept offline: its PKCS#12 goes to <folder> (a USB key, not this Mac's disk),
# its password is printed once (keep it in the Passwords app or on paper), and its public certificate becomes the
# updater's secondary cert (src/.../dep2.der). The updater accepts a MAR signed by either cert (archivereader.cpp),
# so once a version built with it is installed, the backup can sign updates if the main key is lost or stolen.
# Usage: scripts/mar-key-backup.sh /Volumes/<usb>/ressac
set -euo pipefail
app_dir=${0:A:h:h}
certs=$app_dir/src/toolkit/mozapps/update/updater
ssl=/usr/bin/openssl

(( $# == 1 )) || { print -u2 "usage: $0 <folder on offline storage>"; exit 1 }
dest=${1:A}
p12=$dest/mar-signing-backup.p12
[[ $dest == /Volumes/* ]] || { print -u2 "$dest is not on an external volume (/Volumes/…): put the backup on offline storage."; exit 1 }
[[ ! -e $p12 ]] || { print -u2 "$p12 already exists."; exit 1 }
cmp -s $certs/dep1.der $certs/dep2.der || { print -u2 "dep2.der already differs from dep1.der: a backup key exists."; exit 1 }

tmp=$(mktemp -d)
trap 'rm -rf $tmp' EXIT
$ssl req -x509 -newkey rsa:4096 -sha384 -days 36500 -nodes -subj "/CN=Ressac MAR backup" \
  -keyout $tmp/key.pem -out $tmp/cert.pem 2>/dev/null
export RESSAC_MAR_PW=$($ssl rand -base64 32)
mkdir -p $dest
(umask 077; $ssl pkcs12 -export -name ressac-mar -inkey $tmp/key.pem -in $tmp/cert.pem -passout env:RESSAC_MAR_PW -out $p12)
$ssl x509 -in $tmp/cert.pem -outform DER -out $certs/dep2.der

print "Backup key: $p12"
print "Its password (shown once, store it now in the Passwords app or on paper, NOT next to the USB key):"
print "  $RESSAC_MAR_PW"
print "dep2.der now holds its certificate: commit it, then ship a version so installed apps trust it."
print "Emergency use: copy the p12 to ~/.config/ressac/mar-signing.p12 and store this password as keychain item ressac-mar-signing."
