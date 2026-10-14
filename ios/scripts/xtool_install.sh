#!/usr/bin/env bash
# Build with xtool, then sign and install on the connected device.
#
# Use this instead of `xtool dev`. SwiftPM copies every framework from a
# binary target into Dichroic.app/Frameworks, including static ones such as
# onnxruntime.framework (an ar archive behind a fat header). Their code is
# already linked into the app binary, and xtool's signer cannot parse an
# archive ("Invalid arch file in fat mach-o file"), so the copies are removed
# before signing. Arguments go to `xtool dev build` (e.g. -c release).
set -euo pipefail
cd "$(dirname "$0")/.."
XTOOL="${XTOOL:-xtool}"

# On WSL, prefer Windows' Apple usbmuxd (see wsl_usbmux_bridge.ps1) over
# usbipd, whose transfers break the upload.
if [ -z "${USBMUXD_SOCKET_ADDRESS:-}" ] && grep -qi microsoft /proc/version; then
  host=$(ip route show default | awk '{print $3; exit}')
  if timeout 2 bash -c "</dev/tcp/$host/27015" 2>/dev/null; then
    export USBMUXD_SOCKET_ADDRESS="$host:27015"
    echo "Using Windows Apple usbmuxd at $USBMUXD_SOCKET_ADDRESS"
  fi
fi

"$XTOOL" dev build "$@"
app=xtool/Dichroic.app

is_static() {
  local bin="$1" off=0
  if [ "$(od -A n -t x1 -N 4 "$bin" | tr -d ' ')" = "cafebabe" ]; then
    # First fat_arch's file offset, big-endian at byte 16.
    off=$(od -A n -t u4 --endian=big -j 16 -N 4 "$bin" | tr -d ' ')
  fi
  [ "$(dd if="$bin" bs=1 skip="$off" count=7 2>/dev/null)" = '!<arch>' ]
}

for fw in "$app"/Frameworks/*.framework; do
  [ -e "$fw" ] || continue
  if is_static "$fw/$(basename "$fw" .framework)"; then
    echo "Removing static $(basename "$fw") from the bundle (already linked in)"
    rm -rf "$fw"
  fi
done
rmdir "$app/Frameworks" 2>/dev/null || true

"$XTOOL" install "$app"
