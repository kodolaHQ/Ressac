#!/bin/zsh
# The Firefox sources (~23 GB) live outside the repository, in ~/WebAiOs-firefox/engine; engine/ is a symlink to them.
#   install: download Firefox (surfer download), move it out of the repository and create the link.
#   link:    only create the link (new checkout, worktree).
#   prune:   remove dangling links into a WebAiOs checkout (left by a deleted worktree that ran the import).
set -e
cd "${0:A:h}/.."
TARGET="$HOME/WebAiOs-firefox/engine"
case "$1" in
  install)
    [ -e "$TARGET" ] && { echo "$TARGET already exists: use \"link\"" >&2; exit 1; }
    surfer download
    mkdir -p "${TARGET:h}"
    mv engine "$TARGET"
    ln -s "$TARGET" engine
    ;;
  link)
    [ -d "$TARGET" ] || { echo "$TARGET is missing: run \"install\" first" >&2; exit 1; }
    [ -L engine ] && exit 0
    ln -s "$TARGET" engine
    ;;
  prune)
    # -L engine follows the symlink; links under obj-* are the build's own.
    find -L engine -path 'engine/obj-*' -prune -o -type l ! -exec test -e {} \; -print 2>/dev/null |
      while read -r l; do if [[ "$(readlink "$l")" == */apps/firefox/src/* ]]; then rm "$l"; fi; done
    ;;
  *) echo "usage: engine.sh install|link|prune" >&2; exit 1 ;;
esac
