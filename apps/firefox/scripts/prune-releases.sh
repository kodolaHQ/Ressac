#!/bin/zsh
# Deletes the published releases older than the KEEP newest under updates/<RESSAC_UPDATE_KEY>/releases/ on R2. The
# update feed only points at the newest MAR (a tester on any older version jumps straight to it), so older folders only
# take room; the few kept allow a rollback. Run by publish.sh after a release; alone: scripts/prune-releases.sh.
# Lists and deletes through R2's S3 API (wrangler cannot list), with the token in ~/.config/ressac/r2.env (RESSAC_R2_ENV
# for another file; see scripts/vm/publish-image.sh). RESSAC_PUBLISH_DRY_RUN=1 prints the deletions instead.
set -euo pipefail
bucket=${RESSAC_R2_BUCKET:-ressac-update}
keep=${RESSAC_KEEP_RELEASES:-3}
r2env=${RESSAC_R2_ENV:-$HOME/.config/ressac/r2.env}

fail() { print -u2 -- "prune-releases: $*"; exit 1 }

key=${RESSAC_UPDATE_KEY:-}
[[ $key =~ '^[a-z0-9]{24,64}$' ]] || fail "RESSAC_UPDATE_KEY must be the feed's key (24 to 64 lowercase letters or digits)"
[[ $keep =~ '^[0-9]+$' ]] && (( keep >= 2 )) || fail "RESSAC_KEEP_RELEASES must be 2 or more"
[[ -f $r2env ]] || fail "$r2env is missing (R2 API token, see scripts/vm/publish-image.sh)"
. $r2env # not exported: only the print builtin in s3() reads the key
[[ -n ${R2_ACCESS_KEY_ID:-} && -n ${R2_SECRET_ACCESS_KEY:-} && ${R2_ENDPOINT:-} == https://* ]] || fail "$r2env needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT"
endpoint=${R2_ENDPOINT%/}

prefix=updates/$key/releases/
# The key goes through curl's config on stdin, never on the command line (ps shows arguments to every process).
s3() { print -r -- "user = \"$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY\"" | curl -K - -sf --max-time 60 --aws-sigv4 "aws:amz:auto:s3" "$@" }

# Every key under the prefix (pages of 1000).
keys=()
token=""
while :; do
  query="list-type=2&prefix=${prefix//\//%2F}"
  [[ -n $token ]] && query+="&continuation-token=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' $token)"
  page=$(s3 "$endpoint/$bucket?$query") || fail "cannot list $bucket/$prefix"
  keys+=(${(f)"$(print -r -- $page | grep -oE '<Key>[^<]+</Key>' | sed -E 's/<\/?Key>//g' || true)"})
  token=$(print -r -- $page | grep -oE '<NextContinuationToken>[^<]+' | sed 's/<NextContinuationToken>//' || true)
  [[ -n $token ]] || break
done

# Versions, newest first (sort -V); only plain x.y.z folders are ever touched.
versions=(${(f)"$(print -rl -- $keys | sed -E "s|^${prefix}([^/]+)/.*|\1|" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -uV -r)"})
(( $#versions > keep )) || { print -r -- "prune-releases: $#versions releases, nothing to delete (keeping $keep)"; exit 0 }
old=(${versions[$((keep + 1)),-1]})
print -r -- "prune-releases: keeping ${versions[1,$keep]}, deleting $old"
for k in $keys; do
  v=${${k#$prefix}%%/*}
  (( ${old[(Ie)$v]} )) || continue
  if [[ -n ${RESSAC_PUBLISH_DRY_RUN:-} ]]; then print -r -- "delete $bucket/$k"
  else s3 -X DELETE "$endpoint/$bucket/$k" >/dev/null || fail "cannot delete $k"; fi
done
