# The dev app is built with the updater: an enterprise policy keeps it from fetching and installing the published release.
# Only dist/Ressac.app gets it; mach package stages from dist/bin, so the packaged app updates itself.
set -e
cd "$(dirname "$0")/.."
app=engine/obj-aarch64-apple-darwin/dist/Ressac.app
[[ -d $app ]] || { print -u2 "dev-policy: $app is missing, the dev app would update itself"; exit 1; }
mkdir -p $app/Contents/Resources/distribution
print '{"policies":{"DisableAppUpdate":true}}' > $app/Contents/Resources/distribution/policies.json
