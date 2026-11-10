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
image_desktop="$(find .linux-appimage-smoke/squashfs-root -maxdepth 1 -name '*.desktop' -print -quit)"
grep -Fx 'StartupWMClass=inkleaf' "$image_desktop"
grep -Fx 'MimeType=text/markdown;text/x-markdown;' "$image_desktop"
mkdir -p verify
APPDIR="$PWD/.linux-appimage-smoke/squashfs-root" MDR_TEST=1 MDR_ROUND="linux-$arch-appimage" bash scripts/run-linux-ui.sh "verify/linux-$arch-appimage.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' .linux-appimage-smoke/squashfs-root/AppRun --disable-gpu

# Also exercise the real FUSE runtime, which supplies APPIMAGE for self-update.
runtime_profile=
source /etc/os-release
if [ "$VERSION_ID" = 24.04 ] && [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && command -v apparmor_parser >/dev/null 2>&1; then
  runtime_profile=inkleaf-ci-appimage-runtime
  cat > "${RUNNER_TEMP:?}/inkleaf-ci-runtime-apparmor" <<EOF
abi <abi/4.0>,
include <tunables/global>
profile $runtime_profile "$image" flags=(unconfined) {
  userns,
}
profile inkleaf-ci-appimage-update "$PWD/.linux-update-boot-*/Inkleaf.AppImage" flags=(unconfined) {
  userns,
}
EOF
  sudo apparmor_parser -r "$RUNNER_TEMP/inkleaf-ci-runtime-apparmor"
fi
INKLEAF_EXPECT_APPARMOR_PROFILE="$runtime_profile" INKLEAF_CHECK_DESKTOP_CLASS=1 MDR_TEST=1 MDR_ROUND="linux-$arch-appimage-runtime" bash scripts/run-linux-ui.sh "verify/linux-$arch-appimage-runtime.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' "$image" --disable-gpu

# Exercise the installed deb as a normal user; only installation uses sudo.
sudo apt-get install -y "$deb"
test "$(stat -c '%U:%G:%a' /opt/Inkleaf/chrome-sandbox)" = 'root:root:4755'
desktop=/usr/share/applications/inkleaf.desktop
test -f "$desktop"
grep -E '^Exec=.*inkleaf.*%[UF]' "$desktop"
grep -Fx 'Icon=inkleaf' "$desktop"
grep -Fx 'StartupWMClass=inkleaf' "$desktop"
grep -Fx 'MimeType=text/markdown;text/x-markdown;' "$desktop"
for size in 16 24 32 48 64 128 256 512; do
  test -s "/usr/share/icons/hicolor/${size}x${size}/apps/inkleaf.png"
done
for ext in md markdown; do
  grep -Eq ":text/markdown:\\*\\.$ext(:.*)?$" /usr/share/mime/globs2
done
if grep -- '--no-sandbox' "$desktop"; then echo 'deb launcher disables sandbox' >&2; exit 1; fi
INKLEAF_CHECK_DESKTOP_CLASS=1 MDR_TEST=1 MDR_ROUND="linux-$arch-deb" bash scripts/run-linux-ui.sh "verify/linux-$arch-deb.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' /usr/bin/inkleaf --disable-gpu

# No MDR_TEST or fake updater API: a same-version real image tests native install
# and normal packaged UI readiness acknowledgement without altering the release.
INKLEAF_UI_SUCCESS_MARKER='[boot-ack-check] installed' bash scripts/run-linux-ui.sh "verify/linux-$arch-boot-ack.log" dbus-run-session -- xvfb-run -a --server-args='-screen 0 1360x880x24' node scripts/test-linux-update-boot.mjs "$image" "$PWD/.linux-appimage-smoke/squashfs-root/resources/app/out/inkleaf-update-helper"
