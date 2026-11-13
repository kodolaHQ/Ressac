#!/usr/bin/env bash
# Renders the Halo logo (configs/logo-halo.html, outside the branding folder: surfer copies every entry there as a file)
# into every branding PNG and firefox.icns.
set -euo pipefail
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "render-logo: Google Chrome not found at $CHROME" >&2; exit 1; }
B="$(cd "$(dirname "$0")/../configs/branding/ressac" && pwd)"
T="$(mktemp -d)"
shot() { # <query> <out> <size WxH>
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 \
    --virtual-time-budget=2000 --screenshot="$2" --window-size="$3" "file://$B/../../logo-halo.html$1" >/dev/null 2>&1
  [ -s "$2" ] || { echo "render-logo: Chrome produced no image for '$1'" >&2; exit 1; }
}
shot "" "$T/full.png" 1024,1024
shot "?small" "$T/small.png" 1024,1024
shot "?mac" "$T/mac.png" 1024,1024
shot "?mac&small" "$T/mac-small.png" 1024,1024
shot "?word" "$T/word.png" 1600,460
resize() { sips -z "$2" "$2" "$1" --out "$3" >/dev/null; }
for n in 16 22 24 32; do resize "$T/small.png" $n "$B/logo$n.png"; done
for n in 48 64 128 256 512; do resize "$T/full.png" $n "$B/logo$n.png"; done
cp "$B/logo512.png" "$B/logo.png"
resize "$T/mac.png" 512 "$B/logo-mac.png"
for f in about-logo:192 about-logo@2x:384 about-logo-private:192 about-logo-private@2x:384; do resize "$T/full.png" "${f#*:}" "$B/content/${f%:*}.png"; done
# about.png is 300x236: the logo centred on the dialog's night colour
sips -z 236 236 "$T/full.png" --out "$T/about236.png" >/dev/null
sips -p 236 300 --padColor 130829 "$T/about236.png" --out "$B/content/about.png" >/dev/null
# the SVG can't hold a conic gradient: embed the 512 render
printf '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,%s"/></svg>\n' "$(base64 < "$B/logo512.png" | tr -d '\n')" > "$B/content/about-logo.svg"
# wordmark: Funnel Display text rendered by Chrome (SVG-as-image can't load chrome:// fonts)
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 460"><image width="1600" height="460" href="data:image/png;base64,%s"/></svg>\n' "$(base64 < "$T/word.png" | tr -d '\n')" > "$B/content/about-wordmark.svg"
# iconset: 16 and 32 px entries (and 16@2x) come from the page-less render
S="$T/halo.iconset"; mkdir "$S"
for n in 16 32 128 256 512; do
  src=mac; [ $n -le 32 ] && src=mac-small
  resize "$T/$src.png" $n "$S/icon_${n}x${n}.png"
  resize "$T/$( [ $((n*2)) -le 32 ] && echo mac-small || echo mac).png" $((n*2)) "$S/icon_${n}x${n}@2x.png"
done
iconutil -c icns "$S" -o "$B/firefox.icns"
# macOS 26+ takes the app icon from Assets.car (Info.plist CFBundleIconName = AppIcon) before firefox.icns: without ours,
# surfer keeps Firefox's from the unofficial branding template. Same images, compiled by actool.
X="$T/Assets.xcassets/AppIcon.appiconset"; mkdir -p "$X" "$T/car"
images=""
for f in "$S"/*.png; do
  n="$(basename "$f" .png)"; cp "$f" "$X/"; size="${n#icon_}"; size="${size%@2x}"
  scale=1x; [[ "$n" == *@2x ]] && scale=2x
  images="$images{\"idiom\":\"mac\",\"size\":\"$size\",\"scale\":\"$scale\",\"filename\":\"$n.png\"},"
done
printf '{"images":[%s],"info":{"version":1,"author":"xcode"}}\n' "${images%,}" > "$X/Contents.json"
printf '{"info":{"version":1,"author":"xcode"}}\n' > "$T/Assets.xcassets/Contents.json"
xcrun actool --compile "$T/car" --platform macosx --minimum-deployment-target 11.0 --app-icon AppIcon \
  --output-partial-info-plist "$T/partial.plist" "$T/Assets.xcassets" >/dev/null
cp "$T/car/Assets.car" "$B/Assets.car"
rm -rf "$T"
