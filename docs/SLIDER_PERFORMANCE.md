# Live slider previews

Changing a slider previously discarded every completed render whenever the next
value had already arrived. A continuous drag could therefore leave the photo
unchanged until the gesture stopped. Each render also rebuilt the unchanged
comparison image from the full source photo.

The editor now renders at a maximum long edge of 256 pixels while a slider is
held, including keyboard adjustments. Completed frames are displayed during the
gesture even when a newer value is queued. One render remains in flight, with a
single dirty flag requesting the latest state. Releasing the slider flushes its
last pending value and restores the acquired preview resolution, including zoom
detail. Late draft frames cannot replace the final preview after release.

The source comparison frame is cached for the current photo and resolution.
Changing the photo, rolling back an open, or closing clears it. Slider values do
not invalidate these unchanged pixels. The RPC server copies cached arrays
before transferring them, so the cache retains its buffers.

All film effects remain enabled during the draft. Export rendering is unchanged.
The temporary draft is softer than the final image. The Developing indicator is
suppressed during the gesture and may appear during the final refinement.

## Local measurement, 1 October 2026

Native WebGPU Session benchmark: synthetic 2016 × 1512 encoded sRGB RGBA image,
Kodak Portra 400 and Portra Endura, default spatial effects enabled. Each size
was warmed once; exposure changed for four timed renders. The reported value is
the second fastest of those four samples, rather than a median or FPS estimate.

| Preview long edge | Before comparison cache | After cache | After cache, repeat |
| --- | ---: | ---: | ---: |
| 256 px | 77 ms | 28 ms | 65 ms |
| 384 px | 152 ms | 53 ms | 95 ms |
| 512 px | 152 ms | 66 ms | 105 ms |
| 768 px | 284 ms | 136 ms | 196 ms |
| 1024 px | 457 ms | 289 ms | 368 ms |

The second optimized run overlapped browser verification. Absolute latency is
sensitive to device load. These measurements support the lighter interactive
resolution and comparison cache, but do not establish physical iPhone frame
rates or end-to-end gesture latency.

## Verification

- Session tests cover comparison reuse and invalidation across size, photo,
  close, and reopen.
- Engine tests cover displaying completed frames during a continuing drag,
  rejecting stale frames outside the gesture, restoring zoom detail, undo/redo,
  and preventing frames from resurrecting a closed photo.
- Slider tests cover flushing the final value before refinement, keyboard
  release, and pointer capture loss.
- Mobile-sized browser verification with a 2016 × 1512 PNG: Temperature changed
  from +1 to +53 through a drag; a 256 × 192 draft was observed, then the canvas
  returned to 1280 × 960 and the Developing indicator cleared.
- Production build, TypeScript checking, and lint pass. Physical Safari/iPhone
  gesture performance still needs device verification.
