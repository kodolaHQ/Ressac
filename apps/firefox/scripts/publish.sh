#!/bin/zsh
# Uploads the release `package` built to R2 (updates.getressac.app), for testers only. Run through scripts/env.sh (`pnpm run release:publish`).
# Everything goes under updates/<RESSAC_UPDATE_KEY>/, the secret folder package wrote into the app: nothing has a public
# path. Testers get an expiring link (scripts/invite-link.mjs). Needs a one-time `npx wrangler login`. Test hooks: RESSAC_PUBLISH_DRY_RUN=1 prints the uploads instead of running them,
# RESSAC_PUBLISH_SKIP_APPLE=1 skips the notarization checks, RESSAC_PUBLISH_HOST replaces the public host for the "already published" check.
set -euo pipefail
# The last two only count in a dry run: a variable left exported must never weaken a real publish.
[[ -n ${RESSAC_PUBLISH_DRY_RUN:-} ]] || unset RESSAC_PUBLISH_SKIP_APPLE RESSAC_PUBLISH_HOST
cd "$(dirname "$0")/.."
app_dir=$PWD
objdist=$app_dir/engine/obj-aarch64-apple-darwin/dist
bucket=${RESSAC_R2_BUCKET:-ressac-update}
public=${RESSAC_PUBLISH_HOST:-https://updates.getressac.app}
wrangler=wrangler@4.153.0

fail() { print -u2 -- "publish: $*"; exit 1 }

key=${RESSAC_UPDATE_KEY:-}
[[ -n $key ]] || fail "RESSAC_UPDATE_KEY is empty: it must be the key the DMG was packaged with"
[[ $key =~ '^[a-z0-9]{24,64}$' ]] || fail "RESSAC_UPDATE_KEY must be 24 to 64 lowercase letters or digits"
prefix=updates/$key
version=$(node -p 'require("./package.json").version')
[[ -n $version ]] || fail "no version in package.json"
dmg=$app_dir/dist/Ressac-$version.dmg
mar=$app_dir/dist/Ressac-$version.mar
xml=$app_dir/dist/update.xml
for f in $dmg $mar $xml; do [[ -f $f ]] || fail "$f is missing, run package first"; done
grep -qF "displayVersion=\"$version\"" $xml || fail "dist/update.xml is not for $version, run package again"
grep -qF "/$prefix/releases/$version/" $xml || fail "dist/update.xml was packaged with another RESSAC_UPDATE_KEY"
# Entries are newest first: the first version in the file is the top entry.
notes=$(grep -m1 -oE 'version: "[^"]+"' shared/release-notes.ts || true)
[[ $notes == "version: \"$version\"" ]] || fail "the top entry of shared/release-notes.ts is not $version"
if [[ -z ${RESSAC_PUBLISH_SKIP_APPLE:-} ]]; then
  xcrun stapler validate $dmg || fail "the DMG is not notarized (package with RESSAC_SIGN_IDENTITY and RESSAC_NOTARY_PROFILE)"
  spctl -a -t open --context context:primary-signature $dmg || fail "Gatekeeper rejects the DMG"
fi
DYLD_LIBRARY_PATH=$objdist/bin $objdist/bin/signmar -D $app_dir/src/toolkit/mozapps/update/updater/dep1.der -v $mar \
  || fail "the MAR is not signed by our key"
# A published version is never rewritten: a 404 goes on, the same MAR already there is a retry after a failed upload
# (the MAR names the build, so the DMG is not compared), anything else (another MAR, no network) stops.
remote=$(mktemp)
trap 'rm -f $remote' EXIT
url=$public/$prefix/releases/$version/Ressac-$version.mar
code=$(curl --max-time 30 -s -o $remote -w '%{http_code}' "$url?t=$(date +%s)" || true)
if [[ $code == 200 ]]; then
  cmp -s $remote $mar || fail "$version is already published with another MAR ($url): bump the version"
  print -r -- "$version is already up with this same MAR: resuming the upload"
elif [[ $code != 404 ]]; then
  fail "cannot tell whether $version is already published (HTTP $code on $url)"
fi

put() {
  local key=$1; shift
  local cmd=(r2 object put "$bucket/$key" --remote "$@")
  if [[ -n ${RESSAC_PUBLISH_DRY_RUN:-} ]]; then print -r -- "wrangler $cmd"; else npx --yes $wrangler $cmd; fi
}
put $prefix/releases/$version/Ressac-$version.mar --file $mar --content-type application/octet-stream
put $prefix/releases/$version/Ressac-$version.dmg --file $dmg --content-type application/x-apple-diskimage
# The latest DMG (Réglages › À propos, invite links). Cloudflare caches .dmg by default: it must move within minutes.
put $prefix/Ressac.dmg --file $dmg --content-type application/x-apple-diskimage --cache-control "public, max-age=300"
# Last: update.xml then never points at a file not uploaded yet.
put $prefix/browser/Darwin_aarch64-gcc3/ressac/update.xml --file $xml --content-type text/xml --cache-control no-cache
print -r -- "==> Ressac $version published. A tester's download link: pnpm run release:invite"
