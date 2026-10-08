#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
app="$project_root/mobile/build/ios/iphoneos/Runner.app"
output="$project_root/mobile/build/ios/ipa/DICHROIC-unsigned.ipa"
if [ ! -d "$app" ]; then
  echo 'Build the release device app before packaging its IPA.' >&2
  exit 1
fi
staging="$(mktemp -d -t exposure-ipa)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/Payload" "$(dirname "$output")"
ditto "$app" "$staging/Payload/Runner.app"
ditto -c -k --keepParent "$staging/Payload" "$output"
# Packaging is not signing. Sideloadly signs this file for personal installation.
unzip -t "$output"
unzip -Z1 "$output" > "$staging/entries.txt"
grep -q '^Payload/Runner.app/Info.plist$' "$staging/entries.txt"
echo "$output"
