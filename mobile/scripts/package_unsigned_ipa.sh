#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
app="$project_root/mobile/build/ios/iphoneos/Runner.app"
output="$project_root/mobile/build/ios/ipa/Exposure-unsigned.ipa"
if [ ! -d "$app" ]; then
  echo 'Build the release device app before packaging its IPA.' >&2
  exit 1
fi
staging="$(mktemp -d -t exposure-ipa)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/Payload" "$(dirname "$output")"
ditto "$app" "$staging/Payload/Runner.app"
ditto -c -k --keepParent "$staging/Payload" "$output"
# Packaging is not signing. AltStore must sign this file before installation.
unzip -t "$output"
unzip -Z1 "$output" | grep -q '^Payload/Runner.app/Info.plist$'
echo "$output"
