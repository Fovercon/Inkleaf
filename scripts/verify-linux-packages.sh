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
MDR_TEST=1 MDR_ROUND="linux-$arch-appimage" timeout --kill-after=10s 240s dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' .linux-appimage-smoke/squashfs-root/AppRun --disable-gpu 2>&1 | tee "verify/linux-$arch-appimage.log"
grep -q 'verify screenshot written' "verify/linux-$arch-appimage.log"

# Also exercise the real FUSE runtime, which supplies APPIMAGE for self-update.
MDR_TEST=1 MDR_ROUND="linux-$arch-appimage-runtime" timeout --kill-after=10s 240s dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' "$image" --disable-gpu 2>&1 | tee "verify/linux-$arch-appimage-runtime.log"
grep -q 'verify screenshot written' "verify/linux-$arch-appimage-runtime.log"

# Exercise the installed deb as a normal user; only installation uses sudo.
sudo apt-get install -y "$deb"
test "$(stat -c '%U:%G:%a' /opt/Inkleaf/chrome-sandbox)" = 'root:root:4755'
desktop=/usr/share/applications/inkleaf.desktop
test -f "$desktop"
grep -E '^Exec=.*inkleaf.*%[UF]' "$desktop"
if grep -- '--no-sandbox' "$desktop"; then echo 'deb launcher disables sandbox' >&2; exit 1; fi
MDR_TEST=1 MDR_ROUND="linux-$arch-deb" timeout --kill-after=10s 240s dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' /usr/bin/inkleaf --disable-gpu 2>&1 | tee "verify/linux-$arch-deb.log"
grep -q 'verify screenshot written' "verify/linux-$arch-deb.log"
