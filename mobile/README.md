# Exposure iOS port — first native slice

This is a Flutter application with a Swift platform bridge and a Rust/wgpu
compute engine. On iOS, rendering uses Metal. It contains no WebView and does
not run the web application inside a wrapper.

Implemented: native ImageIO photo decoding (including supported HEIC files),
orientation correction, bounded 1600 px preview, a native Flutter texture,
linear-light exposure adjustment, latest-value slider scheduling, and explicit
full-resolution Develop to 8-bit sRGB PNG with the iOS share sheet. Preview
frames never pass through Dart as large pixel buffers and are not encoded as
PNG. The native engine reuses three 4 MiB GPU buffers across tiles. Full photo
decoding/output still consumes CPU memory; the current import ceiling is 50 MP.

The spectral film/paper pipeline, grain, diffusion, lens, erase, RAW decoding,
wide-gamut/16-bit export, source metadata preservation, and complete web UI
are **not ported yet**. The exposure kernel is a platform proof, not a substitute
for the existing film simulation. Future slices must reuse the original profile
assets/WGSL and verify output against the web engine's parity fixtures before
those features are advertised as available.

## Build without owning a Mac

1. Connect `nathanaellbc/DICHROIC` to your Codemagic account.
2. Select `codemagic.yaml` and the `exposure-ios-native` workflow.
3. Run the workflow on the branch containing this port.

Codemagic installs the pinned toolchains, tests the Rust kernel on the machine's
Metal GPU, builds device/simulator static libraries, generates the standard iOS
Flutter host, configures the photo permission, analyzes/tests Flutter, then
builds an **unsigned** `.app`. The host is generated and ignored so it can be
created without Xcode on Windows. Custom native source lives in the plugin.
The generated default identifier is `com.nathanaellbc.exposureIos`; confirm or
replace it before registering the production App ID.

Unsigned artifacts cannot be installed on your iPhone or sent to TestFlight.
The first successful CI build still needs to be obtained. Local Flutter 3.44.0
and Rust 1.85.0 toolchains were installed under the ignored `.tools/` directory.
The WGSL exposure test and web TypeScript checks passed. Flutter analysis found
four missing-braces lint issues; Flutter tests were not run. Rust tests were
blocked by missing `dlltool.exe` in the local Windows GNU toolchain, before the
engine source could be compiled. Swift/iOS compilation has not been verified,
and no Codemagic build has run. See [the handoff notes](../docs/IOS_PORT_HANDOFF.md).

After confirming active Apple Developer membership, create an App Store Connect
app and connect signing in Codemagic. Store API keys/certificates in Codemagic's
secure integration, not this repository. Add a signed workflow using that
integration and `flutter build ipa --release`; only then distribute through
TestFlight. Validate photo orientation, HEIC decoding, texture updates, slider
latency, memory pressure, and full-resolution export on the real iPhone.

## Next native slices

1. Obtain a green unsigned iOS build and test this photo/render/export path on device.
2. Port the original asset/arena preparation and spectral film/paper shaders;
   establish parity before exposing the film menu.
3. Port spatial stages with memory-aware tiling and preview refinement.
4. Port erase/depth/RAW and native metadata/16-bit export.
5. Finish UI parity, then add new product features.
