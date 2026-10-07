#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$project_root/native"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cargo build --release --locked --target aarch64-apple-ios
cargo build --release --locked --target aarch64-apple-ios-sim
framework="$project_root/mobile/packages/exposure_engine/ios/exposure_engine/Frameworks/ExposureNative.xcframework"
# Generated output only. Never delete a source directory.
if [ -e "$framework" ]; then
  echo 'Native framework already exists; use a clean CI checkout.' >&2
  exit 1
fi
mkdir -p "$(dirname "$framework")"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libexposure_native.a -headers include \
  -library target/aarch64-apple-ios-sim/release/libexposure_native.a -headers include \
  -output "$framework"
