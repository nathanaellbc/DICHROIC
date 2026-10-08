# Native iOS port handoff — 2026-10-08

Work is on `codex/ios-full-port`. Keep the complete editor implementation;
do not deliver the old exposure-only green build as the finished port.

## Implementation

Flutter presents the native editor and cached profiled UIKit image surfaces. Swift owns
original-file Photos/Files picking, ImageIO, native ONNX inference and image
encoding. Headless JavaScriptCore runs the original TypeScript planner,
parameter rules and math. Rust/wgpu runs the original WGSL on Metal; no WebView.

All six canonical control groups, stock catalogs, Film Off with controls active,
Cineon 2383/2393/3513, camera controls, HSV saturation, soften detail, development,
grain, halation, diffusion and depth-based lens blur are implemented. The native
UI uses the original Lucide assets, translucent squircle surfaces, white 12 px
slider thumbs, elastic pinch/pan, direct focus-pin isolation/drag, undo/redo and
inline LaMa removal with grading paused. Before retains the untouched import,
including the original object. Photos requests the current file representation
without UIImage/JPEG conversion. Files picking is in the editor menu.

LibRaw 0.22.1, LCMS 2.19.1 and JPEG-turbo 2.1.5.1 match the web decoder pins and
ACES/white-balance/gamma settings. LibRaw lives on the heap rather than a small
worker stack. Decoded source storage is file-backed, retains channel precision
and orientation, and accepts imports up to 50 MP. Removal history is file-backed
with two small patches cached, rather than a full float image for every undo.

Zoom/pan transforms cached textures. Detail requests cover the visible viewport
with a bounded pixel budget and retain the highest requested resolution until
an edit invalidates it. Original and graded detail textures are separate.
Whole-frame FFT/lens effects retain canonical adaptive sizing rather than
cropped approximations. GPU allocations are capped; source strips reuse storage.
Memory warnings evict frame/arena/shader caches while retaining edit history.
Shader eviction also retires the JavaScript GPUDevice identity, so stage WeakMap
caches cannot reference destroyed native pipeline handles.

Exports include PNG 8/16, TIFF 16, JPEG, system-supported WebP/AVIF, ten ICC output
profiles, source metadata and 17/33/65-point Cube LUTs. Grading results are cached
in a mapped file across compatible encoding choices. Export measurement follows
the exact web helper. The sheet shows actual adaptive dimensions and persists
settings. Cancellation checks between tiles, before/after GPU work and encoding;
an active GPU dispatch or ImageIO encoder cannot be interrupted.

## Verified evidence

- Full web suite: 105 files passed, 3181 tests passed, four skipped; TypeScript
  typecheck passed. This proves shared web behavior, not physical iPhone behavior.
- Windows native LibRaw: both synthetic DNG orientations match independent
  libraw-wasm output at 1e-5. Rust native tests passed locally and on Metal.
- Local Dawn graph plus native Rust replay: ten readbacks including memory
  eviction/recovery; maximum clipped encoded error 9.62615e-6, all allocations
  released. Unclipped raw maximum is 1.9937754e-5; do not claim stricter raw parity.
- Flutter analysis has zero issues and 13 unit/layout/gesture tests pass, covering
  all controls at 390x844, 844x390 and 768x1024, high-water detail caching, serialized
  export and removal history.
- Build `6ac6f5eade4f6899ca0d0d1a`, commit `9fc6758`: full device compilation,
  six independent Dawn PNG comparisons within one byte, native RAW orientation
  and P3 PNG16/TIFF16 decode passed. Actual LaMa inference/apply and immutable
  Before passed. Undo assertion incorrectly compared encoded PNG metadata bytes.
- Build `6ac6f8d7de4f6899ca0d0dac`, commit `80dc145`: Undo decoded pixels match
  exactly. Memory-warning redo/export exposed an evicted-preview input bug.
- Build `6ac6fc47de4f6899ca0d0e44`, commit `d7d5d36`: full compilation, canonical
  grading, RAW/P3, eight JPEG orientations and HEIC passed. EXR retains negative
  and HDR float values but the test compared pre-encoder numbers, not encoded
  source codes. Memory-warning redo exposed stale WeakMap pipeline identities.
- Build `6ac74641de4f6899ca0d1cc9`, commit `5101fb8`: completed with three integration cases passed and one failed. Includes pipeline
  identity recovery, independent web EXR decoder expectations, all output profiles
  and available encoders, 44 MP JPEG/cancel/recovery, LaMa and depth tests. Also
  includes original-file Photos picking, app icon/launch branding and RAW EXIF
  fallback. RAW/P3, HEIC, EXR, 44 MP JPEG, cancellation, memory recovery,
  actual LaMa undo/redo, depth and focus tests passed. One optional system encoder
  failed finalization despite appearing in its advertised identifiers. Large JPEG
  open was 69.4 seconds in debug simulator; first grading added 1.45 seconds.

## Remaining acceptance

Build `6ac7536dde4f6899ca0d2058`, commit `b3b6087`, passed seven profiled
preview/encoded PNG comparisons, native RAW/P3, HEIC/EXR/orientation, memory
recovery, actual LaMa undo/redo and depth tests. Three integration cases passed;
the first stopped at AVIF quality 1.0. Apple's log reports
`kCMPhotoError_UnsupportedQuality` for AV1 (also present in the older 510 build).
The follow-up exposes/uses the native 99% lossy maximum and probes both quality
endpoints with non-square chromatic pixels. JPEG open was 9.39 seconds:
8.23 seconds decoding and 1.16 seconds preview, versus c630's 16.69-second preview.
First grading added 1.50 seconds; cancel/recovery/export completed at 19.18
seconds from opening, versus 89.84 in c630. Debug simulator timings vary and
are not iPhone release latency. The follow-up also retains high-water zoom
quality when panning after zoom-out and normalizes copied TIFF orientation in
all export formats. Native editor screenshots are still pending the first test.

Current follow-up also adds a bounded Rust CPU source reader using the exact web
f64 box sum order and f32 channel normalization. Twenty independently generated
web fixtures match exactly, covering 8-bit RGBA, 16-bit RGB/lookup/endian and
32-bit mono/RGBA HDR, crops and upscale boundaries. Sparse removal recomputes
only edited output boxes, preserving the original source and exact sums.
This needs fresh Mac performance/integration evidence before claiming a speedup.
Build `6ac74c85de4f6899ca0d1e68`, commit `c630334`, compiled the profiled UIKit
preview and passed all seven preview ICC/pixel checks. Its P3 PNG assertion
incorrectly compared Flutter color-converted pixels against P3 encoded codes;
the follow-up probes original encoded ImageIO codes instead, retaining the
one-byte independent Dawn gate. A global platform override also violated Flutter
test invariants; actual OS selection now enables UIKit without that override.
The other three integration test bodies passed. JPEG open was 22.24 seconds:
5.55 seconds decoding and 16.69 seconds constructing its original preview.

1. Finish the current Mac build and fix any strict integration failures; inspect
   actual simulator editor PNG. Preserve proof during the test because Flutter
   may uninstall the app before exit diagnostics can copy its container.
2. Verify 8144x5424 JPEG open/develop, cancellation, memory-warning recovery,
   actual depth inference, focus overlay, LaMa redo and all ICC/system encoders.
3. Compile the final UI fixes (Files menu placement, flat proportional switch)
   and DICHROIC-named IPA packaging in the final validated build.
4. Latest source replaces untagged texture preview with native UIKit profiled
   sRGB/P3 images, preserving the selected output profile through the render graph.
   RGBA8 transfers avoid unnecessary full float preview copies. Independent Dawn
   preview/profile checks and native UI proof still need Mac execution. The source
   adds Accelerate/direct integer decoder paths and real optional-encoder probes;
   the next build must verify speed, precision and available format behavior.
5. Install the current unsigned IPA on a real iPhone 15 using Sideloadly. Simulator
   success does not prove physical device peak memory, latency, signing or Photos
   picker interaction. Do not label the port fully 1:1 until these limits are met.

The user has Windows, rejects paid Apple Developer membership and uses the
existing free Codemagic account. Do not change billing or request TestFlight.
Bundle ID remains `com.nathanaellbc.exposureIos` unless IOS_BUNDLE_ID overrides
it. Generated hosts, models, native libraries, toolchains and artifacts are
ignored. Validate before merging the port to main. See IOS_FREE_INSTALL.md for
personal Sideloadly installation and mobile/README.md for architecture/build.
