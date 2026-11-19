#!/bin/zsh
# Creates the MAR signing key once: ~/.config/ressac/mar-signing.p12 (NSS nickname ressac-mar), its password in the
# login keychain (service ressac-mar-signing), and the public certificate as both updater certs in src/.
set -euo pipefail
app_dir=${0:A:h:h}
p12=~/.config/ressac/mar-signing.p12
certs=$app_dir/src/toolkit/mozapps/update/updater
# LibreSSL: its PKCS#12 defaults (3DES, SHA-1 MAC) are the ones NSS's pk12util always reads.
ssl=/usr/bin/openssl

[[ ! -e $p12 ]] || { print -u2 "$p12 already exists: the key is made once (installed apps only trust it)."; exit 1 }
security find-generic-password -s ressac-mar-signing >/dev/null 2>&1 \
  && { print -u2 "a keychain item ressac-mar-signing already exists: delete it first if the p12 is really gone."; exit 1 }

tmp=$(mktemp -d)
trap 'rm -rf $tmp' EXIT
$ssl req -x509 -newkey rsa:4096 -sha384 -days 36500 -nodes -subj "/CN=Ressac MAR" \
  -keyout $tmp/key.pem -out $tmp/cert.pem 2>/dev/null
export RESSAC_MAR_PW=$($ssl rand -base64 32)
# -T "": no application is trusted, so every read of the password asks first.
security add-generic-password -s ressac-mar-signing -a ressac -w "$RESSAC_MAR_PW" -T ""
mkdir -p ${p12:h}
(umask 077; $ssl pkcs12 -export -name ressac-mar -inkey $tmp/key.pem -in $tmp/cert.pem -passout env:RESSAC_MAR_PW -out $p12)
chmod 600 $p12
mkdir -p $certs
$ssl x509 -in $tmp/cert.pem -outform DER -out $certs/dep1.der
# Same cert in both slots until scripts/mar-key-backup.sh puts the offline backup key in dep2.der.
cp $certs/dep1.der $certs/dep2.der

print "Key made: $p12 (password in the keychain, service ressac-mar-signing)."
print "BACK IT UP NOW (without it no installed Ressac will ever update again):"
print "  - copy $p12 to iCloud Drive and to a USB key;"
print "  - save the password (security find-generic-password -s ressac-mar-signing -w) in the Passwords app;"
print "  - then make the offline backup key: scripts/mar-key-backup.sh /Volumes/<usb>/ressac"
