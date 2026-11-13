#!/usr/bin/env bash
# One-shot rename WebAiOs -> Ressac (plan 61, task 1). Idempotent. Deleted at the end of the plan.
set -euo pipefail
cd "$(dirname "$0")/.."
SELF=scripts/rename-ressac.sh
MAP='s/WebAiOs-Firefox/Ressac/g; s/WebAiOs/Ressac/g; s/webaios/ressac/g; s/WEBAIOS/RESSAC/g; s/Webaios/Ressac/g'

# (a) move every tracked file whose path contains the name (file by file, folders follow)
git ls-files | grep -i webaios | while IFS= read -r p; do
  q=$(printf '%s' "$p" | perl -pe "$MAP")
  mkdir -p "$(dirname "$q")"
  git mv "$p" "$q"
done
# What is left of the old folders is generated and git-ignored (ui.sh rebuilds it): the 12 files, then the empty folders.
GEN=apps/firefox/src/browser/base/content/webaios
if [ -d "$GEN" ]; then
  git ls-files --others --ignored --exclude-standard -- "$GEN" | while IFS= read -r f; do rm -f -- "$f"; done
  find "$GEN" -depth -type d -empty -exec rmdir {} \;
fi
find apps packages -path '*/node_modules' -prune -o -path apps/firefox/engine -prune -o -type d -iname '*webaios*' -empty -print -exec rmdir {} \; 2>/dev/null || true

# (b) contents; the lockfile is regenerated, the shipped-display fixtures are pinned by hash
git ls-files -z | grep -zv -e '^pnpm-lock.yaml$' -e "^$SELF\$" -e '^packages/kernel/test/workspace/shipped-displays/' \
  | xargs -0 perl -pi -e "$MAP"

# (c) what is left
git grep -il webaios || true
