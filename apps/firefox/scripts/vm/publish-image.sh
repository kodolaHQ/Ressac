#!/bin/zsh
# Uploads the machine image build-image.sh made (dist/vm/) to R2, public under updates.getressac.app/vm/, with its package
# list and GPL sources next to it, then mirrors the same files in a GitHub release `vm-<version>` tagged on the commit
# whose recipe built it (dist/vm/commit.txt, written by build-image.sh) (the app downloads from R2 only). Uploads through R2's S3 API with curl (wrangler caps files at 300 MiB), with an R2 API
# token for the bucket in ~/.config/ressac/r2.env (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT; RESSAC_R2_ENV for
# another file); needs `gh auth login` and that commit pushed. A published version is never rewritten: the app pins the image's SHA-256.
# RESSAC_PUBLISH_DRY_RUN=1 prints the uploads instead of running them.
set -euo pipefail
cd "$(dirname "$0")/../.."
bucket=${RESSAC_R2_BUCKET:-ressac-update}
public=https://updates.getressac.app
r2env=${RESSAC_R2_ENV:-$HOME/.config/ressac/r2.env}
repo=kodolaHQ/Ressac

fail() { print -u2 -- "publish-image: $*"; exit 1 }

images=(dist/vm/ressac-vm-*.raw.zst(N))
(( $#images == 1 )) || fail "expected one dist/vm/ressac-vm-*.raw.zst, found $#images: run build-image.sh"
image=$images[1]
name=${image:t:r:r}
for f in dist/vm/packages.txt dist/vm/sources.tar dist/vm/commit.txt; do [[ -f $f ]] || fail "$f is missing, run build-image.sh"; done
# Its own query string, as publish.sh: Cloudflare caches a 404 for 4 h, and this check runs just before the upload.
code=$(curl --max-time 30 -s -o /dev/null -w '%{http_code}' "$public/vm/${image:t}?t=$(date +%s)" || true)
[[ $code == 404 ]] || fail "$public/vm/${image:t} answers HTTP $code: already published (or no network)"
# Checked before any upload, so a refused mirror never leaves R2 half published.
commit=$(<dist/vm/commit.txt)
[[ $commit =~ '^[0-9a-f]{40}$' ]] || fail "dist/vm/commit.txt is '$commit': rebuild from a clean recipe"
[[ -n $(git branch -r --contains $commit 2>/dev/null) ]] || fail "commit $commit is not pushed: the release tag must point at a public recipe"
gh release view vm-${name#ressac-vm-} --repo $repo >/dev/null 2>&1 && fail "GitHub release vm-${name#ressac-vm-} already exists"

if [[ -z ${RESSAC_PUBLISH_DRY_RUN:-} ]]; then
  [[ -f $r2env ]] || fail "$r2env is missing (an R2 API token with Object Read & Write on $bucket)"
  . $r2env # not exported: only the print builtin below reads the key
  [[ -n ${R2_ACCESS_KEY_ID:-} && -n ${R2_SECRET_ACCESS_KEY:-} && ${R2_ENDPOINT:-} == https://* ]] || fail "$r2env needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT"
fi
put() {
  if [[ -n ${RESSAC_PUBLISH_DRY_RUN:-} ]]; then print -r -- "PUT $bucket/vm/$1 <- $2 ($3)"; return; fi
  print -r -- "==> $bucket/vm/$1"
  # The key goes through curl's config on stdin, never on the command line.
  print -r -- "user = \"$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY\"" | curl -K - --fail-with-body -sS --aws-sigv4 aws:amz:auto:s3 \
    -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" -H "content-type: $3" -T $2 "${R2_ENDPOINT%/}/$bucket/vm/$1" >/dev/null
}
put $name.packages.txt dist/vm/packages.txt text/plain
put $name.sources.tar dist/vm/sources.tar application/x-tar
# Last: the image is only reachable once its licence files are.
put ${image:t} $image application/zstd
sha=$(shasum -a 256 $image | cut -d' ' -f1)
version=${name#ressac-vm-}
mirror=(release create vm-$version --repo $repo --target $commit --latest=false --title "Machine image $version"
  --notes "Mirror of $public/vm/${image:t} (SHA-256 \`$sha\`, the value the app pins). Built by [scripts/vm/build-image.sh](https://github.com/$repo/tree/$commit/apps/firefox/scripts/vm) at this commit; package list and GPL sources attached."
  "$image" "dist/vm/packages.txt#$name.packages.txt" "dist/vm/sources.tar#$name.sources.tar")
if [[ -n ${RESSAC_PUBLISH_DRY_RUN:-} ]]; then print -r -- "gh $mirror"; else gh $mirror; fi
print -r -- "==> $public/vm/${image:t}"
print -r -- "    mirror https://github.com/$repo/releases/tag/vm-$version"
print -r -- "    SHA-256 $sha, $(stat -f %z $image) bytes"
