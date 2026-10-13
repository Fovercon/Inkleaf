#!/bin/bash
set -euo pipefail
arch="${1:-}"
if [ "$arch" != x64 ] && [ "$arch" != arm64 ]; then echo 'Pass x64 or arm64' >&2; exit 1; fi
version="$(node -p 'require("./package.json").version')"
image="$PWD/dist/Inkleaf-$version-linux-$arch.AppImage"
deb="$PWD/dist/Inkleaf-$version-linux-$arch.deb"
(
  cd dist
  sha256sum -c "Inkleaf-$version-linux-$arch.AppImage.sha256"
  sha256sum -c "Inkleaf-$version-linux-$arch.deb.sha256"
)
rm -rf .linux-appimage-smoke
mkdir .linux-appimage-smoke
(
  cd .linux-appimage-smoke
  "$image" --appimage-extract > /dev/null
)
if grep -R -- '--no-sandbox' .linux-appimage-smoke/squashfs-root/*.desktop; then
  echo 'AppImage desktop entry must preserve Chromium sandboxing' >&2
  exit 1
fi
test -x .linux-appimage-smoke/squashfs-root/resources/app/out/inkleaf-update-helper
mkdir -p verify
APPDIR="$PWD/.linux-appimage-smoke/squashfs-root" MDR_TEST=1 MDR_ROUND="linux-$arch-appimage" bash scripts/run-linux-ui.sh "verify/linux-$arch-appimage.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' .linux-appimage-smoke/squashfs-root/AppRun --disable-gpu

# Also exercise the real FUSE runtime, which supplies APPIMAGE for self-update.
MDR_TEST=1 MDR_ROUND="linux-$arch-appimage-runtime" bash scripts/run-linux-ui.sh "verify/linux-$arch-appimage-runtime.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' "$image" --disable-gpu

# Exercise the installed deb as a normal user; only installation uses sudo.
sudo apt-get install -y "$deb"
test "$(stat -c '%U:%G:%a' /opt/Inkleaf/chrome-sandbox)" = 'root:root:4755'
desktop=/usr/share/applications/inkleaf.desktop
test -f "$desktop"
grep -E '^Exec=.*inkleaf.*%[UF]' "$desktop"
grep '^MimeType=.*text/markdown' "$desktop"
mime=/usr/share/mime/packages/inkleaf.xml
test -f "$mime"
grep -F 'pattern="*.md"' "$mime"
grep -F 'pattern="*.markdown"' "$mime"
if grep -- '--no-sandbox' "$desktop"; then echo 'deb launcher disables sandbox' >&2; exit 1; fi
MDR_TEST=1 MDR_ROUND="linux-$arch-deb" bash scripts/run-linux-ui.sh "verify/linux-$arch-deb.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' /usr/bin/inkleaf --disable-gpu

# No MDR_TEST or fake updater API: a same-version real image tests native install
# and normal packaged UI readiness acknowledgement without altering the release.
INKLEAF_UI_SUCCESS_MARKER='[boot-ack-check] installed' bash scripts/run-linux-ui.sh "verify/linux-$arch-boot-ack.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' node scripts/test-linux-update-boot.mjs "$image" "$PWD/.linux-appimage-smoke/squashfs-root/resources/app/out/inkleaf-update-helper"
