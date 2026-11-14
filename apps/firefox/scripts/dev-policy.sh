# The dev app is built with the updater: an enterprise policy keeps it from fetching and installing the published release.
# Only dist/Ressac.app gets it; mach package stages from dist/bin, so the packaged app updates itself.
set -e
cd "$(dirname "$0")/.."
app=engine/obj-aarch64-apple-darwin/dist/Ressac.app
[[ -d $app ]] || exit 0
mkdir -p $app/Contents/Resources/distribution
print '{"policies":{"DisableAppUpdate":true}}' > $app/Contents/Resources/distribution/policies.json
