# DICHROIC native iOS

Flutter presents the editor; Swift owns photo import, cached CoreVideo textures,
native inference and file encoding. A headless JavaScriptCore host runs the
original TypeScript planner and parameter rules. Rust/wgpu executes the original
WGSL on Metal. There is no WebView or replacement approximation of film math.

The source implements all six editor groups, film/paper catalogs, Film Off,
2383/2393/3513 Cineon LUTs, camera controls, HSV saturation, soften detail,
development, grain, halation, diffusion and depth-based lens blur. UI includes
the original Lucide assets, translucent squircle panels, compact white slider
thumbs, elastic pinch/pan, direct focus-pin dragging, undo/redo, inline LaMa
removal and Before comparison with the untouched photo before object removal.

Native Photos picking requests the current file representation to retain
HEIC/RAW and metadata. Files imports use ImageIO or pinned LibRaw 0.22.1 with
the same ACES/white-balance/gamma settings as web. Source and removal history
are file-backed; only two removal patches are cached in the host. Imports have
a 50 MP ceiling. Zoom detail retains its highest requested resolution until
editing invalidates it, without developing the photo for every gesture.

Exports use bounded tiles and a file-backed grading cache reused across
compatible formats. PNG 8/16, TIFF 16, JPEG, ten output ICC profiles and
17/33/65-point Cube LUTs are implemented. WebP/AVIF are offered only when the
system reports their encoders, matching the web editor's capability probing.
The export sheet shows actual adaptive output dimensions and retains settings.
Cancellation stops between tiles; it cannot interrupt an active GPU dispatch
or system image encoder. Whole-frame FFT/lens effects retain the canonical
adaptive resolution policy; zoom refinement excludes those global operations.

## Build

Connect the repository to Codemagic and select `exposure-ios-native` from
`codemagic.yaml`. The workflow builds the canonical host and three Apple native
library architectures, runs Metal and Flutter tests, builds the unsigned device
application, and exercises the editor, decoders, exports, native models and
memory recovery on an iPhone simulator before packaging the IPA.

The generated iOS host and native artifacts are ignored. Custom source lives
in `packages/exposure_engine/ios/exposure_engine/Sources/exposure_engine`.
Flutter is pinned to 3.44.0, Rust to 1.85.0, native ONNX Runtime to 1.30.0.
`IOS_BUNDLE_ID` can override the generated identifier. The native icon reuses
the existing DICHROIC icon; display name and launch background match the app.

See [the current handoff](../docs/IOS_PORT_HANDOFF.md) for exact build evidence
and unresolved checks. Source implementation and compilation are not evidence
of physical iPhone stability or perfect visual equivalence. In particular,
the present preview compositor uses sRGB textures; wide-gamut exports preserve
their selected profile, but out-of-sRGB display preview parity remains open.

The user chose Windows and free personal signing. See
[the installation guide](../docs/IOS_FREE_INSTALL.md). No paid Apple Developer
membership or TestFlight workflow is required for this development route.
