#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then echo 'Linux CI setup requires Linux' >&2; exit 1; fi
source /etc/os-release
audio=libasound2
gtk=libgtk-3-0
fuse=libfuse2
if [ "$VERSION_ID" = '24.04' ]; then audio=libasound2t64; gtk=libgtk-3-0t64; fuse=libfuse2t64; fi
sudo apt-get update
sudo apt-get install -y build-essential ruby ruby-dev xvfb dbus-x11 squashfs-tools "$audio" "$gtk" "$fuse" libnss3 libxss1 libxtst6 libatspi2.0-0 libuuid1 libgbm1 xdg-utils fonts-noto-cjk fonts-noto-color-emoji
# Native fpm avoids electron-builder's older bundled x86 executable on arm64.
sudo gem install fpm --version 1.16.0 --no-document

if [ "$VERSION_ID" = '24.04' ] && command -v apparmor_parser >/dev/null 2>&1; then
  # These narrowly attached development profiles retain Chromium sandboxing.
  # They do not disable AppArmor or change the system userns restriction.
  cat > "$RUNNER_TEMP/inkleaf-ci-apparmor" <<EOF
abi <abi/4.0>,
include <tunables/global>
profile inkleaf-ci-electron "$PWD/node_modules/electron/dist/electron" flags=(unconfined) {
  userns,
}
profile inkleaf-ci-appimage "$PWD/.linux-appimage-smoke/squashfs-root/inkleaf" flags=(unconfined) {
  userns,
}
profile inkleaf-ci-appimage-runtime "/tmp/.mount_Inklea*/inkleaf" flags=(unconfined) {
  userns,
}
EOF
  sudo apparmor_parser -r "$RUNNER_TEMP/inkleaf-ci-apparmor"
fi
