set -e
cd "$(dirname "$0")/.."
# The dev build runs the llama-server fetched here (scripts/paths.ts); offline, the bundles still build, only the decision model fails.
zsh -c '. scripts/llama-server.sh && fetch_llama dist/cache' || echo "warning: llama-server not fetched, the local decision model will not start"
for mode in sidebar window store agent actor; do ./node_modules/.bin/vite build --mode $mode; done
# Chrome pages and actors have no `process` nor Node modules: one Node kernel module pulled into a bundle breaks every window.
ui=src/browser/base/content/ressac
if grep -lE 'process\.env|from ?"node:|require\("node:' $ui/{sidebar,agent,window}.js $ui/*-actor.sys.mjs; then
  echo "error: Node code in the UI bundles above (a value import from @ressac/kernel or shared/api.ts?)" >&2
  exit 1
fi
