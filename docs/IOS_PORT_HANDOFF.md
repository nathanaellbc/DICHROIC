# Native iOS port handoff — 2026-10-08

Work continues on `codex/ios-full-port`. This is not yet a validated 1:1 release.

## Architecture and implemented source

Flutter presents the native editor and cached CoreVideo textures. A headless
JavaScriptCore host runs the original TypeScript parameter rules, spectral
planner and render graph; Rust/wgpu executes the original WGSL on Metal.
There is no embedded webpage and no alternate approximation of film mathematics.

The source includes the six canonical control groups, film/paper catalogs,
Film Off, Cineon print LUTs, raw-camera controls, HSV saturation, soften detail,
film format, development, grain, halation, diffusion and depth-based lens blur.
The Flutter editor includes Lucide assets, translucent squircle panels, 12 px
slider thumbs, compact switches, elastic pinch/pan, focus-pin dragging and
inline object removal with grading temporarily bypassed. Before uses an
immutable import texture and includes the original object before removal.

Depth Anything V2 Small and LaMa use the same pinned quantized weights as web,
through native ONNX Runtime. Sessions are operation-scoped. Native source
storage is file-backed; removal edits preserve floating-point precision.
Exports include PNG 8/16-bit, TIFF 16-bit, JPEG, supported system WebP/AVIF,
ICC profiles, source metadata and 17/33/65-point Cube LUTs.

Current changes add LibRaw 0.22.1/LCMS 2.19.1, the same ACES, white-balance,
16-bit and inverse-gamma settings as libraw-wasm 1.6.0. RAW pixels stream to
a PPM file by row rather than a second whole-photo RGB heap allocation.
ImageIO imports preserve source bit depth and ICC gamut, orient rows into
file-backed storage and support Files as well as Photos. Opening a source is
transactional. Export measurement sampling now follows the exact web helper.

GPU allocations are budgeted, tiled exports reuse their buffers, slider
updates coalesce, and memory pressure releases cached GPU work without losing
object-removal history. Whole-frame FFT/lens operations retain the canonical
web size policy; source-sized output for every effect is not promised on phones.

## Evidence, with limits

- Commit `1ca4e1a`, Codemagic build `6ac66a51de4f6899ca0ce7d1`: green native
  compilation, 7 Metal tests, 3 Apple library architectures, 5 Flutter tests,
  unsigned IPA. The UI in that build was still exposure-only.
- Commit `32eb187`, build `6ac67909de4f6899ca0ceca3`: failed CocoaPods static
  ONNX linkage; fixed with a static plugin and static Podfile linkage.
- Commit `9a27904`, build `6ac67fd1de4f6899ca0ceebf`: full editor and ONNX
  compiled for iPhone. Simulator integration caught missing TextEncoder.
- Commit `4efa2c0`, build `6ac6e816de4f6899ca0d0aef`: device compilation passed;
  simulator integration caught a retained PNG helper requesting Latin-1.
  UTF-8 and WHATWG Latin-1 primitives are now included. A DOM-free bundled-host
  startup test exercises canonical catalog, controls, ICC and RAW gamma setup.
- Windows local native LibRaw builds and compares both synthetic DNG fixtures
  (normal and 90 degree rotation) to the independent web WASM decoder at 1e-5.
  The streaming PPM output follows the same gate.
- TypeScript typecheck, native bundle generation, source/retouch/UTF tests and
  Flutter analysis/eight unit and gesture tests passed locally.
- Earlier Dawn-to-wgpu trace replay passed ten readbacks at 1e-5, including
  camera/film/print intermediates and clipped encoded output. One unclipped
  negative-RGB difference was 1.1742e-5; do not claim unclipped float parity.
- iOS integration fixtures exercise six independent Dawn images, PNG16,
  TIFF16, JPEG, Cube, native RAW orientations and Display P3 16-bit decoding.
  These new source-decoder integration cases still need a successful Mac run.

## Required before calling the port finished

1. Complete successful current-source macOS compilation and simulator tests;
   keep strict numerical gates and fix failures rather than loosening them.
2. Exercise native depth/LaMa inference, apply/undo, untouched Before,
   memory-warning recovery and actual output metadata/precision.
3. Finish bounded zoom detail caching and export cache/cancellation; review
   remaining controls, source formats and native visual/gesture parity.
4. Bound removal history memory, verify iPhone-scale large-photo budgets,
   capture real simulator UI proofs and update this file with exact build IDs.
5. Only after validation, deliver the current unsigned IPA. Installation,
   device peak memory and latency still need a real iPhone; a green simulator
   build does not prove physical-device stability or signing.

The user has Windows and rejects paid Apple Developer membership. Use the
existing Codemagic account's free Mac builds and personal Sideloadly signing.
Do not change billing or request TestFlight enrollment. The temporary bundle
identifier remains `com.nathanaellbc.exposureIos`; IOS_BUNDLE_ID can override it.
Generated hosts, models, toolchains, libraries and artifacts are ignored.
