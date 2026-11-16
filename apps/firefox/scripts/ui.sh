set -e
cd "$(dirname "$0")/.."
# The dev build runs the llama-server fetched here (scripts/paths.ts); offline, the bundles still build, only the decision model fails.
zsh -c '. scripts/llama-server.sh && fetch_llama dist/cache' || echo "warning: llama-server not fetched, the local decision model will not start"
for mode in sidebar window store agent actor; do ./node_modules/.bin/vite build --mode $mode; done
