# DICHROIC fixes and verification

Implemented on 2026-09-30 in response to the whole-project review. The
eleven actionable findings in [PROJECT_ANALYSIS.md](PROJECT_ANALYSIS.md)
have been addressed. This record describes the implementation and local
verification before pushing the changes to GitHub.

## Changes

| Finding | Result |
|---|---|
| Unbounded render resources | Only the current spectral arena is retained; scratch-owning graph variants have a four-entry limit. Filter changes retire previous resources. Closing drains active work before cleanup and retires the Session worker, releasing the LibRaw heap and asset bundle. Failed GPU allocation, encoding and readback paths destroy transient buffers. |
| Depth download before consent | Both runtime and model caches are checked before any binary fetch. Cache eviction cannot cause a download on an unapproved request. Download and offline paths use the same permission policy. |
| Late photo and preview results | Photo preparation runs as a worker transaction, with explicit stage/commit/finish/discard. Generation and parameter revision checks reject obsolete previews, exports and depth results. Cancellation during commit rolls back. |
| Failed replacement hides editor | The existing photo remains active through candidate preparation and is restored after a failed or cancelled replacement. Opening dialogs make background controls inert. |
| RAW native ownership | Every Embind LibRaw instance is deleted in `finally`, including failures. Pixel data is copied into the owned output before deletion. Closing the photo also retires the retained WASM heap. |
| Unsafe image allocations | Shared dimension/budget checks cover TIFF, PNG, EXR, JPEG, RAW, browser decoding and Session admission. TIFF validates blocks before allocation and normalizes directly into final RGBA, eliminating its full Float64 sample copy. Deflate strips, PNG pixel expansion and compressed ICC metadata are bounded. Unneeded compressed PNG metadata/animation chunks are excluded from pixel decoding. |
| Abandoned depth inference | Reset/close cancels the estimator worker. Inputs and output tensors are disposed in success and failure paths. Failed GPU sessions are released before CPU fallback. |
| Misinterpreted color | Shared conversion handles encoded and linear source spaces, transfer curves and white adaptation. Original/guide preparation moved into the worker. Canvas previews and browser exports convert to their actual sRGB/Display P3 encoding; native exports retain the corresponding ICC profile. Render results carry the color-space label captured for that render. |
| Worker/RPC hangs | Worker errors, message errors and GPU loss reject pending calls and retire the failed worker. A later open can retry initialization. Startup and retirement checks prevent obsolete initialization from changing current UI state. |
| Missing CI gates | Pull requests and deployments now require type checking, lint, dependency audit, CPU/codec/fixture checks, serialized GPU parity and a production build. Codec oracles are explicitly installed and validated. WARP is selected for the Windows GPU job. |
| Toolchain advisories | Vitest upgraded to 4.1.11 and affected transitive dependencies refreshed. The dependency audit reports zero advisories. |

Additional corrections include the missing preview command, accurate JPEG
and ICC export descriptions, a qualified film-parity label, modal focus
trapping/background inertness, and regression coverage for optimistic edit
rollback and PWA update/isolation deferral. Timing allowances account for
cold asset and shader setup; numerical parity thresholds were not changed.

## Memory policy

The common decoded-image allocation budget is 512 MiB, with conservative
per-format bytes-per-pixel estimates for intermediate buffers. Compressed
TIFF blocks are limited to 64 MiB and PNG ICC metadata to 4 MiB. Candidate
and current Float32 source images must fit the combined replacement budget.
Large unsupported images fail with a smaller-photo message before the
guarded allocations occur.

These are allocation guards, not a measured ceiling on browser/GPU/native
memory. PNG pixel preflight adds a bounded decompression pass. Reopening
after close has cold worker initialization cost in exchange for releasing
the retained heap. Full-resolution 24/48-megapixel processing and peak
memory on physical mobile devices have not been certified.

## Verification before integrating remote main

| Check | Result |
|---|---|
| Full regression run | 78 files passed; 3,028 tests passed, three existing skips; 16m27s. |
| CPU group after subsequent refinements | 43 files passed; 2,346 tests passed, three skips. |
| Final lifecycle/TIFF/resource regressions | 54 tests passed across three files. |
| Final depth fallback and lifecycle regressions | 17 tests passed across two files, including GPU release failure and stale export cancellation. |
| PNG, metadata, allocation, lifecycle and PWA regressions | 59 tests passed across five files. |
| WARP device/Session/film-exposure checks | 34 tests passed across three files on Microsoft Basic Render Driver. |
| Browser CPU depth | Fresh Chrome profile: no model/runtime binary download before approval, actual model download and inference, clean error log. |
| Production PWA | Offline reload and local photo rendering passed; cached CPU depth inference passed offline; photo close/reopen passed. |
| PWA update behavior | Tests verify update deferral until no photo is open and prevent isolation reload during editing. |
| Browser WebGPU depth | Fresh desktop Chrome profile: actual GPU inference, cached GPU inference offline, offline photo rendering and close/reopen passed. |
| Type checking, lint and production build | Passed; PWA precache contains 25 entries, approximately 9.77 MiB. |
| Dependency audit | Zero reported advisories across production and development dependencies. |

The GPU browser run emitted four native ONNX W-level provider-assignment
notices because shape operations use CPU. Emscripten sends these notices
through `console.error`; the smoke script records this exact warning class
separately and continues to fail on other error messages and page exceptions.
GPU-session release failure is also covered: it cannot prevent CPU fallback
or authorize uncached network downloads.

The full run preceded the last PNG/startup/export refinements; those changes
were covered by the subsequent targeted and CPU runs. The three skips are
the reverse licence-boundary check whose sibling project is absent, and two
locked-parameter tests conditional on there being locked fields in the current
registry. They are not numerical parity failures. Codec checks used the
existing Python oracle environment with NumPy 2.5.3, Pillow 12.3.0,
tifffile 2026.9.9 and OpenImageIO 3.1.17.0; CI pins those versions.

Raw JSON results and a browser screenshot are available in the ignored
`artifacts/` directory. Chrome used a temporary profile. CPU selection used
an emulated iPhone user agent, which does not validate physical Safari or
iPhone hardware. The new hosted CI workflow has not been executed remotely.
Physical iPhone, other browser engines, native/GPU peak-memory measurements
and a full WARP parity run remain release validation limits.

## Integration with remote main

Before publishing, six newer commits through `a7d661f` were fetched and
merged. Their Mac/iPhone redesign, photo zoom/pan, undo/redo, export cleanup,
shared GPU scratch pool and lens improvements were retained. Conflict
resolution combines those features with the transaction, color, allocation
and worker-lifetime fixes above. Export-dialog cleanup now waits for an
active render to finish before releasing shared scratch; stale full results
cannot refill its cache. Opening dialogs also block editor shortcuts.

The integrated tree passed type checking, lint, production build and audit
(zero advisories). The build precaches 32 entries / 10,253.34 KiB including
the new font. Post-merge validation passed 42 UI/RPC/resource tests, 42 native
graph/Session/lens tests, and 11 grain/scanner-glare/diffusion parity tests.
The new undo/redo and deferred shared-scratch cleanup have regression tests.
The build emits the existing browser-externalized Node import diagnostic and
a size notice for the approximately 502 kB main JavaScript bundle.

A fresh-profile browser run on the integrated UI also passed startup, photo
preparation, failed replacement/focus containment, consent before binary
downloads, actual GPU depth inference, worker retirement and photo reopening,
offline PWA reload/rendering, and cached depth inference offline. No browser
failures were recorded; four native provider-assignment warnings were recorded
separately as described above.
