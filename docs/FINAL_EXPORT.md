# Final export rendering

Based on Emulsion's `renderTiled` at commit
[`68579a0`](https://github.com/nathanaellbc/emulsion/blob/68579a0fac2c1c9fdb67dd591468c6f1cc9c389f/web/src/gl/renderer.ts#L1128).

Develop uses a fixed 128 px tile lattice and a working-set target of 192 MiB
on mobile and 640 MiB on desktop. DICHROIC estimates 160 bytes per tile pixel
for its float storage buffers and largest scratch stage, instead of copying
Emulsion's WebGL texture estimate. Spatial aprons can exceed the soft working-set
target, as in Emulsion; storage binding limits are always enforced. Aprons retain
DICHROIC's existing spatial support rather than truncating its blur tails.

The GPU reads back only each tile's core. The worker immediately writes both
8-bit and 16-bit RGB into the final image, then yields before the next tile.
Ordinary sRGB/P3 results retain 9 bytes per output pixel instead of 12 bytes of
float RGB, and no full float output is allocated on the tile export path.
Wide-gamut canvas conversions happen before integer clipping. PNG/TIFF keep
16-bit samples; JPEG uses the independently quantized 8-bit samples. Native
encoders preserve ICC and EXIF.

Format and quality changes reuse the developed pixels. Closing Export releases
the result and cancels active tile work. Changes to the photo or parameters
invalidate active tile work. Scratch and readback allocations are released even
when rendering fails.

This is an adaptation of Emulsion's export scheduling, not a literal renderer
replacement: DICHROIC keeps its spectral film pipeline and existing float render
API. Lens gather and FFT diffusion still require their global grids and use the
existing whole-frame resolution fitting. Their tiling is not ported here.
