#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/ios/proofs
device="$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(v["udid"] for k,a in d["devices"].items() if "iOS" in k for v in a if "iPhone" in v["name"]))')"
xcrun simctl boot "$device" || true
xcrun simctl bootstatus "$device" -b
flutter test integration_test/native_editor_test.dart -d "$device" --timeout 15m 2>&1 | tee build/ios/proofs/integration.log
container="$(xcrun simctl get_app_container "$device" "${IOS_BUNDLE_ID:-com.nathanaellbc.exposureIos}" data)"
cp "$container/Documents/editor.png" build/ios/proofs/editor.png
