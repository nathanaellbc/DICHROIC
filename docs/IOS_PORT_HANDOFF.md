# Native iOS port handoff — 2026-10-08

The complete editor is on `codex/ios-full-port`. Do not deliver the old exposure-only build as the finished port. Validate before merging to main.

## Implementation

Flutter presents the editor and cached, profiled UIKit image surfaces. Swift owns original-file Photos/Files picking, ImageIO, native ONNX inference and encoding. Headless JavaScriptCore runs the original TypeScript planner, parameter rules and math. Rust/wgpu runs the original WGSL on Metal; no WebView.

All six canonical control groups, film/paper catalogs, Film Off with controls active, Cineon 2383/2393/3513, camera controls, HSV saturation, soften detail, development, grain, halation, diffusion and depth-based lens blur are implemented. The UI retains Lucide icons, dark/blue identity, frosted superellipse surfaces, white 12 px slider thumbs, compact flat switches, 20% white scrollbars, elastic pinch/pan and direct focus-pin isolation/drag. Inline LaMa removal pauses grading without clearing adjustments. Before retains the untouched import, including the object removed later. Undo/Redo retain removal history.

LibRaw 0.22.1, LCMS 2.19.1 and JPEG-turbo 2.1.5.1 match the web decoder pins and ACES/white-balance/gamma settings. Sources retain channel precision and normalized orientation in file-backed storage, with a 50 MP import ceiling. Removal history stores sparse disk patches; only two patches are cached. The source reader uses the web helper's exact f64 box-sum order and f32 channel normalization. Dirty removal boxes are recomputed without copying the full float image.

Gestures transform cached images. Detail requests cover the visible region with a bounded pixel budget and retain the highest requested resolution until an edit invalidates it. Panning after zoom-out refreshes newly exposed regions at that retained resolution. Before and graded detail use separate image surfaces. Whole-frame FFT/lens effects retain canonical adaptive sizing rather than cropped approximations. Memory warnings evict GPU frame/arena/shader caches while keeping source and edit history; a fresh JS GPUDevice identity retires stale WeakMap pipeline handles. Native model sessions are scoped to each inference operation.

Exports include PNG 8/16, TIFF 16, JPEG, system-supported WebP/AVIF, ten output ICC profiles and 17/33/65-point Cube LUTs. Optional encoders are offered only after real chromatic encodes succeed at both quality endpoints. AVIF uses a maximum 99% lossy quality on the tested Apple encoder. Source metadata is copied with orientation reset to 1 after pixel normalization. Compatible formats reuse a mapped grading cache. Cancellation checks between tiles and before/after GPU work and encoding; active GPU dispatches and ImageIO encoders cannot be interrupted.

## Verified evidence

- Web: 105 files passed, 3181 tests passed, four skipped; TypeScript typecheck passed. This proves shared web behavior, not physical iPhone behavior.
- Windows LibRaw: two synthetic DNG orientations match independent libraw-wasm output at 1e-5. Native Rust tests also run on Mac/Metal.
- Independent Dawn graph and native Rust replay: ten readbacks including memory recovery; maximum clipped encoded error 9.62615e-6, all allocations released. Unclipped raw maximum is 1.9937754e-5; do not claim stricter raw parity.
- Twenty independent web source-reader fixtures match exactly: 8-bit RGBA, 16-bit RGB/lookup/endian and 32-bit mono/RGBA HDR, crops and upscale boundaries. JS tests exercise sparse removal, candidates and untouched Before pixels.
- Flutter: zero analysis issues and 13 unit/layout/gesture tests pass. All tool groups and stock/export sheets fit 390x844, 844x390 and 768x1024. Tests also cover high-water detail caching, coalesced renders, serialized export and removal history.
- Build `6ac759dfde4f6899ca0d227d` (`a141b8a`): seven UIKit preview/profile and encoded PNG comparisons pass within one byte of independent Dawn references, including P3. PNG8/16, TIFF16, JPEG, AVIF99, ten output profiles, Cube17, export grading reuse and detail requests passed before the stock-sheet UI assertion.
- The same build passed native RAW/P3 imports, HEIC, eight JPEG orientations, rotated PNG export orientation, actual encoded float EXR (1e-7), 44 MP JPEG, cancellation, memory-warning recovery, actual LaMa Apply/Undo/Redo with immutable Before, and depth/focus inference. Three integration cases passed; the first failed on ListTile ink being hidden by the glass background. The follow-up uses a local Material surface and tests both sheets at all three layout sizes.
- In that debug simulator run, 8144x5424 JPEG opened in 5.73 s: 4.92 s decode, 0.81 s original preview. First grading completed at 6.47 s and cancel/recovery/export at 11.54 s from opening. Previous original preview took 16.69 s. These are variable Mac simulator measurements, not physical iPhone release latency.

## Current build and remaining acceptance

Build `6ac75f73de4f6899ca0d245a` tests `269c3a6`, including the ListTile/glass fix, native 20% scrollbars and simulator compositor screenshots. UIKit drawHierarchy omits asynchronous Flutter/Metal layers; the proof watcher uses simctl screenshots while each screen is held. Inspect editor, stock-sheet and export-sheet PNGs. Only a passing final integration run may produce the delivered unsigned IPA.

After green CI, verify the IPA's device payload and publish validated code to main. Install it on the user's physical iPhone 15 with Sideloadly and test the actual 8144x5424 JPEG and 5120x7168 ARW. Photos/Files picking, display gamut, gesture feel, peak memory, repeated large exports and background/resume require this device acceptance. Simulator success cannot establish those facts or perfect visual 1:1.

The user has Windows, rejects paid Apple Developer membership and uses the existing free Codemagic account. Do not change billing or request TestFlight. Bundle ID is `com.nathanaellbc.exposureIos` unless IOS_BUNDLE_ID overrides it. Generated hosts, models, native libraries, toolchains and artifacts are ignored. See [free installation](IOS_FREE_INSTALL.md) and [architecture/build](../mobile/README.md).
