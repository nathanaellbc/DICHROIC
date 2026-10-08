#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/ios/proofs
xcrun swift scripts/build_import_fixtures.swift assets/parity
node scripts/build_import_expectations.mjs assets/parity
device="$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(v["udid"] for k,a in d["devices"].items() if "iOS" in k for v in a if "iPhone" in v["name"]))')"
xcrun simctl boot "$device" || true
xcrun simctl bootstatus "$device" -b
# Flutter's test runner may uninstall the app before the EXIT diagnostics run.
# Preserve proof as soon as the app writes it, while its container still exists.
(
  root="$HOME/Library/Developer/CoreSimulator/Devices/$device/data/Containers/Data/Application"
  while true; do
    if [ -d "$root" ]; then
      while IFS= read -r proof; do
        name="$(basename "$proof")"
        if [ ! -f "build/ios/proofs/$name" ]; then
          # UIKit drawHierarchy omits Flutter's asynchronous Metal layers.
          # Capture the simulator compositor while the test holds this screen.
          xcrun simctl io "$device" screenshot "build/ios/proofs/$name" || cp "$proof" "build/ios/proofs/$name"
        fi
      done < <(find "$root" -maxdepth 3 -path '*/Documents/editor*.png' 2>/dev/null)
    fi
    sleep 3
  done
) &
proof_watcher=$!
diagnostics() {
  kill "$proof_watcher" 2>/dev/null || true
  xcrun simctl spawn "$device" log show --last 5m --style compact --predicate 'process == "Runner"' > build/ios/proofs/runner.log 2>&1 || true
  find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -name 'Runner*.ips' -exec cp {} build/ios/proofs/ \; || true
  # Read the generated identifier instead of assuming Flutter's casing.
  bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' build/ios/iphonesimulator/Runner.app/Info.plist 2>/dev/null)" || true
  container="$(xcrun simctl get_app_container "$device" "$bundle" data 2>/dev/null)" || true
  if [ -n "$container" ] && [ -d "$container/Documents" ]; then
    while IFS= read -r proof; do
      name="$(basename "$proof")"
      [ -f "build/ios/proofs/$name" ] || cp "$proof" "build/ios/proofs/$name"
    done < <(find "$container/Documents" -maxdepth 1 -name '*.png')
  fi
}
trap diagnostics EXIT
flutter test integration_test/native_editor_test.dart -d "$device" --timeout 15m 2>&1 | tee build/ios/proofs/integration.log
