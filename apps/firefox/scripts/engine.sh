#!/bin/zsh
# The Firefox sources (~23 GB) live outside the repository, in ~/Ressac-firefox/engine; engine/ is a symlink to them.
#   install: download Firefox (surfer download), move it out of the repository and create the link.
#   link:    only create the link (new checkout, worktree).
#   prune:   remove links into another Ressac checkout, dangling or not: surfer import never replaces an existing link,
#            so after another checkout (or a deleted worktree) ran the import, its files would stay in the build.
set -e
cd "${0:A:h}/.."
TARGET="$HOME/Ressac-firefox/engine"
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
    # Our links only live under the top-level directories of src/ (engine/browser resolves through the engine link).
    own="$PWD/src/"
    for d in src/*(/N); do
      find "engine/${d#src/}" -type l -print 2>/dev/null |
        while IFS= read -r l; do
          t="$(readlink "$l")"
          if [[ "$t" == */apps/firefox/src/* && ( "$t" != "$own"* || ! -e "$l" ) ]]; then rm "$l" || echo "warning: could not remove $l" >&2; fi
        done
    done
    ;;
  *) echo "usage: engine.sh install|link|prune" >&2; exit 1 ;;
esac
