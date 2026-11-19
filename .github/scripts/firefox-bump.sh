#!/bin/bash
# Prints the Firefox version Mozilla ships if it is newer than surfer.json's, after writing it into surfer.json;
# prints nothing when we are up to date. FIREFOX_LATEST overrides Mozilla's answer (tests, manual runs).
# Usage: firefox-bump.sh <surfer.json>
set -euo pipefail
file=$1
latest=${FIREFOX_LATEST:-$(curl -fsS --retry 3 https://product-details.mozilla.org/1.0/firefox_versions.json | jq -r .LATEST_FIREFOX_VERSION)}
[[ $latest =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || { echo "unexpected version from Mozilla: $latest" >&2; exit 1; }
current=$(jq -r .version.version "$file")
[[ $latest != "$current" ]] || exit 0
# Only forward: a lower answer (a stale CDN copy) is not an update.
[[ $(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -1) == "$latest" ]] || exit 0
[[ $(grep -c "\"version\": \"$current\"" "$file") == 1 ]] || { echo "surfer.json: Firefox version line not found once" >&2; exit 1; }
sed -i.bak "s/\"version\": \"$current\"/\"version\": \"$latest\"/" "$file" && rm "$file.bak"
echo "$latest"
