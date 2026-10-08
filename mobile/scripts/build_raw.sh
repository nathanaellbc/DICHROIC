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
    -DCMAKE_OSX_ARCHITECTURES="$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 \
    -DCMAKE_BUILD_TYPE=Release -DRAW_SOURCE="$cache/libraw" -DLCMS_SOURCE="$cache/lcms" -DJPEG_SOURCE="$cache/jpeg"
  cmake --build "$build" --config Release --target raw_native -j 6
  libtool -static -o "$build/libRawNative.a" "$build/libraw_native.a" "$build/libdichroic_lcms.a" "$build/jpeg/libjpeg.a"
done
mkdir -p "$root/native/target/raw-simulator"
lipo -create "$root/native/target/raw-arm64-simulator/libRawNative.a" "$root/native/target/raw-x86_64-simulator/libRawNative.a" \
  -output "$root/native/target/raw-simulator/libRawNative.a"
framework="$root/mobile/packages/exposure_engine/ios/exposure_engine/Frameworks/RawNative.xcframework"
xcodebuild -create-xcframework -library "$root/native/target/raw-device/libRawNative.a" -headers "$root/native/io/include" \
  -library "$root/native/target/raw-simulator/libRawNative.a" -headers "$root/native/io/include" -output "$framework"
licenses="$root/mobile/packages/exposure_engine/ios/exposure_engine/Resources/licenses"
mkdir -p "$licenses"
cp "$cache/libraw/LICENSE.LGPL" "$licenses/LibRaw-LGPL.txt"
cp "$cache/lcms/LICENSE" "$licenses/LittleCMS.txt"
cp "$cache/jpeg/LICENSE.md" "$licenses/libjpeg-turbo.txt"
