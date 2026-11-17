#!/bin/zsh
# Builds the friends' beta DMG: dist/Ressac-<version>.dmg. Run through scripts/env.sh (`pnpm run package`).
set -euo pipefail
cd "$(dirname "$0")/.."
app_dir=$PWD
repo_root=${app_dir:h:h}
engine=$app_dir/engine
objdist=$engine/obj-aarch64-apple-darwin/dist
work=$app_dir/dist/package
app=$work/Ressac.app
res=$app/Contents/Resources
host=$res/ressac-host
kernel=$repo_root/packages/kernel

node_version=v22.23.2
node_tar=node-$node_version-darwin-arm64.tar.gz
node_sha256=61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6
# Under dist/ (git-ignored), outside $work: neither the cleanup, the leak check nor the DMG touch it.
node_cache=$app_dir/dist/cache
sentry_cli=@sentry/cli@2.58.6
source $app_dir/scripts/llama-server.sh
source $app_dir/scripts/vm-tools.sh

step() { print -r -- "==> $*" }
fail() { print -u2 -- "package: $*"; exit 1 }
# exit, not return: zsh skips the EXIT trap when errexit fires on a function return, and the trap is the retry.
# The packaged UI build blanks the dev host paths and bakes the DSN into src/ and the dev app: put the dev bundles back once the app is staged.
dev_ui_dirty=
# exit, not return: zsh skips the EXIT trap (the retry) when errexit fires on a function return.
restore_dev_ui() {
  step "Restoring the dev UI bundles"
  env -u RESSAC_PACKAGE -u RESSAC_SENTRY_DSN corepack pnpm run build:ui || { print -u2 -- "package: could not restore the dev UI, run build:ui"; exit 1 }
  dev_ui_dirty=
}
node_x=
cleanup() {
  if [[ -n $node_x ]]; then rm -rf $node_x; fi
  if [[ -n $dev_ui_dirty ]]; then restore_dev_ui; fi
}
trap cleanup EXIT

# 1. Version and telemetry.
# The Ressac version lives in package.json (the UI bakes it in); surfer.json's displayVersion only moves with the engine.
version=$(node -p 'require("./package.json").version')
[[ -n $version ]] || fail "no version in package.json"
dsn=${RESSAC_SENTRY_DSN:-}
minidump_url=
if [[ -z $dsn ]]; then
  print -ru2 -- "warning: RESSAC_SENTRY_DSN is empty, packaging without telemetry"
else
  # Same transform as parseDsn in shared/telemetry.ts.
  [[ $dsn =~ '^(https?)://([^@/[:space:]]+)@([^/[:space:]]+)/([0-9]+)$' ]] || fail "RESSAC_SENTRY_DSN is not a valid Sentry DSN"
  minidump_url="${match[1]}://${match[3]}/api/${match[4]}/minidump/?sentry_key=${match[2]}"
fi
# RESSAC_UPDATE_KEY names the feed's secret folder, updates.getressac.app/updates/<key>/ (scripts/publish.sh): a beta
# DMG only goes to invited testers, so its feed and downloads are not at a path written in this public code.
update_key=${RESSAC_UPDATE_KEY:-}
[[ -z $update_key || $update_key =~ '^[a-z0-9]{24,64}$' ]] || fail "RESSAC_UPDATE_KEY must be 24 to 64 lowercase letters or digits"
[[ -n $update_key ]] || print -ru2 -- "warning: RESSAC_UPDATE_KEY is empty, packaging without updates"
step "Packaging Ressac $version"

# 2. Build. RESSAC_PACKAGE=1 blanks the dev host paths in the store bundle; the DSN is baked in here.
export RESSAC_PACKAGE=1
build_id() { grep -s '^BuildID=' $objdist/bin/application.ini || true }
before=$(build_id)
dev_ui_dirty=1
corepack pnpm run build
# surfer build exits 0 without building when it asks, with no terminal, to go on despite unimported patches.
[[ $(build_id) != "$before" && -n $(build_id) ]] || fail "the build did not run (unimported patches? run engine:import first)"
corepack pnpm run build:host

# 3. mach directly: `surfer package` then wants locales, and its MAR would be built before our signature (step 9 builds ours).
# Multi-locale: Firefox's own menus and pages in Ressac's languages too.
locales=($(zsh scripts/locales.sh fetch))
step "mach package-multi-locale (en-US $locales)"
(cd $engine && ./mach package-multi-locale --locales en-US $locales)
staged=$objdist/ressac/Ressac.app
[[ -d $staged ]] || fail "mach package did not stage $staged"
rm -rf $work
mkdir -p $work
ditto $staged $app
# The icons come from the engine's copy of the branding, refreshed only by engine:import: catch a stale one.
for icon in firefox.icns Assets.car; do
  cmp -s $app_dir/configs/branding/ressac/$icon $res/$icon || fail "$icon in the app differs from configs/branding/ressac (copy it into engine/browser/branding/ressac, or run engine:import, then package again)"
done
dev_files=$(find $app \( -iname '*gtest*' -o -name 'xpcshell*' -o -name .lldbinit \) -print)
[[ -z $dev_files ]] || fail "test files in the staged app:\n$dev_files"
# An incremental build after the rename keeps the old launcher and helpers in dist/bin, and mach package copies them.
old_files=$(find $app -iname '*webaios*' -print)
[[ -z $old_files ]] || fail "old-name files in the staged app (stale build products, delete them from the object directory's dist/bin):\n$old_files"
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
step "llama-server $llama_version"
fetch_llama $node_cache || fail "could not fetch llama-server"
llama_src=$node_cache/llama-$llama_version
step "Lima $lima_version, Podman $podman_version"
fetch_vm_tools $node_cache/vm-tools || fail "could not fetch Lima or Podman"
lima_src=$node_cache/vm-tools/lima-$lima_version

# 5. The bundled host: the layout chrome/agent/command.ts expects (see test/host-bundle.test.ts).
step "ressac-host"
pty=$(realpath $kernel/node_modules/node-pty)
mkdir -p $host/node_modules/node-pty/prebuilds $host/kernel $host/LICENSES
cp $node_x/node-$node_version-darwin-arm64/bin/node $host/node
cp $node_x/node-$node_version-darwin-arm64/LICENSE $host/LICENSES/node-LICENSE
# llama-server and its dylibs, side by side (its rpath is @loader_path); the decision model is downloaded at first use.
mkdir -p $host/llama
cp $llama_src/llama-server $llama_src/*.dylib $host/llama/
cp $llama_src/LICENSE $host/LICENSES/llama.cpp-LICENSE
# The machine (host/host.ts vmTools): Lima's own layout, so limactl finds its guest agent and templates in share/lima.
# Only the Linux aarch64 guest agent: the machine is Linux on Apple silicon (no macOS guests, no Lima plugins).
mkdir -p $host/vm/bin $host/vm/share/lima
cp $lima_src/bin/limactl $host/vm/bin/
cp $lima_src/share/lima/lima-guestagent.Linux-aarch64.gz $host/vm/share/lima/
cp -R $lima_src/share/lima/templates $host/vm/share/lima/
cp $node_cache/vm-tools/podman-$podman_version/podman $host/vm/podman
cp $app_dir/scripts/vm/lima.yaml $host/vm/lima.yaml
cp $lima_src/share/doc/lima/LICENSE $host/LICENSES/lima-LICENSE
# Podman's release zip carries no LICENSE: it is Apache-2.0 too, the same text as Lima's.
{ print -r -- "Podman $podman_version remote client, https://github.com/containers/podman, Apache License 2.0:"; print; cat $lima_src/share/doc/lima/LICENSE } > $host/LICENSES/podman-LICENSE
# The machine image is downloaded at first use, not shipped; its package list and GPL sources are published next to it.
vm_image=$(sed -nE 's|^  url: "(https://[^"]+)\.raw\.zst",$|\1|p' $app_dir/host/machine.ts)
[[ $vm_image == https://* ]] || fail "no VM_IMAGE url in host/machine.ts"
cat > $host/LICENSES/machine-image-NOTICE.txt <<NOTICE
Ressac downloads its Linux machine image ($vm_image.raw.zst) at first use: Alpine Linux with Podman
and the workshop image. Each package in it keeps its own license. The list (name, version, origin, aports commit,
license) and the sources of every GPL-licensed package are published next to the image:
  $vm_image.packages.txt
  $vm_image.sources.tar
NOTICE
cp $app_dir/dist-host/host.mjs $host/host.mjs
cp -R $pty/package.json $pty/lib $pty/LICENSE $host/node_modules/node-pty/
cp -R $pty/prebuilds/darwin-arm64 $host/node_modules/node-pty/prebuilds/
# Only the files git tracks (their working-tree content): a stray file left in these folders never ships in the signed app.
(cd $kernel && git ls-files -z -- templates extensions docker | tar --null -T - -cf -) | tar -xf - -C $host/kernel
[[ -f $host/kernel/docker/workshop.Dockerfile ]] || fail "kernel resources not copied"
# Only names, versions, licenses: pnpm's JSON also lists this Mac's install paths.
# firefox-ressac without --prod: its UI and host bundles ship code from its devDependencies.
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
# The dev app's policy keeps it from updating (scripts/dev-policy.sh): the packaged app must update itself.
rm -f $res/distribution/policies.json
if grep -rq DisableAppUpdate $res/distribution 2>/dev/null; then fail "the staged app still disables updates (Contents/Resources/distribution)"; fi
# The update feed, under the secret folder, through the AppUpdateURL policy: Firefox ignores application.ini's
# [AppUpdate] URL (the binary carries its own copy). Without a key the app keeps the compiled-in public path, which
# nothing publishes to.
if [[ -n $update_key ]]; then
  feed="https://updates.getressac.app/updates/$update_key/browser/Darwin_aarch64-gcc3/ressac/update.xml"
  mkdir -p $res/distribution
  print -r -- "{\"policies\": {\"AppUpdateURL\": \"$feed\"}}" > $res/distribution/policies.json
  node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).policies.AppUpdateURL !== process.argv[2]) process.exit(1)' \
    $res/distribution/policies.json "$feed" || fail "could not write the update feed policy"
fi
# The update removes what precomplete lists: regenerate it now that ressac-host is in.
(cd $res && python3 $engine/config/createprecomplete.py)

# 8. Signature. RESSAC_SIGN_IDENTITY (a "Developer ID Application: …" in the keychain) signs for real; unset, ad hoc.
step "Signing"
plutil -replace CFBundleShortVersionString -string $version $app/Contents/Info.plist
# Ressac asks for macOS 13.3: the shipped llama-server (d1, search model) is built for it (Node needs 11, Firefox 10.15).
plutil -replace LSMinimumSystemVersion -string 13.3 $app/Contents/Info.plist
identity=${RESSAC_SIGN_IDENTITY:-}
if [[ -z $identity ]]; then
  print -ru2 -- "warning: RESSAC_SIGN_IDENTITY is empty, ad hoc signature (Gatekeeper will block the app)"
  codesign --force --deep --sign - $app
else
  # Firefox's own signer: each helper gets its entitlements from the engine's taskcluster/config.yml.
  # without-restricted: no passkey entitlement until Apple grants it (it needs a provisioning profile).
  (cd $engine && ./mach macos-sign -a $app -s "$identity" -e production-without-restricted -c release) || fail "mach macos-sign failed"
  # mach does not know our bundled host: sign it, then reseal the app with the entitlements mach gave it.
  pty_bin=$host/node_modules/node-pty/prebuilds/darwin-arm64
  codesign --force --timestamp --options runtime --sign "$identity" $pty_bin/pty.node $pty_bin/spawn-helper
  codesign --force --timestamp --options runtime --entitlements $app_dir/scripts/node-entitlements.plist --sign "$identity" $host/node
  # The dylibs before the binary that loads them; no entitlement: llama-server only maps the model and serves on 127.0.0.1.
  codesign --force --timestamp --options runtime --sign "$identity" $host/llama/*.dylib
  codesign --force --timestamp --options runtime --sign "$identity" $host/llama/llama-server
  codesign --force --timestamp --options runtime --entitlements $app_dir/scripts/limactl-entitlements.plist --sign "$identity" $host/vm/bin/limactl
  codesign --force --timestamp --options runtime --sign "$identity" $host/vm/podman
  codesign -d --entitlements - --xml $app > $node_x/app-entitlements.plist
  codesign --force --timestamp --options runtime --entitlements $node_x/app-entitlements.plist --sign "$identity" $app
fi
codesign --verify --deep --strict $app || fail "codesign --verify failed"

# 9. Full update archive of the signed app, signed with our MAR key (scripts/mar-key.sh), and its update.xml. Nothing is uploaded.
mar_p12=$HOME/.config/ressac/mar-signing.p12
# A stale update.xml, MAR or DMG from an earlier run must not outlive this one (publish would pair them).
rm -f $app_dir/dist/update.xml $app_dir/dist/Ressac-$version.mar $app_dir/dist/Ressac-$version.dmg
mar_pw=$(security find-generic-password -s ressac-mar-signing -w 2>/dev/null || true)
if [[ ! -f $mar_p12 || -z $mar_pw || -z $update_key ]]; then
  print -ru2 -- "warning: no MAR key or no RESSAC_UPDATE_KEY, packaging without an update archive"
else
  step "Update archive"
  # The key only lives in this throwaway NSS db, under $node_x, which cleanup deletes.
  db=$node_x/nssdb
  mkdir -p $db
  export DYLD_LIBRARY_PATH=$objdist/bin
  $objdist/bin/certutil -N -d $db --empty-password
  # The password goes through a mode-600 file: on argv any local process could read it.
  (umask 077; print -rn -- "$mar_pw" > $node_x/mar-pw)
  $objdist/bin/pk12util -i $mar_p12 -d $db -w $node_x/mar-pw -K '' >/dev/null || fail "pk12util could not import $mar_p12"
  unsigned=$node_x/unsigned.mar
  mar=$app_dir/dist/Ressac-$version.mar
  gecko_version=$(sed -n 's/^Version=//p' $res/application.ini)
  MAR=$objdist/host/bin/mar MOZ_PRODUCT_VERSION=$gecko_version MAR_CHANNEL_ID=ressac \
    $engine/tools/update-packaging/make_full_update.sh -q $unsigned $app ressac || fail "make_full_update.sh failed"
  rm -f $mar
  $objdist/bin/signmar -d $db -n ressac-mar -s $unsigned $mar || fail "signmar could not sign the update archive"
  # Checked against the public certificate the app ships, not the key.
  $objdist/bin/signmar -D $app_dir/src/toolkit/mozapps/update/updater/dep1.der -v $mar || { rm -f $mar; fail "the update archive's signature does not verify" }
  unset DYLD_LIBRARY_PATH
  # Firefox compares update.xml's buildID with the one compiled into the binary, not application.ini's (scripts/update-xml.mjs).
  build_ids=($(strings -a $app/Contents/MacOS/ressac | grep -xE '20[0-9]{12}' || true))
  (( ${#build_ids} == 1 )) || fail "expected one build ID in Contents/MacOS/ressac, found ${#build_ids}"
  node scripts/update-xml.mjs $mar $res/application.ini $version $update_key ${build_ids[1]} > $app_dir/dist/update.xml
  print -r -- "$mar ($(( $(stat -f %z $mar) / 1048576 )) MB), $app_dir/dist/update.xml"
fi

# 10. DMG, notarized when RESSAC_NOTARY_PROFILE names a `xcrun notarytool store-credentials` profile.
step "DMG"
ln -s /Applications $work/Applications
dmg=$app_dir/dist/Ressac-$version.dmg
hdiutil create -volname "Ressac $version" -srcfolder $work -format UDZO -ov $dmg
if [[ -n $identity ]]; then
  codesign --timestamp --sign "$identity" $dmg
  if [[ -n ${RESSAC_NOTARY_PROFILE:-} ]]; then
    step "Notarization (a few minutes)"
    xcrun notarytool submit $dmg --keychain-profile $RESSAC_NOTARY_PROFILE --wait | tee $node_x/notary.txt
    grep -q 'status: Accepted' $node_x/notary.txt || fail "notarization refused, see: xcrun notarytool log <id> --keychain-profile $RESSAC_NOTARY_PROFILE"
    xcrun stapler staple $dmg
    spctl -a -t open --context context:primary-signature $dmg || fail "Gatekeeper rejects the DMG"
  else
    print -ru2 -- "warning: RESSAC_NOTARY_PROFILE is empty, DMG not notarized (Gatekeeper will block the app)"
  fi
fi

# 11. Native crash symbols (optional).
if [[ -n ${SENTRY_AUTH_TOKEN:-} && -n ${SENTRY_ORG:-} && -n ${SENTRY_PROJECT:-} ]]; then
  step "Uploading symbols"
  (cd $engine && ./mach buildsymbols)
  npx --yes $sentry_cli debug-files upload --org $SENTRY_ORG --project $SENTRY_PROJECT $objdist/crashreporter-symbols
else
  print -ru2 -- "warning: SENTRY_AUTH_TOKEN, SENTRY_ORG or SENTRY_PROJECT unset, native crashes will not be symbolicated"
fi
step "Done: $dmg"
