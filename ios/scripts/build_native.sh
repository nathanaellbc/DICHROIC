#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$project_root/native"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
cargo build --release --locked --target aarch64-apple-ios
cargo build --release --locked --target aarch64-apple-ios-sim
cargo build --release --locked --target x86_64-apple-ios
mkdir -p target/ios-simulator
lipo -create target/aarch64-apple-ios-sim/release/libexposure_native.a \
  target/x86_64-apple-ios/release/libexposure_native.a \
  -output target/ios-simulator/libexposure_native.a
framework="$project_root/native/target/ExposureNative.xcframework"
rm -rf "$framework"
mkdir -p "$(dirname "$framework")"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libexposure_native.a -headers include \
  -library target/ios-simulator/libexposure_native.a -headers include \
  -output "$framework"
