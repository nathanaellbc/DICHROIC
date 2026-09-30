# DICHROIC project analysis

This records the initial review. The subsequent implementation and current
verification results are in [PROJECT_FIXES.md](PROJECT_FIXES.md).

Reviewed on 30 September 2026 against commit `e137d76`, in `D:/Projects/DICHROIC`.

## Assessment

DICHROIC has a carefully validated numerical core and clear subsystem boundaries. Its strongest asset is the reference fixture infrastructure: it checks the actual film pipeline against upstream results instead of relying only on internally consistent unit tests. The main weaknesses are resource lifetime, asynchronous UI state, and integration coverage. Those weaknesses can affect ordinary editing even when shader parity passes.

The build passes. The initial complete test run finished with 2,960 tests passed, seven failed and 24 skipped. Every failing file subsequently passed in isolated reruns: 31 GPU/Session tests and 18 codec tests. The initial failures came from sandbox restrictions and test/setup timeouts. The dependency audit reports six affected development packages and no known vulnerabilities in production dependencies.

This review produced this report and temporary diagnostic probes, which were removed after verification. Application code and dependencies were not changed.

## Project and architecture

The source inventory contains 114 files and approximately 24,386 lines, including comments, shaders, and styles. The test implementation contains 80 files and approximately 10,188 lines, excluding binary fixtures. The reference tooling is another approximately 5,368 lines. There are 28 stock profiles: 20 film profiles and eight paper profiles, 26 input color-space labels, and ten supported output spaces.

| Subsystem | Responsibility | Assessment |
|---|---|---|
| `src/ui/` | React/Motion editor, controls, preview, file selection and sharing | Clear presentation/model separation; photo lifecycle and color interpretation need attention |
| `src/session/` | Worker RPC, decoded image ownership, render scheduling, exports | Good narrow facade and latest-request scheduling; missing resource bounds and worker failure handling |
| `src/params/` | Canonical parameters, verification status, stock validation and render plans | Strong explicit distinction between verified parameters, locked parameters and extensions |
| `src/host/` | Spectral calculations, exposure, development and lens optics | Detailed provenance; expensive stock-dependent calculations are repeated for filter variants |
| `src/engine/` and `src/shaders/` | WebGPU stages, packed arenas, Gaussian/FFT effects, tiling | Reusable stage model and extensive parity checks; graph/arena lifetime is too broad |
| `src/io/` | JPEG/PNG/TIFF/EXR/RAW decoding, metadata, ICC and encoding | Broad format support and oracle tests; native cleanup and allocation limits need tightening |
| `src/depth/` | ONNX depth model, backend selection, download/cache, refinement | Sensible opt-in design and pinned model revision; implementation currently bypasses part of that opt-in |
| PWA and deployment | Offline precache, isolation headers, subpath hosting | Build produces a roughly 9.75 MiB precache; deployment does not gate on tests |
| `tools/` and fixtures | Upstream baking, generated references, numerical comparison | Substantial provenance and checksum coverage; Python/GPU requirements need explicit CI handling |

The normal flow is file selection → decode → preview/guide preparation → worker-owned Session → parameter validation/render plan → GPU stages → readback → display or encoding. RAW and the main render pipeline operate in the Session worker. Depth inference has its own worker. Browser-only codecs use image bitmaps and canvas strips.

A static import-graph check found no cycles among resolved TypeScript source modules, excluding imports declared entirely as types. The runtime scan found asset/model fetching but no image-upload path, `eval`, `new Function`, or `dangerouslySetInnerHTML` usage. The model request omits credentials. Photos remain local until the user explicitly exports/shares them.

## Prioritized findings

Priorities: **P1** should be addressed before wider use; **P2** should be addressed in the next reliability/security work; **P3** is a smaller correction. “Reproduced” below means a diagnostic exercised the existing implementation, with mocked browser/RPC boundaries where stated.

### 1. P1 — Filter edits accumulate render graphs, GPU buffers and host copies

Evidence: [arena cache](D:/Projects/DICHROIC/src/session/session.ts:125), [graph cache](D:/Projects/DICHROIC/src/session/session.ts:658), [parameter-dependent arena key](D:/Projects/DICHROIC/src/params/plan.ts:414), [scratch ownership](D:/Projects/DICHROIC/src/engine/graph.ts:264).

Each rendered C/M/Y filter combination receives its own arena key. `OwnedArenaProvider.cache` and `Session.graphs` retain every combination without an eviction policy. Each graph retains its scratch pool. New arena plans also repeat the static and film-dependent data, even when only a print filter changed.

From the checked-in manifest, each arena variant duplicates 1,179,648 bytes of Hanatos raw-response data and 425,984 bytes of color-decode LUT data alone. That is over 1.5 MiB of GPU data per variant before stock/print tables and scratch buffers. `ArenaImpl` also retains host copies. This is a derived lower bound, not a measured total GPU footprint.

Closing the photo only clears UI state; it does not close/dispose the worker Session. Consequently the source image, render cache and graph resources also remain alive. A 48-megapixel source requires 768 MB for its Float32 RGBA array alone.

**Remedy:** bound graph/arena caches by bytes or a small LRU; share invariant static/film resources; separate changing print-filter data from compiled topology; add a Session photo-close operation that releases image, depth and image-sized caches. Dispose evicted graphs only when no job is using them.

### 2. P1 — Enabling lens blur can download the runtime before approval

Evidence: [runtime fetch](D:/Projects/DICHROIC/src/depth/workerCore.ts:33), [model permission check](D:/Projects/DICHROIC/src/depth/workerCore.ts:55), [call order](D:/Projects/DICHROIC/src/depth/workerCore.ts:101).

The message handler calls `loadRuntime()` before `infer()` reaches the `allowDownload` check. On a fresh device, an estimation with `allowDownload: false` can fetch the 14,239,897-byte CPU runtime or the 26,781,914-byte GPU runtime, and only then report that the model needs permission. This contradicts the download card's intended behavior and delays its appearance.

**Reproduced:** a no-cache estimate with downloads disallowed invoked the runtime fetch, then returned `not-cached`. The probe mocked fetching; no model/runtime was downloaded by the probe.

**Remedy:** check availability of both the selected model and required runtime before fetching either. Missing assets should produce the download state immediately when permission is false. Include fallback-backend assets in that policy.

### 3. P2 — Cancellation does not prevent late photo state from being applied

Evidence: [photo opening](D:/Projects/DICHROIC/src/ui/engine/engine.ts:201), [unconditional frame publication](D:/Projects/DICHROIC/src/ui/engine/engine.ts:333).

The opening token is checked before `client.open(image)`, but not immediately after that awaited RPC or after parameter setup. Cancelling while that RPC is pending still allows the operation to replace `fileName`, defaults, original image and opening status. `#renderOnce()` also publishes any returned frame without an image-generation check, even after `closePhoto()` cleared it. The result's parameter version is not checked at the UI bridge.

**Reproduced:** cancelling a deferred open still applied the cancelled filename and `Developing…` status; resolving a deferred preview after closing restored a frame while the phase remained idle.

**Remedy:** capture a photo generation and parameter revision for each operation, check them after every await and before publication, and tie RPC mutations to image identity. Cancellation semantics must also account for a worker that has already replaced its image.

### 4. P2 — A failed replacement import hides the existing photo

Evidence: [opening error handler](D:/Projects/DICHROIC/src/ui/engine/engine.ts:248), [editor visibility](D:/Projects/DICHROIC/src/ui/App.tsx:53).

`openFile()` sets the phase to `opening`. Its catch block restores `editing` only if the current phase is already `editing`, so ordinary decode failure takes the app to `idle`. The old filename/frame remain stored, but the editor disappears after the error is dismissed.

**Reproduced:** opening a valid photo and then a damaged PNG resulted in `phase: idle` with the original filename and frame still present.

**Remedy:** save the preceding editing state and restore it on failure before worker image replacement. Prefer committing a new photo's state only after successful preparation.

### 5. P2 — RAW decoder instances are never explicitly destroyed

Evidence: [native allocation](D:/Projects/DICHROIC/src/io/raw.ts:75), [minimal binding declaration](D:/Projects/DICHROIC/src/io/libraw.d.ts:15).

Every decode constructs a new Embind `LibRaw` instance in a memoized WASM module. Neither success nor error calls its inherited `delete()` method, and the local type declaration omits that method. Native allocations can therefore accumulate across successive RAW imports. This finding is based on the call path and installed Embind implementation; native heap growth was not benchmarked.

Embind requires explicit destruction for these objects; JavaScript collection is not a reliable substitute. See [Emscripten's memory-management guidance](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/embind.html#memory-management).

**Remedy:** declare the native destruction method and call it in `finally`, after converting/copying any image data needed by the returned image. Apply the same cleanup to failed decodes.

### 6. P2 — A tiny TIFF header can request a multi-gigabyte allocation

Evidence: [pixel-only limit](D:/Projects/DICHROIC/src/io/tiff.ts:269), [sample allocation](D:/Projects/DICHROIC/src/io/tiff.ts:316), [unbounded Deflate expansion](D:/Projects/DICHROIC/src/io/tiff.ts:190).

The pixel cap does not bound channel count or decoded bytes. `SamplesPerPixel` is only checked against the minimum color-channel count, and the Float64 sample array is allocated before strip content validation. Tile dimensions and Deflate output also need independent limits.

**Reproduction:** a TIFF header smaller than 200 bytes, declaring 2048 × 2048 pixels and 64 samples per pixel, requests a 2,147,483,648-byte sample array before the missing image data is rejected. The diagnostic intercepted the allocation; it did not allocate 2 GiB.

**Remedy:** validate supported channel layouts and strip/tile geometry; impose a decoded-byte budget before allocating; validate uncompressed payload sizes first; bound decompression output to the expected block size. Extend a common image budget to PNG/EXR/RAW and browser decoding.

### 7. P2 — Depth reset abandons the result but leaves inference running

Evidence: [reset](D:/Projects/DICHROIC/src/ui/engine/depthController.ts:64), [available cancellation](D:/Projects/DICHROIC/src/ui/engine/engine.ts:151).

`DepthController.reset()` invalidates its token and clears the stall timer, but does not call `deps.cancel`. Closing a photo, or replacing it without starting another estimate, can leave the previous model download/inference consuming CPU/GPU/WASM resources. Result suppression works; resource cancellation does not.

**Reproduced:** resetting to no photo during an unresolved estimate returned to idle without invoking the cancellation dependency.

**Remedy:** cancel active estimation when resetting the photo, and dispose retained workers/sessions according to the device memory policy.

### 8. P2 — Some images are labeled as a different color space without conversion

Evidence: [browser export](D:/Projects/DICHROIC/src/session/session.ts:591), [original comparison](D:/Projects/DICHROIC/src/ui/engine/display.ts:57), [browser decoder's P3 result](D:/Projects/DICHROIC/src/ui/engine/browserDecode.ts:89).

WebP/AVIF export receives pixels already encoded in the selected output space. It chooses Display P3 only for that exact label and otherwise sends those unchanged pixels to an sRGB canvas. Selecting Adobe RGB, ProPhoto RGB, or a linear output therefore changes interpretation without the required conversion. Native PNG/TIFF/JPEG export embeds ICC information and follows a different path.

The original comparison has a related problem: an encoded Display P3 browser decode is quantized unchanged, then returned with `colorSpace: 'srgb'`. P3 HEIC/AVIF/WebP originals can consequently look wrong in Before/After.

**Remedy:** centralize display/export conversion. Preserve Display P3 on the original comparison, convert other supported spaces to the canvas space, or restrict browser export formats to spaces they can correctly represent. Keep native numerical exports separate from display conversion.

### 9. P2 — Session worker errors can leave every pending RPC unresolved

Evidence: [message-only client listener](D:/Projects/DICHROIC/src/session/client.ts:26), [pending requests](D:/Projects/DICHROIC/src/session/client.ts:127), [worker startup](D:/Projects/DICHROIC/src/ui/engine/engine.ts:179).

The Session client listens only for successful message delivery. Worker startup errors, uncaught failures, or message deserialization failures have no path that rejects pending requests. Initialization/open/export can remain pending indefinitely. The depth worker already implements an error listener and cancellation, which offers a useful pattern.

**Remedy:** add worker/port error handling, reject and clear pending requests, expose a failed/retry state, and release listeners on disposal. Handle GPU device loss as a recoverable Session failure rather than only logging it.

### 10. P2 — Automatic deployment is not protected by the reference tests

Evidence: [only deployment workflow](D:/Projects/DICHROIC/.github/workflows/deploy.yml:25).

The workflow runs `npm ci`, lint and build, then deploys. It does not run Vitest. Rendering, codec and fixture regressions can therefore ship even when the checks that justify verified parameters would fail.

**Remedy:** add a dependable test gate before deployment. Separate CPU/codec checks from the serialized Dawn GPU parity job, install/document the Python oracle environment explicitly, and preserve numerical tolerances. Use appropriate test/hook timeouts based on supported hardware rather than treating a clean TypeScript build as numerical validation.

### 11. P2 — The locked development toolchain has known advisories

`npm audit --json` returned six affected packages: one critical, two high and three moderate. They are `vitest`, nested `vite`, `@vitest/mocker`, `vite-node`, `esbuild` and `brace-expansion`. The installed top-level build Vite is 6.4.3; the reported Vite nodes are the older copies nested under Vitest/vite-node.

The critical Vitest advisory concerns its UI/API server and Windows/browser-mode exposure. This repository's test configuration uses ordinary `vitest run` and does not enable that server, so the audit does not demonstrate a remote exploit in the deployed application. See the [maintainer advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp).

**Remedy:** upgrade the test toolchain and affected transitive packages in focused changes, check migration notes, and rerun the serialized GPU suite. Avoid a blanket forced audit fix that silently changes the test harness or acceptance thresholds.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed; Vite 6.4.3, PWA precache 25 entries / 9986.71 KiB |
| Full `npm test -- --reporter=dot` | 66/70 files passed; 2,960 tests passed, 7 failed, 24 skipped; 28m49s |
| Isolated rerun: scanner glare, tiling and Session | All three files passed; 31/31 tests; 1m54s |
| Codec oracle rerun: `test/io/encode.test.ts` | 18/18 passed with access to the existing Python environment |
| Temporary lifecycle/download/TIFF diagnostics | 6/6 passed, reproducing current defective behavior without real downloads or the 2 GiB allocation |
| Dependency audit | Six affected packages: 1 critical, 2 high, 3 moderate |
| Production-only dependency audit | Passed; zero reported vulnerabilities |
| Source import graph | No resolved runtime TypeScript cycles found |

All four files that failed in the initial run passed on isolated reruns. The Session rerun also exercised the 21 tests skipped after its initial setup timeout. No numerical failure remained reproducible in those reruns. The 1,865 fixture-integrity checks make up much of the full-suite count; they should not be mistaken for separate rendering scenarios. The combined verification clears the observed failures, but is not a second uninterrupted full-suite run. No parity tolerance or test timeout was changed.

## Strengths to preserve

- Strict TypeScript configuration, including unchecked-index and unused-code checks.
- Typed worker RPC with error rehydration and explicit typed-array ownership transfer.
- Locked/verified/extension parameter status and tests linking verified fields to checks.
- Upstream-derived fixtures, explicit deterministic/statistical parity gates, and fixture checksums.
- Spatial overlap planning and full-vs-tiled tests instead of relying on visual comparison.
- Precision self-tests and bit-pattern NaN checks for backend compiler differences.
- Codec probing before offering browser export formats; ICC/EXIF support in native export paths.
- Pinned depth-model revision, credential-free model fetching, and a separate persistent depth cache.
- PWA update deferral while editing and explicit hosting/subpath configuration.
- Recorded upstream attribution and a checked import boundary against EMULSION.

## Other improvements and remaining validation

The export UI still says native files have no embedded ICC profile, although the implementation now embeds one. It also describes JPEG as browser-encoded even though JPEG uses the native encoder. The README invokes `npm run preview`, but `package.json` has no preview script. Correct those descriptions so they match shipped behavior.

The modal components move/restore focus, but the inspected implementation lacks focus trapping/background inertness. Add keyboard and assistive-technology checks. The UI's blanket “Parity-verified parameters” label should also acknowledge Camera Raw and Lens fields classified as extensions with JS/property tests.

Large images remain a mobile memory risk despite tiled GPU rendering and strip-based browser decoding: the full Float32 RGBA image is still materialized, and original/guide downscaling runs on the UI thread. Move those CPU preparations into a worker and measure peak memory with representative 24/48-megapixel photos before choosing a device budget.

`host/spectral.ts` is 1,270 lines, and the render-plan/session modules are roughly 700 each. Much of that size is useful historical provenance. Preserve the numerical rationale while moving obsolete phase/task narratives into documentation; extract modules only where resource ownership or validation responsibilities become clearer.

This review did not perform physical iPhone testing, a fresh real-model download/inference, a multi-browser offline/service-worker update test, or a native heap/GPU memory benchmark. Those remain meaningful release checks, particularly for low-memory devices and the ONNX fallback path. The existing handoff also identifies real inference and physical-device validation as outstanding.

## Suggested work order

1. Bound GPU/host caches and release closed-photo resources; gate all depth downloads.
2. Add image-generation guards and transactional opening, then retain regressions for cancellation and failed replacement.
3. Fix RAW destruction, TIFF byte budgets and depth reset cancellation.
4. Correct color conversion and worker failure recovery.
5. Upgrade development dependencies and add CPU/codec/GPU CI gates.
6. Validate real depth inference, high-resolution mobile memory, PWA offline updates and keyboard access.

The numerical pipeline should remain protected by its existing reference tolerances throughout these changes.
