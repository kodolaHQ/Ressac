#!/bin/zsh
# The Firefox sources (~23 GB) live outside the repository, in ~/WebAiOs-firefox/engine; engine/ is a symlink to them.
#   install: download Firefox (surfer download), move it out of the repository and create the link.
#   link:    only create the link (new checkout, worktree).
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
  *) echo "usage: engine.sh install|link" >&2; exit 1 ;;
esac
