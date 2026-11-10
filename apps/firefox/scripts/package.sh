#!/bin/zsh
# Builds the friends' beta DMG: dist/WebAiOs-<version>.dmg. Run through scripts/env.sh (`pnpm run package`).
set -euo pipefail
cd "$(dirname "$0")/.."
app_dir=$PWD
repo_root=${app_dir:h:h}
engine=$app_dir/engine
objdist=$engine/obj-aarch64-apple-darwin/dist
work=$app_dir/dist/package
app=$work/WebAiOs.app
res=$app/Contents/Resources
host=$res/webaios-host
kernel=$repo_root/packages/kernel

node_version=v22.23.2
node_tar=node-$node_version-darwin-arm64.tar.gz
node_sha256=61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6
node_cache=$HOME/WebAiOs-firefox/cache
sentry_cli=@sentry/cli@2.58.6

step() { print -r -- "==> $*" }
fail() { print -u2 -- "package: $*"; exit 1 }
# The packaged UI build blanks the dev host paths and bakes the DSN into src/ and the dev app: put the dev bundles back once the app is staged.
dev_ui_dirty=
restore_dev_ui() {
  dev_ui_dirty=
  step "Restoring the dev UI bundles"
  env -u WEBAIOS_PACKAGE -u WEBAIOS_SENTRY_DSN corepack pnpm run build:ui || { print -u2 -- "package: could not restore the dev UI, run build:ui"; return 1 }
}
node_x=
cleanup() {
  if [[ -n $node_x ]]; then rm -rf $node_x; fi
  if [[ -n $dev_ui_dirty ]]; then restore_dev_ui; fi
}
trap cleanup EXIT

# 1. Version and telemetry.
version=$(node -p 'require("./surfer.json").brands.webaios.release.displayVersion')
[[ -n $version ]] || fail "no version in surfer.json (brands.webaios.release.displayVersion)"
dsn=${WEBAIOS_SENTRY_DSN:-}
minidump_url=
if [[ -z $dsn ]]; then
  print -ru2 -- "warning: WEBAIOS_SENTRY_DSN is empty, packaging without telemetry"
else
  # Same transform as parseDsn in shared/telemetry.ts.
  [[ $dsn =~ '^(https?)://([^@/[:space:]]+)@([^/[:space:]]+)/([0-9]+)$' ]] || fail "WEBAIOS_SENTRY_DSN is not a valid Sentry DSN"
  minidump_url="${match[1]}://${match[3]}/api/${match[4]}/minidump/?sentry_key=${match[2]}"
fi
step "Packaging WebAiOs $version"

# 2. Build. WEBAIOS_PACKAGE=1 blanks the dev host paths in the store bundle; the DSN is baked in here.
export WEBAIOS_PACKAGE=1
build_id() { grep -s '^BuildID=' $objdist/bin/application.ini || true }
before=$(build_id)
dev_ui_dirty=1
corepack pnpm run build
# surfer build exits 0 without building when it asks, with no terminal, to go on despite unimported patches.
[[ $(build_id) != "$before" && -n $(build_id) ]] || fail "the build did not run (unimported patches? run engine:import first)"
corepack pnpm run build:host

# 3. mach package directly: `surfer package` then wants locales and a MAR we do not ship.
step "mach package"
(cd $engine && ./mach package)
staged=$objdist/webaios/WebAiOs.app
[[ -d $staged ]] || fail "mach package did not stage $staged"
rm -rf $work
mkdir -p $work
ditto $staged $app
dev_files=$(find $app \( -iname '*gtest*' -o -name 'xpcshell*' -o -name .lldbinit \) -print)
[[ -z $dev_files ]] || fail "test files in the staged app:\n$dev_files"
if grep -q 'mozilla.com' $res/application.ini; then fail "application.ini still points at Mozilla's crash server (mozconfig MOZ_CRASHREPORTER_URL)"; fi
restore_dev_ui

# 4. Node, checked against the hash published on nodejs.org.
step "Node $node_version"
mkdir -p $node_cache
if [[ ! -f $node_cache/$node_tar ]]; then
  curl -fL --retry 3 -o $node_cache/$node_tar.part https://nodejs.org/dist/$node_version/$node_tar || fail "could not download $node_tar"
  mv $node_cache/$node_tar.part $node_cache/$node_tar
fi
print -r -- "$node_sha256  $node_cache/$node_tar" | shasum -a 256 -c - >/dev/null || fail "$node_tar does not match its SHA-256, delete it from $node_cache and retry"
node_x=$(mktemp -d)
tar -xzf $node_cache/$node_tar -C $node_x node-$node_version-darwin-arm64/bin/node node-$node_version-darwin-arm64/LICENSE

# 5. The bundled host: the layout chrome/agent/command.ts expects (see test/host-bundle.test.ts).
step "webaios-host"
pty=$(realpath $kernel/node_modules/node-pty)
mkdir -p $host/node_modules/node-pty/prebuilds $host/kernel $host/LICENSES
cp $node_x/node-$node_version-darwin-arm64/bin/node $host/node
cp $node_x/node-$node_version-darwin-arm64/LICENSE $host/LICENSES/node-LICENSE
cp $app_dir/dist-host/host.mjs $host/host.mjs
cp -R $pty/package.json $pty/lib $pty/LICENSE $host/node_modules/node-pty/
cp -R $pty/prebuilds/darwin-arm64 $host/node_modules/node-pty/prebuilds/
for d in templates extensions docker; do cp -R $kernel/$d $host/kernel/$d; done
# Only names, versions, licenses: pnpm's JSON also lists this Mac's install paths.
# firefox-webaios without --prod: its UI and host bundles ship code from its devDependencies.
(cd $kernel && corepack pnpm licenses list --prod --json) > $node_x/kernel.json
corepack pnpm licenses list --json > $node_x/app.json
node -e '
  const seen = new Map();
  for (const f of process.argv.slice(1)) for (const p of Object.values(JSON.parse(require("fs").readFileSync(f, "utf8"))).flat())
    for (const v of p.versions) seen.set(`${p.name}@${v}`, `${p.name} ${v}  ${p.license}${p.homepage ? "  " + p.homepage : ""}`);
  process.stdout.write([...seen.keys()].sort().map((k) => seen.get(k)).join("\n") + "\n");
' $node_x/kernel.json $node_x/app.json > $host/LICENSES/third-party.txt
[[ -s $host/LICENSES/third-party.txt ]] || fail "empty third-party license list"

# 6. Crash reports go to our Sentry, or nowhere.
crash_section() { sed -n '/^\[Crash Reporter\]/,/^\[/p' $res/application.ini }
if [[ -n $minidump_url ]]; then
  sed -i '' "/^\[Crash Reporter\]/,/^\[/s|^ServerURL=.*|ServerURL=$minidump_url|" $res/application.ini
  crash_section | grep -qxF "ServerURL=$minidump_url" || fail "could not set the crash ServerURL in application.ini"
else
  sed -i '' '/^\[Crash Reporter\]/,/^\[/s|^Enabled=.*|Enabled=0|' $res/application.ini
  crash_section | grep -qx 'Enabled=0' || fail "could not disable the crash reporter in application.ini"
fi

# 7. No path of this Mac may ship.
step "Leak check"
leaks=$(grep -rl --binary-files=text -e "$HOME" -e "$repo_root" $app || true)
[[ -z $leaks ]] || fail "this Mac's paths ($HOME) found in:\n$leaks"

# 8. Ad hoc signature: the friends allow it once in System Settings.
step "Signing"
codesign --force --deep --sign - $app
codesign --verify --deep --strict $app || fail "codesign --verify failed"

# 9. DMG.
step "DMG"
ln -s /Applications $work/Applications
dmg=$app_dir/dist/WebAiOs-$version.dmg
hdiutil create -volname "WebAiOs $version" -srcfolder $work -format UDZO -ov $dmg

# 10. Native crash symbols (optional).
if [[ -n ${SENTRY_AUTH_TOKEN:-} && -n ${SENTRY_ORG:-} && -n ${SENTRY_PROJECT:-} ]]; then
  step "Uploading symbols"
  (cd $engine && ./mach buildsymbols)
  npx --yes $sentry_cli debug-files upload --org $SENTRY_ORG --project $SENTRY_PROJECT $objdist/crashreporter-symbols
else
  print -ru2 -- "warning: SENTRY_AUTH_TOKEN, SENTRY_ORG or SENTRY_PROJECT unset, native crashes will not be symbolicated"
fi
step "Done: $dmg"
