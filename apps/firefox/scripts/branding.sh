#!/bin/zsh
# Placeholder icons for the ressac brand, taken from Firefox's "unofficial" branding until a real icon exists.
set -e
cd "${0:A:h}/.."
SRC=engine/browser/branding/unofficial
DST=configs/branding/ressac
[ -d "$SRC" ] || { echo "$SRC is missing: run engine:install first" >&2; exit 1; }
mkdir -p "$DST"
for n in 16 22 24 32 48 64 128 256; do cp "$SRC/default$n.png" "$DST/logo$n.png"; done
sips -z 512 512 "$SRC/default256.png" --out "$DST/logo512.png" >/dev/null
cp "$DST/logo512.png" "$DST/logo.png"
cp "$DST/logo512.png" "$DST/logo-mac.png"
cp "$SRC/firefox.ico" "$SRC/firefox64.ico" "$DST/"
rm -rf "$DST/content" && cp -R "$SRC/content" "$DST/content"
