#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cache="$root/native/target/raw-dependencies"
mkdir -p "$cache"
clone() { if [ ! -d "$cache/$1/.git" ]; then git clone --depth 1 --branch "$2" "$3" "$cache/$1"; fi; }
# LibRaw and LCMS match libraw-wasm 1.6.0; JPEG decoding is native libjpeg-turbo.
clone libraw 0.22.1 https://github.com/LibRaw/LibRaw.git
clone lcms lcms2.19.1 https://github.com/mm2/Little-CMS.git
clone jpeg 2.1.5.1 https://github.com/libjpeg-turbo/libjpeg-turbo.git
for target in device arm64-simulator x86_64-simulator; do
  arch=arm64; sdk=iphonesimulator
  if [ "$target" = device ]; then sdk=iphoneos; fi
  if [ "$target" = x86_64-simulator ]; then arch=x86_64; fi
  build="$root/native/target/raw-$target"
  cmake -S "$root/native/io" -B "$build" -DCMAKE_SYSTEM_NAME=iOS \
    -DCMAKE_OSX_SYSROOT="$(xcrun --sdk "$sdk" --show-sdk-path)" \
    -DCMAKE_OSX_ARCHITECTURES="$arch" -DCMAKE_SYSTEM_PROCESSOR="$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 \
    -DCMAKE_BUILD_TYPE=Release -DRAW_SOURCE="$cache/libraw" -DLCMS_SOURCE="$cache/lcms" -DJPEG_SOURCE="$cache/jpeg"
  cmake --build "$build" --config Release --target raw_native -j 6
  libtool -static -o "$build/libRawNative.a" "$build/libraw_native.a" "$build/libdichroic_lcms.a" "$build/jpeg/libjpeg.a"
  rust=aarch64-apple-ios-sim
  if [ "$target" = device ]; then rust=aarch64-apple-ios; fi
  if [ "$target" = x86_64-simulator ]; then rust=x86_64-apple-ios; fi
  libtool -static -o "$build/libDichroicNative.a" "$root/native/target/$rust/release/libexposure_native.a" "$build/libRawNative.a"
done
mkdir -p "$root/native/target/raw-simulator"
lipo -create "$root/native/target/raw-arm64-simulator/libDichroicNative.a" "$root/native/target/raw-x86_64-simulator/libDichroicNative.a" \
  -output "$root/native/target/raw-simulator/libDichroicNative.a"
# CocoaPods copies static XCFramework headers into one pod-wide directory.
# One archive avoids one dependency's module.modulemap replacing the other.
headers="$root/native/target/raw-headers"
mkdir -p "$headers"
cp "$root/native/include/exposure_native.h" "$root/native/io/include/raw_native.h" "$headers/"
cat "$root/native/include/module.modulemap" "$root/native/io/include/module.modulemap" > "$headers/module.modulemap"
framework="$root/mobile/packages/exposure_engine/ios/exposure_engine/Frameworks/DichroicNative.xcframework"
xcodebuild -create-xcframework -library "$root/native/target/raw-device/libDichroicNative.a" -headers "$headers" \
  -library "$root/native/target/raw-simulator/libDichroicNative.a" -headers "$headers" -output "$framework"
licenses="$root/mobile/packages/exposure_engine/ios/exposure_engine/Resources/licenses"
mkdir -p "$licenses"
cp "$cache/libraw/LICENSE.LGPL" "$licenses/LibRaw-LGPL.txt"
cp "$cache/lcms/LICENSE" "$licenses/LittleCMS.txt"
cp "$cache/jpeg/LICENSE.md" "$licenses/libjpeg-turbo.txt"
