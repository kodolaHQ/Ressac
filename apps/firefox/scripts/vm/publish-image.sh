#!/bin/zsh
# Uploads the machine image build-image.sh made (dist/vm/) to R2, public under updates.getressac.app/vm/, with its package
# list and GPL sources next to it. Needs a one-time `npx wrangler login`. A published version is never rewritten: the
# app pins the image's SHA-256. RESSAC_PUBLISH_DRY_RUN=1 prints the uploads instead of running them.
set -euo pipefail
cd "$(dirname "$0")/../.."
bucket=${RESSAC_R2_BUCKET:-ressac-update}
public=https://updates.getressac.app
wrangler=wrangler@4.153.0

fail() { print -u2 -- "publish-image: $*"; exit 1 }

images=(dist/vm/ressac-vm-*.raw.zst(N))
(( $#images == 1 )) || fail "expected one dist/vm/ressac-vm-*.raw.zst, found $#images: run build-image.sh"
image=$images[1]
name=${image:t:r:r}
for f in dist/vm/packages.txt dist/vm/sources.tar; do [[ -f $f ]] || fail "$f is missing, run build-image.sh"; done
code=$(curl --max-time 30 -s -o /dev/null -w '%{http_code}' "$public/vm/${image:t}" || true)
[[ $code == 404 ]] || fail "$public/vm/${image:t} answers HTTP $code: already published (or no network)"

put() {
  local cmd=(r2 object put "$bucket/vm/$1" --remote --file $2 --content-type $3)
  if [[ -n ${RESSAC_PUBLISH_DRY_RUN:-} ]]; then print -r -- "wrangler $cmd"; else npx --yes $wrangler $cmd; fi
}
put $name.packages.txt dist/vm/packages.txt text/plain
put $name.sources.tar dist/vm/sources.tar application/x-tar
# Last: the image is only reachable once its licence files are.
put ${image:t} $image application/zstd
print -r -- "==> $public/vm/${image:t}"
print -r -- "    SHA-256 $(shasum -a 256 $image | cut -d' ' -f1), $(stat -f %z $image) bytes"
