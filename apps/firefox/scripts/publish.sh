#!/bin/zsh
# Uploads the release `package` built to R2 (updates.getressac.app), for testers only. Run through scripts/env.sh (`pnpm run release:publish`).
# Needs a one-time `npx wrangler login`. Test hooks: RESSAC_PUBLISH_DRY_RUN=1 prints the uploads instead of running them,
# RESSAC_PUBLISH_SKIP_APPLE=1 skips the notarization checks, RESSAC_PUBLISH_HOST replaces the public host for the "already published" check.
set -euo pipefail
cd "$(dirname "$0")/.."
app_dir=$PWD
objdist=$app_dir/engine/obj-aarch64-apple-darwin/dist
bucket=${RESSAC_R2_BUCKET:-ressac-update}
public=${RESSAC_PUBLISH_HOST:-https://updates.getressac.app}
wrangler=wrangler@4.153.0

fail() { print -u2 -- "publish: $*"; exit 1 }

version=$(node -p 'require("./package.json").version')
[[ -n $version ]] || fail "no version in package.json"
dmg=$app_dir/dist/Ressac-$version.dmg
mar=$app_dir/dist/Ressac-$version.mar
xml=$app_dir/dist/update.xml
for f in $dmg $mar $xml; do [[ -f $f ]] || fail "$f is missing, run package first"; done
grep -q "displayVersion=\"$version\"" $xml || fail "dist/update.xml is not for $version, run package again"
# Entries are newest first: the first version in the file is the top entry.
notes=$(grep -m1 -oE 'version: "[^"]+"' shared/release-notes.ts || true)
[[ $notes == "version: \"$version\"" ]] || fail "the top entry of shared/release-notes.ts is not $version"
if [[ -z ${RESSAC_PUBLISH_SKIP_APPLE:-} ]]; then
  xcrun stapler validate $dmg || fail "the DMG is not notarized (package with RESSAC_SIGN_IDENTITY and RESSAC_NOTARY_PROFILE)"
  spctl -a -t open --context context:primary-signature $dmg || fail "Gatekeeper rejects the DMG"
fi
DYLD_LIBRARY_PATH=$objdist/bin $objdist/bin/signmar -D $app_dir/src/toolkit/mozapps/update/updater/dep1.der -v $mar \
  || fail "the MAR is not signed by our key"
# A published version is never rewritten. Only a 404 lets us go on; anything else (200, no network) stops.
code=$(curl -s -o /dev/null -I -w '%{http_code}' $public/releases/$version/Ressac-$version.mar || true)
[[ $code == 404 ]] || fail "$version may already be published (HTTP $code on $public/releases/$version/Ressac-$version.mar): bump the version"

put() {
  local key=$1; shift
  local cmd=(r2 object put "$bucket/$key" --remote "$@")
  if [[ -n ${RESSAC_PUBLISH_DRY_RUN:-} ]]; then print -r -- "wrangler $cmd"; else npx --yes $wrangler $cmd; fi
}
put releases/$version/Ressac-$version.mar --file $mar --content-type application/octet-stream
put releases/$version/Ressac-$version.dmg --file $dmg --content-type application/x-apple-diskimage
put download/Ressac.dmg --file $dmg --content-type application/x-apple-diskimage
# Last: update.xml then never points at a file not uploaded yet.
put updates/browser/Darwin_aarch64-gcc3/ressac/update.xml --file $xml --content-type text/xml --cache-control no-cache
print -r -- "==> Ressac $version published: $public/download/Ressac.dmg"
