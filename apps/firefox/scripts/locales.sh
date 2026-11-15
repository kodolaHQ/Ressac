#!/bin/zsh
# Firefox's own menus, dialogs and about: pages in Ressac's languages: Mozilla's translations, at the revision this
# engine pins (browser/locales/l10n-changesets.json), into the build's l10n folder.
# `locales.sh fetch` only fetches and prints them (package.sh: `mach package-multi-locale` builds them in);
# `locales.sh` also adds them to the dev app, whose build lists only en-US.
set -euo pipefail
cd "$(dirname "$0")/.."
# Ressac's languages other than English: the folders of locales/ (Mozilla names them the same way).
locales=(locales/*(/:t))
locales=(${locales:#en})
obj=engine/obj-aarch64-apple-darwin
base=$(sed -n 's/^L10NBASEDIR = //p' $obj/config/autoconf.mk)
[[ -n $base ]] || { print -u2 "locales: no L10NBASEDIR in $obj/config/autoconf.mk (build the engine first)"; exit 1; }
rev=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["revision"])' engine/browser/locales/l10n-changesets.json $locales[1])
stale=$([[ $(git -C $base rev-parse HEAD 2>/dev/null) == $rev ]] || print 1)
for l in $locales; do [[ -d $base/$l ]] || stale=1; done
if [[ -n $stale ]]; then
  print -u2 "==> Mozilla translations ($locales) at $rev"
  mkdir -p $base
  git -C $base init -q
  git -C $base remote get-url origin >/dev/null 2>&1 || git -C $base remote add origin https://github.com/mozilla-l10n/firefox-l10n.git
  git -C $base sparse-checkout set $locales
  git -C $base fetch -q --depth 1 --filter=blob:none origin $rev
  git -C $base checkout -q --force FETCH_HEAD
fi
if [[ ${1:-} == fetch ]]; then print -r -- $locales; exit 0; fi
for l in $locales; do make -s -C $obj chrome-$l MOZ_CHROME_MULTILOCALE="$locales" >/dev/null; done
print -r -- "${(j:,:)locales},en-US" > $obj/dist/bin/res/multilocale.txt
