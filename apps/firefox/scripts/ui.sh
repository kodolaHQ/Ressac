set -e
cd "$(dirname "$0")/.."
for mode in sidebar window store agent actor; do ./node_modules/.bin/vite build --mode $mode; done
